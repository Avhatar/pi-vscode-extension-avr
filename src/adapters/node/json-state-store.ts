import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StateStore } from '../../core/ports/chat-platform';

interface PersistedStateFile {
    version: 1;
    values: Record<string, unknown>;
}

let temporaryFileCounter = 0;

/** Versioned JSON-backed state with synchronous reads and serialized atomic writes. */
export class JsonStateStore implements StateStore {
    private _writeQueue: Promise<void> = Promise.resolve();

    private constructor(
        readonly filePath: string,
        private _values: Map<string, unknown>,
    ) {}

    static async open(filePath: string): Promise<JsonStateStore> {
        const absolutePath = path.resolve(filePath);
        let raw: string;
        try {
            raw = await fs.readFile(absolutePath, 'utf8');
        } catch (error) {
            if (isMissingFileError(error)) {
                return new JsonStateStore(absolutePath, new Map());
            }
            throw new Error(`Could not read state file: ${absolutePath}`, { cause: error });
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(`Could not read state file: ${absolutePath}`, { cause: error });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Could not read state file: ${absolutePath}`);
        }
        const candidate = parsed as Partial<PersistedStateFile>;
        if (candidate.version !== 1) {
            throw new Error(`Unsupported state file version: ${String(candidate.version)}`);
        }
        if (!candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) {
            throw new Error(`Could not read state file: ${absolutePath}`);
        }
        return new JsonStateStore(absolutePath, new Map(Object.entries(candidate.values)));
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, fallback: T): T;
    get<T>(key: string, fallback?: T): T | undefined {
        return (this._values.has(key) ? this._values.get(key) : fallback) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        const nextValues = new Map(this._values);
        if (value === undefined) nextValues.delete(key);
        else nextValues.set(key, value);
        const serialized = serializeState(nextValues);
        this._values = nextValues;

        const write = () => this._writeAtomically(serialized);
        const pending = this._writeQueue.then(write, write);
        this._writeQueue = pending;
        return pending;
    }

    flush(): Promise<void> {
        return this._writeQueue;
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

function serializeState(values: ReadonlyMap<string, unknown>): string {
    const file: PersistedStateFile = {
        version: 1,
        values: Object.fromEntries(values),
    };
    return `${JSON.stringify(file, undefined, 2)}\n`;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
