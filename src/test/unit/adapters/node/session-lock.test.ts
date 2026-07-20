import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    NodeSessionLock,
    getSessionLockPath,
} from '../../../../adapters/node/session-lock';
import { SessionLockConflictError } from '../../../../core/ports/session-platform';

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
            },
            ownerLiveness: 'alive',
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

    it('requires an explicit matching-owner recovery after dead-owner and age checks', async () => {
        const sessionPath = await createSessionPath();
        let now = 10_000;
        const owner = createLockService('owner', 101, () => false, () => now);
        const contender = createLockService('contender', 202, () => false, () => now);
        const abandonedHandle = await owner.acquire(sessionPath);
        now += 4_999;

        const youngConflict = await captureConflict(contender.acquire(sessionPath));
        expect(youngConflict.ownerLiveness).toBe('dead');
        expect(youngConflict.staleRecoveryAllowed).toBe(false);

        now += 1;
        const staleConflict = await captureConflict(contender.acquire(sessionPath));
        expect(staleConflict.staleRecoveryAllowed).toBe(true);
        await expect(contender.acquire(sessionPath)).rejects.toBeInstanceOf(SessionLockConflictError);
        await expect(contender.recoverStale(sessionPath, 'wrong-owner'))
            .rejects.toBeInstanceOf(SessionLockConflictError);

        const recovered = await contender.recoverStale(
            sessionPath,
            staleConflict.owner?.ownerId ?? '',
        );
        await abandonedHandle.release();
        expect(await fs.stat(getSessionLockPath(await fs.realpath(sessionPath))))
            .toBeDefined();
        await recovered.release();
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

    it('does not offer automatic recovery for malformed lock metadata', async () => {
        const sessionPath = await createSessionPath();
        await fs.writeFile(getSessionLockPath(await fs.realpath(sessionPath)), 'not-json', 'utf8');
        const contender = createLockService('contender', 202, () => false);

        const conflict = await captureConflict(contender.acquire(sessionPath));
        expect(conflict).toMatchObject({
            owner: undefined,
            ownerLiveness: 'unknown',
            staleRecoveryAllowed: false,
        });
    });
});

function createLockService(
    applicationId: string,
    processId: number,
    isProcessAlive: (processId: number) => boolean,
    now: () => number = () => 10_000,
): NodeSessionLock {
    return new NodeSessionLock({
        applicationId,
        processId,
        hostname: 'test-host',
        staleAfterMs: 5_000,
        now,
        isProcessAlive,
        ownerIdFactory: () => `${applicationId}-owner`,
    });
}

async function captureConflict(
    promise: Promise<unknown>,
): Promise<SessionLockConflictError['conflict']> {
    try {
        await promise;
        throw new Error('Expected session lock conflict');
    } catch (error) {
        expect(error).toBeInstanceOf(SessionLockConflictError);
        return (error as SessionLockConflictError).conflict;
    }
}
