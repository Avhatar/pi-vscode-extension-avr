import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    NodeSessionLock,
    getSessionLockPath,
} from '../../../../adapters/node/session-lock';
import { SessionLockConflictError } from '../../../../core/ports/session-platform';
import { acquireSessionLock } from '../../../../core/session/session-lock-recovery';

const temporaryDirectories: string[] = [];

async function createSessionPath(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-session-lock-'));
    temporaryDirectories.push(directory);
    const sessionPath = path.join(directory, 'session.jsonl');
    await fs.writeFile(sessionPath, '{}\n', 'utf8');
    return sessionPath;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })));
});

describe('NodeSessionLock', () => {
    it('blocks a second live writer and permits it after normal release', async () => {
        const sessionPath = await createSessionPath();
        const first = createLockService('first', 101, () => true);
        const second = createLockService('second', 202, () => true);
        const firstHandle = await first.acquire(sessionPath);

        const conflict = await captureConflict(second.acquire(sessionPath));
        expect(conflict).toMatchObject({
            sessionPath: await fs.realpath(sessionPath),
            lockPath: getSessionLockPath(await fs.realpath(sessionPath)),
            owner: {
                ownerId: 'first-owner',
                applicationId: 'first',
                processId: 101,
                hostname: 'test-host',
                bootTimeMs: 500_000,
            },
            ownerLiveness: 'alive',
            ownerBootMismatch: false,
            staleRecoveryAllowed: false,
        });

        await firstHandle.release();
        const secondHandle = await second.acquire(sessionPath);
        await secondHandle.release();
        await expect(fs.stat(getSessionLockPath(await fs.realpath(sessionPath))))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('never treats an old live owner as recoverable', async () => {
        const sessionPath = await createSessionPath();
        let now = 1_000;
        const owner = createLockService('owner', 101, () => true, () => now);
        const contender = createLockService('contender', 202, () => true, () => now);
        const handle = await owner.acquire(sessionPath);
        now += 60_000;

        const conflict = await captureConflict(contender.acquire(sessionPath));
        expect(conflict.ageMs).toBe(60_000);
        expect(conflict.ownerLiveness).toBe('alive');
        expect(conflict.staleRecoveryAllowed).toBe(false);
        await expect(contender.recoverStale(sessionPath, 'owner-owner'))
            .rejects.toBeInstanceOf(SessionLockConflictError);

        await handle.release();
    });

    it('recovers a crashed owner immediately without waiting out the stale threshold', async () => {
        const sessionPath = await createSessionPath();
        const now = 10_000;
        const owner = createLockService('owner', 101, () => false, () => now);
        const contender = createLockService('contender', 202, () => false, () => now);
        const abandonedHandle = await owner.acquire(sessionPath);

        const conflict = await captureConflict(contender.acquire(sessionPath));
        expect(conflict.ageMs).toBe(0);
        expect(conflict.ownerLiveness).toBe('dead');
        expect(conflict.staleRecoveryAllowed).toBe(true);
        expect(conflict.owner?.ownerId).toBe('owner-owner');

        await expect(contender.acquire(sessionPath)).rejects.toBeInstanceOf(SessionLockConflictError);
        await expect(contender.recoverStale(sessionPath, 'wrong-owner'))
            .rejects.toBeInstanceOf(SessionLockConflictError);

        const recovered = await contender.recoverStale(sessionPath, 'owner-owner');
        await abandonedHandle.release();
        expect(await fs.stat(getSessionLockPath(await fs.realpath(sessionPath))))
            .toBeDefined();
        await recovered.release();
    });

    it('recovers a lock left behind by a power loss even when its pid was reused', async () => {
        const sessionPath = await createSessionPath();
        const beforeReboot = createLockService('owner', 101, () => true, () => 10_000, () => 500_000);
        await beforeReboot.acquire(sessionPath);

        // The machine rebooted: the recorded pid now belongs to an unrelated live
        // process, so only the boot instant can prove the owner is gone.
        const afterReboot = createLockService('owner', 202, () => true, () => 900_000, () => 800_000);
        const conflict = await captureConflict(afterReboot.acquire(sessionPath));
        expect(conflict.ownerBootMismatch).toBe(true);
        expect(conflict.ownerLiveness).toBe('dead');
        expect(conflict.staleRecoveryAllowed).toBe(true);

        const recovered = await afterReboot.recoverStale(sessionPath, 'owner-owner');
        expect(recovered.owner.bootTimeMs).toBe(800_000);
        await recovered.release();
    });

    it('tolerates clock jitter in the recorded boot instant', async () => {
        const sessionPath = await createSessionPath();
        const owner = createLockService('owner', 101, () => true, () => 10_000, () => 500_000);
        await owner.acquire(sessionPath);

        const contender = createLockService('contender', 202, () => true, () => 20_000, () => 505_000);
        const conflict = await captureConflict(contender.acquire(sessionPath));
        expect(conflict.ownerBootMismatch).toBe(false);
        expect(conflict.ownerLiveness).toBe('alive');
        expect(conflict.staleRecoveryAllowed).toBe(false);
    });

    it('recovers a legacy lock without a boot instant once its owner is gone', async () => {
        const sessionPath = await createSessionPath();
        const lockPath = getSessionLockPath(await fs.realpath(sessionPath));
        await fs.writeFile(lockPath, `${JSON.stringify({
            version: 1,
            owner: {
                ownerId: 'legacy-owner',
                applicationId: 'pi-code-vscode',
                processId: 404,
                hostname: 'test-host',
                acquiredAt: 1_000,
            },
        })}\n`, 'utf8');

        const live = createLockService('contender', 202, () => true);
        const liveConflict = await captureConflict(live.acquire(sessionPath));
        expect(liveConflict.owner?.ownerId).toBe('legacy-owner');
        expect(liveConflict.ownerBootMismatch).toBe(false);
        expect(liveConflict.staleRecoveryAllowed).toBe(false);

        const contender = createLockService('contender', 202, () => false);
        const conflict = await captureConflict(contender.acquire(sessionPath));
        expect(conflict.ownerLiveness).toBe('dead');
        expect(conflict.staleRecoveryAllowed).toBe(true);
        const recovered = await contender.recoverStale(sessionPath, 'legacy-owner');
        expect(recovered.owner.applicationId).toBe('contender');
        await recovered.release();
    });

    it('keeps an unverifiable remote owner off the automatic recovery path', async () => {
        const sessionPath = await createSessionPath();
        const lockPath = getSessionLockPath(await fs.realpath(sessionPath));
        await fs.writeFile(lockPath, `${JSON.stringify({
            version: 2,
            owner: {
                ownerId: 'remote-owner',
                applicationId: 'pi-code-vscode',
                processId: 32152,
                hostname: 'other-host',
                acquiredAt: 0,
                bootTimeMs: 1,
            },
        })}\n`, 'utf8');
        const contender = createLockService('contender', 202, () => false, () => 10_000_000);

        const conflict = await captureConflict(contender.acquire(sessionPath));
        expect(conflict.ownerLiveness).toBe('unknown');
        expect(conflict.staleRecoveryAllowed).toBe(false);
        expect((await captureError(contender.acquire(sessionPath))).message)
            .toContain('other-host');
    });

    it('serializes competing explicit recoveries without deleting the winner lock', async () => {
        const sessionPath = await createSessionPath();
        let now = 10_000;
        const owner = createLockService('owner', 101, () => false, () => now);
        const contender = createLockService('contender', 202, () => false, () => now);
        await owner.acquire(sessionPath);
        now += 5_000;

        const results = await Promise.allSettled([
            contender.recoverStale(sessionPath, 'owner-owner'),
            contender.recoverStale(sessionPath, 'owner-owner'),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason)
            .toBeInstanceOf(SessionLockConflictError);
        const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
        expect(await fs.stat(getSessionLockPath(await fs.realpath(sessionPath))))
            .toBeDefined();
        await winner.release();
    });

    it('recovers an unreadable lock file only once it is old enough', async () => {
        const sessionPath = await createSessionPath();
        const lockPath = getSessionLockPath(await fs.realpath(sessionPath));
        await fs.writeFile(lockPath, 'not-json', 'utf8');
        await fs.utimes(lockPath, 6, 6);
        const contender = createLockService('contender', 202, () => false);

        const freshConflict = await captureConflict(contender.acquire(sessionPath));
        expect(freshConflict).toMatchObject({
            owner: undefined,
            ownerLiveness: 'unknown',
            ageMs: 4_000,
            staleRecoveryAllowed: false,
        });
        expect((await captureError(contender.acquire(sessionPath))).message)
            .toContain(lockPath);

        await fs.utimes(lockPath, 5, 5);
        const staleConflict = await captureConflict(contender.acquire(sessionPath));
        expect(staleConflict.staleRecoveryAllowed).toBe(true);
        const recovered = await contender.recoverStale(sessionPath, undefined);
        expect(recovered.owner.applicationId).toBe('contender');
        await recovered.release();
    });

    it('reclaims a lock whose sidecar disappeared between conflict and recovery', async () => {
        const sessionPath = await createSessionPath();
        const lockPath = getSessionLockPath(await fs.realpath(sessionPath));
        await fs.writeFile(lockPath, 'not-json', 'utf8');
        const contender = createLockService('contender', 202, () => false);
        await fs.rm(lockPath);

        const recovered = await contender.recoverStale(sessionPath, undefined);
        expect(recovered.owner.applicationId).toBe('contender');
        await recovered.release();
    });

    it('rejects a recovery that no longer matches the observed owner', async () => {
        const sessionPath = await createSessionPath();
        const owner = createLockService('owner', 101, () => false);
        await owner.acquire(sessionPath);
        const contender = createLockService('contender', 202, () => false);

        await expect(contender.recoverStale(sessionPath, undefined))
            .rejects.toBeInstanceOf(SessionLockConflictError);
    });
});

describe('NodeSessionLock with real OS primitives', () => {
    // Windows process ids are multiples of four, and no platform allocates one this
    // large, so the default `process.kill(pid, 0)` probe reports it as gone.
    const IMPOSSIBLE_PID = 999_999;

    it('reclaims a lock left by a crashed host without injected clocks or probes', async () => {
        const sessionPath = await createSessionPath();
        const lockPath = getSessionLockPath(await fs.realpath(sessionPath));
        await fs.writeFile(lockPath, `${JSON.stringify({
            version: 1,
            owner: {
                ownerId: 'crashed-owner',
                applicationId: 'pi-code-vscode',
                processId: IMPOSSIBLE_PID,
                hostname: os.hostname(),
                acquiredAt: Date.now(),
            },
        })}\n`, 'utf8');
        const locks = new NodeSessionLock({ applicationId: 'pi-code-vscode' });
        const logged: string[] = [];

        const handle = await acquireSessionLock(locks, sessionPath, (line) => logged.push(line));

        expect(handle.owner.applicationId).toBe('pi-code-vscode');
        expect(handle.owner.processId).toBe(process.pid);
        expect(handle.owner.bootTimeMs).toBeTypeOf('number');
        expect(logged.join('\n')).toContain('Reclaiming abandoned session lock');
        await handle.release();
    });

    it('leaves a live owner in place', async () => {
        const sessionPath = await createSessionPath();
        const locks = new NodeSessionLock({ applicationId: 'pi-code-vscode' });
        const handle = await locks.acquire(sessionPath);

        await expect(acquireSessionLock(locks, sessionPath))
            .rejects.toBeInstanceOf(SessionLockConflictError);

        await handle.release();
    });
});

describe('SessionLockConflictError messages', () => {
    it('names the blocking window for a live owner and points at the sidecar otherwise', async () => {
        const sessionPath = await createSessionPath();
        const owner = createLockService('pi-code-vscode', 32152, () => true);
        await owner.acquire(sessionPath);

        const liveMessage = (await captureError(
            createLockService('contender', 202, () => true).acquire(sessionPath),
        )).message;
        expect(liveMessage).toContain('pi-code-vscode');
        expect(liveMessage).toContain('process 32152 on test-host');
        expect(liveMessage).toContain('Close that chat tab or Pi Code instance');

        const deadMessage = (await captureError(
            createLockService('contender', 202, () => false).acquire(sessionPath),
        )).message;
        expect(deadMessage).toContain('is no longer running');
        expect(deadMessage).toContain(getSessionLockPath(await fs.realpath(sessionPath)));
    });
});

function createLockService(
    applicationId: string,
    processId: number,
    isProcessAlive: (processId: number) => boolean,
    now: () => number = () => 10_000,
    bootTimeMs: () => number | undefined = () => 500_000,
): NodeSessionLock {
    return new NodeSessionLock({
        applicationId,
        processId,
        hostname: 'test-host',
        staleAfterMs: 5_000,
        now,
        isProcessAlive,
        bootTimeMs,
        ownerIdFactory: () => `${applicationId}-owner`,
    });
}

async function captureError(promise: Promise<unknown>): Promise<SessionLockConflictError> {
    try {
        await promise;
        throw new Error('Expected session lock conflict');
    } catch (error) {
        expect(error).toBeInstanceOf(SessionLockConflictError);
        return error as SessionLockConflictError;
    }
}

async function captureConflict(
    promise: Promise<unknown>,
): Promise<SessionLockConflictError['conflict']> {
    return (await captureError(promise)).conflict;
}
