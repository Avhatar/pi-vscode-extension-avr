import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
    SessionLockConflictError,
    type SessionLockConflict,
    type SessionLockHandle,
    type SessionLockOwner,
    type SessionLockOwnerLiveness,
    type SessionLockPort,
} from '../../core/ports/session-platform';

const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

interface PersistedSessionLock {
    readonly version: typeof LOCK_SCHEMA_VERSION;
    readonly owner: SessionLockOwner;
}

export interface NodeSessionLockOptions {
    readonly applicationId: string;
    readonly processId?: number;
    readonly hostname?: string;
    readonly staleAfterMs?: number;
    readonly now?: () => number;
    readonly isProcessAlive?: (
        processId: number,
    ) => boolean | SessionLockOwnerLiveness;
    readonly ownerIdFactory?: () => string;
}

/** Exclusive sidecar-file lock shared by the VS Code and desktop Node hosts. */
export class NodeSessionLock implements SessionLockPort {
    private readonly _applicationId: string;
    private readonly _processId: number;
    private readonly _hostname: string;
    private readonly _staleAfterMs: number;
    private readonly _now: () => number;
    private readonly _isProcessAlive: (
        processId: number,
    ) => boolean | SessionLockOwnerLiveness;
    private readonly _ownerIdFactory: () => string;

    constructor(options: NodeSessionLockOptions) {
        if (!options.applicationId.trim()) {
            throw new Error('Session lock applicationId is required.');
        }
        this._applicationId = options.applicationId;
        this._processId = options.processId ?? process.pid;
        this._hostname = options.hostname ?? os.hostname();
        this._staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
        this._now = options.now ?? Date.now;
        this._isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness;
        this._ownerIdFactory = options.ownerIdFactory ?? randomUUID;
    }

    async acquire(sessionPath: string): Promise<SessionLockHandle> {
        const canonicalSessionPath = await canonicalizeSessionPath(sessionPath);
        const lockPath = getSessionLockPath(canonicalSessionPath);
        const owner: SessionLockOwner = {
            ownerId: this._ownerIdFactory(),
            applicationId: this._applicationId,
            processId: this._processId,
            hostname: this._hostname,
            acquiredAt: this._now(),
        };
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(lockPath, 'wx', 0o600);
            const payload: PersistedSessionLock = { version: LOCK_SCHEMA_VERSION, owner };
            await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
            await handle.sync();
        } catch (error) {
            if (isAlreadyExistsError(error)) {
                throw new SessionLockConflictError(
                    await this._readConflict(canonicalSessionPath, lockPath),
                );
            }
            if (handle) {
                await handle.close().catch(() => undefined);
                await fs.unlink(lockPath).catch(() => undefined);
            }
            throw error;
        }
        try {
            await handle.close();
        } catch (error) {
            await fs.unlink(lockPath).catch(() => undefined);
            throw error;
        }
        let released = false;
        return {
            sessionPath: canonicalSessionPath,
            owner,
            release: async () => {
                if (released) return;
                released = true;
                const current = await readPersistedLock(lockPath);
                if (current?.owner.ownerId !== owner.ownerId) return;
                try {
                    await fs.unlink(lockPath);
                } catch (error) {
                    if (!isMissingFileError(error)) throw error;
                }
            },
        };
    }

    async recoverStale(
        sessionPath: string,
        expectedOwnerId: string,
    ): Promise<SessionLockHandle> {
        const canonicalSessionPath = await canonicalizeSessionPath(sessionPath);
        const lockPath = getSessionLockPath(canonicalSessionPath);
        const recoveryPath = getRecoveryClaimPath(lockPath, expectedOwnerId);
        let recoveryClaim: fs.FileHandle;
        try {
            recoveryClaim = await fs.open(recoveryPath, 'wx', 0o600);
        } catch (error) {
            if (isAlreadyExistsError(error)) {
                throw new SessionLockConflictError(
                    await this._readConflict(canonicalSessionPath, lockPath),
                );
            }
            throw error;
        }

        try {
            const current = await this._readConflict(canonicalSessionPath, lockPath);
            if (!current.staleRecoveryAllowed
                || current.owner?.ownerId !== expectedOwnerId) {
                throw new SessionLockConflictError(current);
            }
            try {
                await fs.unlink(lockPath);
            } catch (error) {
                if (!isMissingFileError(error)) throw error;
            }
            return await this.acquire(canonicalSessionPath);
        } finally {
            await recoveryClaim.close().catch(() => undefined);
            await fs.unlink(recoveryPath).catch(() => undefined);
        }
    }

    private async _readConflict(
        sessionPath: string,
        lockPath: string,
    ): Promise<SessionLockConflict> {
        const persisted = await readPersistedLock(lockPath);
        if (!persisted) {
            return {
                sessionPath,
                lockPath,
                owner: undefined,
                ownerLiveness: 'unknown',
                ageMs: undefined,
                staleRecoveryAllowed: false,
            };
        }
        const owner = persisted.owner;
        const ageMs = Math.max(0, this._now() - owner.acquiredAt);
        const ownerLiveness = this._ownerLiveness(owner);
        return {
            sessionPath,
            lockPath,
            owner,
            ownerLiveness,
            ageMs,
            staleRecoveryAllowed: ownerLiveness === 'dead' && ageMs >= this._staleAfterMs,
        };
    }

    private _ownerLiveness(owner: SessionLockOwner): SessionLockOwnerLiveness {
        if (owner.hostname !== this._hostname) return 'unknown';
        try {
            const result = this._isProcessAlive(owner.processId);
            if (result === true) return 'alive';
            if (result === false) return 'dead';
            return result;
        } catch {
            return 'unknown';
        }
    }
}

export function getSessionLockPath(sessionPath: string): string {
    return `${sessionPath}.pi-code.lock`;
}

function getRecoveryClaimPath(lockPath: string, expectedOwnerId: string): string {
    const ownerHash = createHash('sha256').update(expectedOwnerId).digest('hex');
    return `${lockPath}.recover-${ownerHash}`;
}

async function canonicalizeSessionPath(sessionPath: string): Promise<string> {
    if (!sessionPath.trim()) throw new Error('Session path is required for locking.');
    const absolute = path.resolve(sessionPath);
    try {
        return await fs.realpath(absolute);
    } catch (error) {
        if (!isMissingFileError(error)) throw error;
        const parent = await fs.realpath(path.dirname(absolute));
        return path.join(parent, path.basename(absolute));
    }
}

async function readPersistedLock(lockPath: string): Promise<PersistedSessionLock | undefined> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (!isPersistedSessionLock(parsed)) return undefined;
        return parsed;
    } catch (error) {
        if (isMissingFileError(error) || error instanceof SyntaxError) return undefined;
        throw error;
    }
}

function isPersistedSessionLock(value: unknown): value is PersistedSessionLock {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== LOCK_SCHEMA_VERSION
        || !candidate.owner
        || typeof candidate.owner !== 'object'
        || Array.isArray(candidate.owner)) return false;
    const owner = candidate.owner as Record<string, unknown>;
    return typeof owner.ownerId === 'string'
        && owner.ownerId.length > 0
        && typeof owner.applicationId === 'string'
        && owner.applicationId.length > 0
        && typeof owner.processId === 'number'
        && Number.isInteger(owner.processId)
        && owner.processId > 0
        && typeof owner.hostname === 'string'
        && typeof owner.acquiredAt === 'number'
        && Number.isFinite(owner.acquiredAt);
}

function defaultProcessLiveness(processId: number): SessionLockOwnerLiveness {
    try {
        process.kill(processId, 0);
        return 'alive';
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ESRCH') return 'dead';
        if (code === 'EPERM') return 'alive';
        return 'unknown';
    }
}

function isAlreadyExistsError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
