import { describe, expect, it, vi } from 'vitest';
import { acquireSessionLock } from '../../../../core/session/session-lock-recovery';
import {
    SessionLockConflictError,
    type SessionLockConflict,
    type SessionLockHandle,
    type SessionLockPort,
} from '../../../../core/ports/session-platform';

describe('acquireSessionLock', () => {
    it('returns the handle when the session is free', async () => {
        const handle = createHandle();
        const locks: SessionLockPort = {
            acquire: vi.fn(async () => handle),
            recoverStale: vi.fn(),
        };

        expect(await acquireSessionLock(locks, 'X:/sessions/free.jsonl')).toBe(handle);
        expect(locks.recoverStale).not.toHaveBeenCalled();
    });

    it('reclaims an abandoned lock and logs why', async () => {
        const handle = createHandle();
        const conflict = createConflict({
            ownerLiveness: 'dead',
            staleRecoveryAllowed: true,
        });
        const locks: SessionLockPort = {
            acquire: vi.fn(async () => { throw new SessionLockConflictError(conflict); }),
            recoverStale: vi.fn(async () => handle),
        };
        const log = vi.fn();

        expect(await acquireSessionLock(locks, 'X:/sessions/crashed.jsonl', log)).toBe(handle);
        expect(locks.recoverStale).toHaveBeenCalledWith('X:/sessions/crashed.jsonl', 'gone-owner');
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0][0]).toContain('X:/sessions/crashed.jsonl.pi-code.lock');
        expect(log.mock.calls[0][0]).toContain('no longer running');
    });

    it('reclaims an unreadable lock without an owner id', async () => {
        const handle = createHandle();
        const conflict = createConflict({
            owner: undefined,
            ownerLiveness: 'unknown',
            staleRecoveryAllowed: true,
        });
        const locks: SessionLockPort = {
            acquire: vi.fn(async () => { throw new SessionLockConflictError(conflict); }),
            recoverStale: vi.fn(async () => handle),
        };

        expect(await acquireSessionLock(locks, 'X:/sessions/torn.jsonl')).toBe(handle);
        expect(locks.recoverStale).toHaveBeenCalledWith('X:/sessions/torn.jsonl', undefined);
    });

    it('never takes a session away from a live owner', async () => {
        const conflict = createConflict({ ownerLiveness: 'alive', staleRecoveryAllowed: false });
        const locks: SessionLockPort = {
            acquire: vi.fn(async () => { throw new SessionLockConflictError(conflict); }),
            recoverStale: vi.fn(),
        };

        await expect(acquireSessionLock(locks, 'X:/sessions/busy.jsonl'))
            .rejects.toThrow('Close that chat tab or Pi Code instance');
        expect(locks.recoverStale).not.toHaveBeenCalled();
    });

    it('surfaces a recovery that lost its race instead of retrying forever', async () => {
        const conflict = createConflict({
            ownerLiveness: 'dead',
            staleRecoveryAllowed: true,
        });
        const locks: SessionLockPort = {
            acquire: vi.fn(async () => { throw new SessionLockConflictError(conflict); }),
            recoverStale: vi.fn(async () => {
                throw new SessionLockConflictError(createConflict({
                    ownerLiveness: 'alive',
                    staleRecoveryAllowed: false,
                }));
            }),
        };

        await expect(acquireSessionLock(locks, 'X:/sessions/raced.jsonl'))
            .rejects.toBeInstanceOf(SessionLockConflictError);
        expect(locks.acquire).toHaveBeenCalledOnce();
        expect(locks.recoverStale).toHaveBeenCalledOnce();
    });

    it('propagates non-conflict failures untouched', async () => {
        const locks: SessionLockPort = {
            acquire: vi.fn(async () => { throw new Error('EACCES'); }),
            recoverStale: vi.fn(),
        };

        await expect(acquireSessionLock(locks, 'X:/sessions/denied.jsonl')).rejects.toThrow('EACCES');
        expect(locks.recoverStale).not.toHaveBeenCalled();
    });
});

function createConflict(overrides: Partial<SessionLockConflict>): SessionLockConflict {
    return {
        sessionPath: 'X:/sessions/crashed.jsonl',
        lockPath: 'X:/sessions/crashed.jsonl.pi-code.lock',
        owner: {
            ownerId: 'gone-owner',
            applicationId: 'pi-code-vscode',
            processId: 32152,
            hostname: 'OGPC164',
            acquiredAt: 0,
            bootTimeMs: 1,
        },
        ownerLiveness: 'dead',
        ageMs: 0,
        staleRecoveryAllowed: true,
        ...overrides,
    };
}

function createHandle(): SessionLockHandle {
    return {
        sessionPath: 'X:/sessions/crashed.jsonl',
        owner: {
            ownerId: 'new-owner',
            applicationId: 'pi-code-vscode',
            processId: 1,
            hostname: 'OGPC164',
            acquiredAt: 0,
        },
        release: async () => undefined,
    };
}
