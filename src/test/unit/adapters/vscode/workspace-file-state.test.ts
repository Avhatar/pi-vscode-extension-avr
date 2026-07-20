import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VsCodeWorkspaceFileState } from '../../../../adapters/vscode/workspace-file-state';
import { resetTestWorkspace, setTestWorkspaceRoot } from '../../../mocks/vscode';

describe('VsCodeWorkspaceFileState', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
        resetTestWorkspace();
        for (const directory of temporaryDirectories.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('preserves workspace, absolute, and optional home path resolution', () => {
        const workspaceRoot = makeTemporaryDirectory();
        const homeDirectory = makeTemporaryDirectory();
        setTestWorkspaceRoot(workspaceRoot);
        const files = new VsCodeWorkspaceFileState({
            homeDirectory: () => homeDirectory,
        });
        const absoluteRoot = makeTemporaryDirectory();
        const absolutePath = path.join(absoluteRoot, 'absolute.txt');
        const nonCanonicalAbsolutePath = [absoluteRoot, 'nested', '..', 'absolute.txt'].join(path.sep);

        expect(files.resolvePath('nested/file.txt', 'workspace')).toBe(
            path.join(workspaceRoot, 'nested/file.txt'),
        );
        expect(files.resolvePath(absolutePath, 'workspace-with-home')).toBe(absolutePath);
        expect(files.resolvePath(nonCanonicalAbsolutePath, 'workspace')).toBe(absolutePath);
        expect(files.resolvePath('~/home.txt', 'workspace')).toBe(
            path.join(workspaceRoot, '~/home.txt'),
        );
        expect(files.resolvePath('~/home.txt', 'workspace-with-home')).toBe(
            path.join(homeDirectory, 'home.txt'),
        );
        expect(files.resolvePath('~', 'workspace-with-home')).toBe(homeDirectory);
        expect(files.resolvePath('~', 'workspace')).toBe(path.join(workspaceRoot, '~'));
    });

    it('uses the cwd fallback and performs synchronous file operations', () => {
        const cwd = makeTemporaryDirectory();
        resetTestWorkspace();
        const files = new VsCodeWorkspaceFileState({ cwd: () => cwd });
        const absolutePath = files.resolvePath('nested/file.txt');

        expect(absolutePath).toBe(path.resolve(cwd, 'nested/file.txt'));
        expect(files.exists(absolutePath)).toBe(false);
        expect(files.captureText(absolutePath)).toEqual({ kind: 'missing' });
        files.writeText(absolutePath, 'content', { createParentDirectories: true });
        expect(files.exists(absolutePath)).toBe(true);
        expect(files.readText(absolutePath)).toBe('content');
        expect(files.captureText(absolutePath)).toEqual({ kind: 'present', content: 'content' });
        files.deleteFile(absolutePath);
        expect(files.exists(absolutePath)).toBe(false);
    });

    function makeTemporaryDirectory(): string {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-state-test-'));
        temporaryDirectories.push(directory);
        return directory;
    }
});
