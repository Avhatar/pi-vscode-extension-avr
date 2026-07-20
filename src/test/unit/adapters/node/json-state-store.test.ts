import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStateStore } from '../../../../adapters/node/json-state-store';
import { NodeSessionLock } from '../../../../adapters/node/session-lock';

const temporaryDirectories: string[] = [];

async function createStatePath(): Promise<{ directory: string; filePath: string }> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-json-state-'));
    temporaryDirectories.push(directory);
    return { directory, filePath: path.join(directory, 'state.json') };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })));
});

describe('JsonStateStore', () => {
    it('opens missing state, applies updates immediately, and persists them in call order', async () => {
        const { filePath } = await createStatePath();
        const store = await JsonStateStore.open(filePath);

        expect(store.get('missing')).toBeUndefined();
        expect(store.get('missing', 7)).toBe(7);
        const first = store.update('first', 1);
        expect(store.get('first')).toBe(1);
        const second = store.update('second', { enabled: true });
        expect(store.get('second')).toEqual({ enabled: true });
        await Promise.all([first, second]);

        const reopened = await JsonStateStore.open(filePath);
        expect(reopened.get('first')).toBe(1);
        expect(reopened.get('second')).toEqual({ enabled: true });
    });

    it('merges different-key updates from independently opened locked stores', async () => {
        const { filePath } = await createStatePath();
        const openLocked = JsonStateStore.open as unknown as (
            path: string,
            options: { lock: NodeSessionLock; lockTimeoutMs: number; retryDelayMs: number },
        ) => Promise<JsonStateStore>;
        const first = await openLocked(filePath, {
            lock: new NodeSessionLock({ applicationId: 'state-test-first', staleAfterMs: 0 }),
            lockTimeoutMs: 1_000,
            retryDelayMs: 1,
        });
        const second = await openLocked(filePath, {
            lock: new NodeSessionLock({ applicationId: 'state-test-second', staleAfterMs: 0 }),
            lockTimeoutMs: 1_000,
            retryDelayMs: 1,
        });

        await first.update('first-process', 1);
        await second.update('second-process', 2);

        const reopened = await JsonStateStore.open(filePath);
        expect(reopened.get('first-process')).toBe(1);
        expect(reopened.get('second-process')).toBe(2);
        await expect(fs.access(`${filePath}.pi-code.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('recovers a verified dead state-lock owner before writing', async () => {
        const { filePath } = await createStatePath();
        const store = await JsonStateStore.open(filePath);
        await store.update('stable', true);
        await fs.writeFile(`${filePath}.pi-code.lock`, `${JSON.stringify({
            version: 1,
            owner: {
                ownerId: 'dead-owner',
                applicationId: 'dead-state-writer',
                processId: 12345,
                hostname: 'test-host',
                acquiredAt: 1,
            },
        })}\n`, 'utf8');
        const locked = await JsonStateStore.open(filePath, {
            lock: new NodeSessionLock({
                applicationId: 'state-test-recovery',
                hostname: 'test-host',
                staleAfterMs: 0,
                now: () => 2,
                isProcessAlive: () => 'dead',
            }),
            lockTimeoutMs: 100,
            retryDelayMs: 1,
        });

        await locked.update('recovered', true);

        const reopened = await JsonStateStore.open(filePath);
        expect(reopened.get('stable')).toBe(true);
        expect(reopened.get('recovered')).toBe(true);
        await expect(fs.access(`${filePath}.pi-code.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('times out without displacing a live state-lock owner', async () => {
        const { filePath } = await createStatePath();
        await fs.writeFile(filePath, `${JSON.stringify({ version: 1, values: {} })}\n`, 'utf8');
        const ownerLock = new NodeSessionLock({ applicationId: 'live-state-owner' });
        const owner = await ownerLock.acquire(filePath);
        try {
            const blocked = await JsonStateStore.open(filePath, {
                lock: new NodeSessionLock({ applicationId: 'blocked-state-writer' }),
                lockTimeoutMs: 0,
                retryDelayMs: 0,
            });

            await expect(blocked.update('blocked', true)).rejects.toThrow(
                `Timed out waiting for state lock: ${filePath}`,
            );
            expect((await JsonStateStore.open(filePath)).get('blocked')).toBeUndefined();
            await expect(fs.access(`${filePath}.pi-code.lock`)).resolves.toBeUndefined();
        } finally {
            await owner.release();
        }
    });

    it('does not overwrite a malformed state file introduced after locked open', async () => {
        const { filePath } = await createStatePath();
        const openLocked = JsonStateStore.open as unknown as (
            path: string,
            options: { lock: NodeSessionLock; lockTimeoutMs: number; retryDelayMs: number },
        ) => Promise<JsonStateStore>;
        const store = await openLocked(filePath, {
            lock: new NodeSessionLock({ applicationId: 'state-test-malformed', staleAfterMs: 0 }),
            lockTimeoutMs: 1_000,
            retryDelayMs: 1,
        });
        await fs.writeFile(filePath, '{not-json', 'utf8');

        await expect(store.update('next', true)).rejects.toThrow('Could not read state file');
        expect(store.get('next')).toBeUndefined();
        expect(await fs.readFile(filePath, 'utf8')).toBe('{not-json');

        await fs.writeFile(filePath, `${JSON.stringify({
            version: 1,
            values: { stable: 'disk' },
        })}\n`, 'utf8');
        await store.update('survivor', true);
        const reopened = await JsonStateStore.open(filePath);
        expect(reopened.get('stable')).toBe('disk');
        expect(reopened.get('survivor')).toBe(true);
        expect(reopened.get('next')).toBeUndefined();
    });

    it('uses undefined as deletion and leaves no temporary files after replacement', async () => {
        const { directory, filePath } = await createStatePath();
        const store = await JsonStateStore.open(filePath);
        await store.update('remove-me', true);
        await store.update('remove-me', undefined);
        await store.update('survivor', 'value');
        await store.flush();

        const reopened = await JsonStateStore.open(filePath);
        expect(reopened.get('remove-me')).toBeUndefined();
        expect(reopened.get('survivor')).toBe('value');
        expect((await fs.readdir(directory)).sort()).toEqual(['state.json']);
    });

    it('rejects malformed or unsupported files without overwriting them', async () => {
        const { filePath } = await createStatePath();
        await fs.writeFile(filePath, '{not-json', 'utf8');
        await expect(JsonStateStore.open(filePath)).rejects.toThrow('Could not read state file');
        expect(await fs.readFile(filePath, 'utf8')).toBe('{not-json');

        await fs.writeFile(filePath, JSON.stringify({ version: 2, values: {} }), 'utf8');
        await expect(JsonStateStore.open(filePath)).rejects.toThrow('Unsupported state file version');
    });

    it('rejects unserializable updates without corrupting memory or disk state', async () => {
        const { filePath } = await createStatePath();
        const store = await JsonStateStore.open(filePath);
        await store.update('stable', 'before');
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        await expect(Promise.resolve().then(() => store.update('stable', circular))).rejects.toThrow();
        expect(store.get('stable')).toBe('before');
        await store.flush();
        expect((await JsonStateStore.open(filePath)).get('stable')).toBe('before');
    });
});
