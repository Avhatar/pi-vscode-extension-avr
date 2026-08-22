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

const LOCK_SCHEMA_VERSION = 2;
const SUPPORTED_LOCK_VERSIONS = new Set([1, LOCK_SCHEMA_VERSION]);
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
/**
 * Boot instants are derived from `Date.now() - os.uptime()`, so small clock
 * adjustments must not read as a reboot. Real reboots move the instant by the
 * previous uptime plus the downtime, which dwarfs this window.
 */
const BOOT_TIME_TOLERANCE_MS = 10_000;
const UNIDENTIFIED_OWNER_CLAIM = 'unidentified-owner';

interface PersistedSessionLock {
    readonly version: number;
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
    readonly bootTimeMs?: () => number | undefined;
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
    private readonly _bootTimeMs: () => number | undefined;
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
        this._bootTimeMs = options.bootTimeMs ?? defaultBootTimeMs;
        this._ownerIdFactory = options.ownerIdFactory ?? randomUUID;
    }

    async acquire(sessionPath: string): Promise<SessionLockHandle> {
        const canonicalSessionPath = await canonicalizeSessionPath(sessionPath);
        const lockPath = getSessionLockPath(canonicalSessionPath);
        const bootTimeMs = this._bootTimeMs();
        const owner: SessionLockOwner = {
            ownerId: this._ownerIdFactory(),
            applicationId: this._applicationId,
            processId: this._processId,
            hostname: this._hostname,
            acquiredAt: this._now(),
            ...(bootTimeMs !== undefined ? { bootTimeMs } : {}),
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
        expectedOwnerId: string | undefined,
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
            // An unreadable lock has no owner id; recovery then requires that it is
            // still unreadable, so a fresh owner cannot be evicted by a stale verdict.
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
            // A torn write from a power loss, or a schema this build cannot read.
            // The sidecar mtime is the only age signal left; without this fallback
            // an unparseable lock would block its session permanently.
            const sidecarAgeMs = await this._readSidecarAgeMs(lockPath);
            return {
                sessionPath,
                lockPath,
                owner: undefined,
                ownerLiveness: 'unknown',
                ageMs: sidecarAgeMs,
                staleRecoveryAllowed: sidecarAgeMs === undefined
                    || sidecarAgeMs >= this._staleAfterMs,
            };
        }
        const owner = persisted.owner;
        const ageMs = Math.max(0, this._now() - owner.acquiredAt);
        const sameHost = owner.hostname === this._hostname;
        const ownerBootMismatch = sameHost && this._isBootMismatch(owner);
        const ownerLiveness = this._ownerLiveness(owner, ownerBootMismatch);
        return {
            sessionPath,
            lockPath,
            owner,
            ownerLiveness,
            ageMs,
            ownerBootMismatch,
            staleRecoveryAllowed: this._isStaleRecoveryAllowed(sameHost, ownerLiveness, ageMs),
        };
    }

    /**
     * A lock is reclaimable only when its owner is provably gone. A dead process
     * id on this host cannot come back — the same host restarting the session gets
     * a new lock — so no waiting period applies. Ambiguous verdicts still wait out
     * the stale threshold, and another host's liveness is never guessed.
     */
    private _isStaleRecoveryAllowed(
        sameHost: boolean,
        ownerLiveness: SessionLockOwnerLiveness,
        ageMs: number,
    ): boolean {
        if (!sameHost) return false;
        if (ownerLiveness === 'dead') return true;
        if (ownerLiveness === 'alive') return false;
        return ageMs >= this._staleAfterMs;
    }

    private async _readSidecarAgeMs(lockPath: string): Promise<number | undefined> {
        try {
            const stats = await fs.stat(lockPath);
            return Math.max(0, this._now() - stats.mtimeMs);
        } catch (error) {
            // A vanished sidecar means nobody owns the session any more.
            if (isMissingFileError(error)) return undefined;
            throw error;
        }
    }

    /** True when the lock was taken before the machine last booted. */
    private _isBootMismatch(owner: SessionLockOwner): boolean {
        const currentBootTimeMs = this._bootTimeMs();
        if (currentBootTimeMs === undefined || owner.bootTimeMs === undefined) return false;
        return Math.abs(currentBootTimeMs - owner.bootTimeMs) > BOOT_TIME_TOLERANCE_MS;
    }

    private _ownerLiveness(
        owner: SessionLockOwner,
        ownerBootMismatch: boolean,
    ): SessionLockOwnerLiveness {
        if (owner.hostname !== this._hostname) return 'unknown';
        // The recorded process id may have been recycled by an unrelated process
        // after a reboot, so a pre-boot lock outranks any liveness probe.
        if (ownerBootMismatch) return 'dead';
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

function getRecoveryClaimPath(lockPath: string, expectedOwnerId: string | undefined): string {
    const ownerHash = createHash('sha256')
        .update(expectedOwnerId ?? UNIDENTIFIED_OWNER_CLAIM)
        .digest('hex');
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
    if (typeof candidate.version !== 'number'
        || !SUPPORTED_LOCK_VERSIONS.has(candidate.version)
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
        && Number.isFinite(owner.acquiredAt)
        && (owner.bootTimeMs === undefined
            || (typeof owner.bootTimeMs === 'number' && Number.isFinite(owner.bootTimeMs)));
}

/**
 * Epoch instant the OS booted. `os.uptime()` counts suspended time on Windows,
 * Linux, and macOS, so sleep/resume cycles keep this value stable while a reboot
 * moves it far beyond {@link BOOT_TIME_TOLERANCE_MS}.
 */
function defaultBootTimeMs(): number | undefined {
    const uptimeSeconds = os.uptime();
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return undefined;
    return Math.round(Date.now() - uptimeSeconds * 1000);
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
