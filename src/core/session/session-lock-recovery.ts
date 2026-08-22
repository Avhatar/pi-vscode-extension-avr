import {
    SessionLockConflictError,
    describeSessionLockConflict,
    type SessionLockHandle,
    type SessionLockPort,
} from '../ports/session-platform';

/**
 * Acquires a writable-session lock, reclaiming it once when the previous owner is
 * provably gone — a crashed process, a lock left behind by a power loss, or an
 * unreadable sidecar older than the stale threshold. A conflict with a live owner
 * still fails: silently taking a session away from a running host risks data loss.
 *
 * Recovery is attempted at most once, so a lock that keeps changing hands under us
 * surfaces the conflict instead of spinning.
 */
export async function acquireSessionLock(
    locks: SessionLockPort,
    sessionPath: string,
    log?: (message: string) => void,
): Promise<SessionLockHandle> {
    try {
        return await locks.acquire(sessionPath);
    } catch (error) {
        if (!(error instanceof SessionLockConflictError)) throw error;
        const conflict = error.conflict;
        if (!conflict.staleRecoveryAllowed) throw error;
        log?.(`Reclaiming abandoned session lock ${conflict.lockPath}: `
            + describeSessionLockConflict(conflict));
        return await locks.recoverStale(sessionPath, conflict.owner?.ownerId);
    }
}
