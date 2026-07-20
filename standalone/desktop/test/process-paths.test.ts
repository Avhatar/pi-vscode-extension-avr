import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    cleanupDesktopProcessPaths,
    resolveDesktopProcessPaths,
} from '../src/process-paths';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => (
        rm(root, { recursive: true, force: true })
    )));
});

describe('desktop process paths', () => {
    it('keeps shared app data stable while isolating Electron session data per process', () => {
        const sharedRoot = resolve('C:/pi-code-desktop-data');
        const first = resolveDesktopProcessPaths(sharedRoot, 'process-a');
        const second = resolveDesktopProcessPaths(sharedRoot, 'process-b');

        expect(first.sharedDataRoot).toBe(sharedRoot);
        expect(second.sharedDataRoot).toBe(sharedRoot);
        expect(first.processRoot).toBe(join(sharedRoot, 'processes', 'process-a'));
        expect(first.sessionDataRoot).toBe(join(first.processRoot, 'session-data'));
        expect(second.sessionDataRoot).not.toBe(first.sessionDataRoot);
    });

    it('rejects a process identity that could escape the owned process directory', () => {
        expect(() => resolveDesktopProcessPaths('C:/app-data', '../other-process')).toThrow(
            'Desktop process identity contains unsupported characters.',
        );
    });

    it('cleans only the current process directory', async () => {
        const sharedRoot = await mkdtemp(join(tmpdir(), 'pi-code-process-paths-'));
        temporaryRoots.push(sharedRoot);
        const first = resolveDesktopProcessPaths(sharedRoot, 'process-a');
        const second = resolveDesktopProcessPaths(sharedRoot, 'process-b');
        await Promise.all([
            mkdir(first.sessionDataRoot, { recursive: true }),
            mkdir(second.sessionDataRoot, { recursive: true }),
        ]);
        await Promise.all([
            writeFile(join(first.sessionDataRoot, 'owner.txt'), 'first', 'utf8'),
            writeFile(join(second.sessionDataRoot, 'owner.txt'), 'second', 'utf8'),
        ]);

        await cleanupDesktopProcessPaths(first);

        await expect(readFile(join(first.sessionDataRoot, 'owner.txt'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await expect(readFile(join(second.sessionDataRoot, 'owner.txt'), 'utf8')).resolves.toBe('second');
    });
});
