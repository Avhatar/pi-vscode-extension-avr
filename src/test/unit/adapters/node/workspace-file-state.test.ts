import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeWorkspaceFileState } from '../../../../adapters/node/workspace-file-state';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-node-file-state-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })));
});

describe('NodeWorkspaceFileState', () => {
    it('resolves workspace, cwd, absolute, and home-relative paths', async () => {
        const root = await createTemporaryDirectory();
        const cwd = path.join(root, 'cwd');
        const home = path.join(root, 'home');
        const state = new NodeWorkspaceFileState({
            workspaceRoot: () => root,
            cwd: () => cwd,
            homeDirectory: () => home,
        });

        expect(state.resolvePath('src/main.ts')).toBe(path.join(root, 'src', 'main.ts'));
        expect(state.resolvePath('relative.txt', 'workspace-with-home')).toBe(path.join(root, 'relative.txt'));
        expect(state.resolvePath('~/notes.txt', 'workspace-with-home')).toBe(path.join(home, 'notes.txt'));
        expect(state.resolvePath(home)).toBe(path.normalize(home));

        const withoutWorkspace = new NodeWorkspaceFileState({
            workspaceRoot: () => undefined,
            cwd: () => cwd,
            homeDirectory: () => home,
        });
        expect(withoutWorkspace.resolvePath('src/main.ts')).toBe(path.join(cwd, 'src', 'main.ts'));
    });

    it('preserves present, missing, and unreadable file snapshots', async () => {
        const root = await createTemporaryDirectory();
        const state = new NodeWorkspaceFileState({ workspaceRoot: () => root });
        const present = path.join(root, 'present.txt');
        const directory = path.join(root, 'directory');
        await fs.writeFile(present, 'before', 'utf8');
        await fs.mkdir(directory);

        expect(state.captureText(present)).toEqual({ kind: 'present', content: 'before' });
        expect(state.captureText(path.join(root, 'missing.txt'))).toEqual({ kind: 'missing' });
        const unreadable = state.captureText(directory);
        expect(unreadable.kind).toBe('unreadable');
    });

    it('writes parent directories and deletes files synchronously', async () => {
        const root = await createTemporaryDirectory();
        const state = new NodeWorkspaceFileState({ workspaceRoot: () => root });
        const target = path.join(root, 'nested', 'target.txt');

        state.writeText(target, 'content', { createParentDirectories: true });
        expect(state.exists(target)).toBe(true);
        expect(state.readText(target)).toBe('content');
        state.deleteFile(target);
        expect(state.exists(target)).toBe(false);
    });
});
