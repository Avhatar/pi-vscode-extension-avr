import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStateStore } from '../../../../adapters/node/json-state-store';

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
