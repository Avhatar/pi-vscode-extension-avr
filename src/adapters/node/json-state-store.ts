import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StateStore } from '../../core/ports/chat-platform';
import {
    SessionLockConflictError,
    type SessionLockHandle,
    type SessionLockPort,
} from '../../core/ports/session-platform';

interface PersistedStateFile {
    version: 1;
    values: Record<string, unknown>;
}

export interface JsonStateStoreOptions {
    readonly lock?: SessionLockPort;
    readonly lockTimeoutMs?: number;
    readonly retryDelayMs?: number;
    readonly now?: () => number;
    readonly wait?: (delayMs: number) => Promise<void>;
}

let temporaryFileCounter = 0;

/** Versioned JSON-backed state with synchronous reads and serialized atomic writes. */
export class JsonStateStore implements StateStore {
    private _writeQueue: Promise<void> = Promise.resolve();
    private readonly _pendingMutations: Array<{
        readonly id: number;
        readonly key: string;
        readonly value: unknown;
    }> = [];
    private _mutationCounter = 0;
    private _values: Map<string, unknown>;

    private constructor(
        readonly filePath: string,
        private _committedValues: Map<string, unknown>,
        private readonly _options: JsonStateStoreOptions,
    ) {
        this._values = new Map(_committedValues);
    }

    static async open(
        filePath: string,
        options: JsonStateStoreOptions = {},
    ): Promise<JsonStateStore> {
        const absolutePath = path.resolve(filePath);
        return new JsonStateStore(
            absolutePath,
            await readStateValues(absolutePath),
            options,
        );
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, fallback: T): T;
    get<T>(key: string, fallback?: T): T | undefined {
        return (this._values.has(key) ? this._values.get(key) : fallback) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        const nextValues = applyMutation(this._values, key, value);
        serializeState(nextValues);
        const mutation = { id: ++this._mutationCounter, key, value };
        this._pendingMutations.push(mutation);
        this._values = nextValues;

        const write = async (): Promise<void> => {
            try {
                this._committedValues = this._options.lock
                    ? await this._writeMergedWithLock(key, value)
                    : await this._writeMutationWithoutLock(key, value);
            } finally {
                const index = this._pendingMutations.findIndex(({ id }) => id === mutation.id);
                if (index >= 0) this._pendingMutations.splice(index, 1);
                this._rebuildVisibleValues();
            }
        };
        const pending = this._writeQueue.then(write, write);
        this._writeQueue = pending;
        return pending;
    }

    flush(): Promise<void> {
        return this._writeQueue;
    }

    private async _writeMutationWithoutLock(
        key: string,
        value: unknown,
    ): Promise<Map<string, unknown>> {
        const committed = applyMutation(this._committedValues, key, value);
        await this._writeAtomically(serializeState(committed));
        return committed;
    }

    private async _writeMergedWithLock(
        key: string,
        value: unknown,
    ): Promise<Map<string, unknown>> {
        const lock = this._options.lock;
        if (!lock) throw new Error('State lock is unavailable.');
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const handle = await acquireStateLock(this.filePath, lock, this._options);
        try {
            const diskValues = await readStateValues(this.filePath);
            const committed = applyMutation(diskValues, key, value);
            await this._writeAtomically(serializeState(committed));
            return committed;
        } finally {
            await handle.release();
        }
    }

    private _rebuildVisibleValues(): void {
        let visible = new Map(this._committedValues);
        for (const mutation of this._pendingMutations) {
            visible = applyMutation(visible, mutation.key, mutation.value);
        }
        this._values = visible;
    }

    private async _writeAtomically(serialized: string): Promise<void> {
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true });
        const temporaryPath = path.join(
            directory,
            `.${path.basename(this.filePath)}.${process.pid}.${++temporaryFileCounter}.tmp`,
        );
        try {
            await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
            await fs.rename(temporaryPath, this.filePath);
        } finally {
            await fs.rm(temporaryPath, { force: true });
        }
    }
}

async function acquireStateLock(
    filePath: string,
    lock: SessionLockPort,
    options: JsonStateStoreOptions,
): Promise<SessionLockHandle> {
    const now = options.now ?? Date.now;
    const wait = options.wait ?? delay;
    const timeoutMs = Math.max(0, options.lockTimeoutMs ?? 5_000);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 25);
    const deadline = now() + timeoutMs;

    while (true) {
        try {
            return await lock.acquire(filePath);
        } catch (error) {
            if (!(error instanceof SessionLockConflictError)) throw error;
            const owner = error.conflict.owner;
            if (owner && error.conflict.staleRecoveryAllowed) {
                try {
                    return await lock.recoverStale(filePath, owner.ownerId);
                } catch (recoveryError) {
                    if (!(recoveryError instanceof SessionLockConflictError)) throw recoveryError;
                }
            }
            if (now() >= deadline) {
                throw new Error(`Timed out waiting for state lock: ${filePath}`, { cause: error });
            }
            await wait(Math.min(retryDelayMs, Math.max(0, deadline - now())));
        }
    }
}

async function readStateValues(filePath: string): Promise<Map<string, unknown>> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (isMissingFileError(error)) return new Map();
        throw new Error(`Could not read state file: ${filePath}`, { cause: error });
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Could not read state file: ${filePath}`, { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Could not read state file: ${filePath}`);
    }
    const candidate = parsed as Partial<PersistedStateFile>;
    if (candidate.version !== 1) {
        throw new Error(`Unsupported state file version: ${String(candidate.version)}`);
    }
    if (!candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) {
        throw new Error(`Could not read state file: ${filePath}`);
    }
    return new Map(Object.entries(candidate.values));
}

function applyMutation(
    values: ReadonlyMap<string, unknown>,
    key: string,
    value: unknown,
): Map<string, unknown> {
    const nextValues = new Map(values);
    if (value === undefined) nextValues.delete(key);
    else nextValues.set(key, value);
    return nextValues;
}

function serializeState(values: ReadonlyMap<string, unknown>): string {
    const file: PersistedStateFile = {
        version: 1,
        values: Object.fromEntries(values),
    };
    return `${JSON.stringify(file, undefined, 2)}\n`;
}

function delay(delayMs: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
