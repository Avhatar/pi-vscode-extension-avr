import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WriteIsolationManager } from '../../../../pi/subagents/write-isolation';
import type { ResolvedAgentSpec } from '../../../../pi/subagents/types';

const execFileAsync = promisify(execFile);

describe('worktree reattachment for resumed children', () => {
    let root: string;
    let workspace: string;
    let storage: string;
    let isolation: WriteIsolationManager;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-reattach-'));
        workspace = path.join(root, 'workspace');
        storage = path.join(root, 'storage');
        isolation = new WriteIsolationManager(storage);
        await fs.mkdir(workspace, { recursive: true });
        await git(workspace, ['init']);
        await git(workspace, ['config', 'user.email', 'test@example.invalid']);
        await git(workspace, ['config', 'user.name', 'Reattach Test']);
        // Worktree checkouts would otherwise pick up the machine's autocrlf and
        // turn byte-exact content assertions into a platform coin flip.
        await git(workspace, ['config', 'core.autocrlf', 'false']);
        await fs.writeFile(path.join(workspace, 'tracked.txt'), 'original\n', 'utf8');
        await git(workspace, ['add', 'tracked.txt']);
        await git(workspace, ['commit', '-m', 'fixture']);
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('keeps everything the child wrote when its worktree is reattached', async () => {
        const first = await isolation.prepare(workspace, 'child-1', spec());
        await fs.writeFile(path.join(first.cwd, 'tracked.txt'), 'edited by the child\n', 'utf8');
        await fs.writeFile(path.join(first.cwd, 'child-notes.md'), 'work in progress\n', 'utf8');

        const resumed = await isolation.prepare(workspace, 'child-1', spec(), {
            reattachWorktreePath: first.isolationPath!,
        });

        expect(resumed.cwd).toBe(first.cwd);
        expect(resumed.isolationPath).toBe(first.isolationPath);
        expect(await fs.readFile(path.join(resumed.cwd, 'tracked.txt'), 'utf8')).toBe('edited by the child\n');
        expect(await fs.readFile(path.join(resumed.cwd, 'child-notes.md'), 'utf8')).toBe('work in progress\n');
    });

    it('still surfaces the reattached work through review', async () => {
        const first = await isolation.prepare(workspace, 'child-2', spec());
        await fs.writeFile(path.join(first.cwd, 'tracked.txt'), 'first round\n', 'utf8');

        const resumed = await isolation.prepare(workspace, 'child-2', spec(), {
            reattachWorktreePath: first.isolationPath!,
        });
        await fs.writeFile(path.join(resumed.cwd, 'tracked.txt'), 'second round\n', 'utf8');
        const diff = await isolation.getWorktreeDiff(resumed.isolationPath!);

        expect(diff).toContain('second round');
        expect(diff).not.toContain('first round');
        expect(await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('original\n');
    });

    it('recreates the worktree only when no reattachment was requested', async () => {
        const first = await isolation.prepare(workspace, 'child-3', spec());
        await fs.writeFile(path.join(first.cwd, 'tracked.txt'), 'about to be discarded\n', 'utf8');

        const fresh = await isolation.prepare(workspace, 'child-3', spec());

        expect(fresh.cwd).toBe(first.cwd);
        expect(await fs.readFile(path.join(fresh.cwd, 'tracked.txt'), 'utf8')).toBe('original\n');
    });

    it('refuses to reattach a worktree that was cleaned up instead of silently emptying it', async () => {
        const first = await isolation.prepare(workspace, 'child-4', spec());
        const worktreePath = first.isolationPath!;
        await isolation.cleanupWorktree(workspace, worktreePath);

        await expect(isolation.prepare(workspace, 'child-4', spec(), {
            reattachWorktreePath: worktreePath,
        })).rejects.toThrow('no longer exists');
    });

    it('refuses a recorded path belonging to a different agent', async () => {
        const other = await isolation.prepare(workspace, 'child-5-other', spec());

        await expect(isolation.prepare(workspace, 'child-5', spec(), {
            reattachWorktreePath: other.isolationPath!,
        })).rejects.toThrow('refusing to reattach');
    });

    it('refuses a recorded path outside extension-owned storage', async () => {
        await expect(isolation.prepare(workspace, 'child-6', spec(), {
            reattachWorktreePath: workspace,
        })).rejects.toThrow('outside extension-owned storage');
    });

    it('refuses to reattach a directory git no longer tracks as a worktree', async () => {
        const first = await isolation.prepare(workspace, 'child-7', spec());
        const worktreePath = first.isolationPath!;
        // Unregister it the way `git worktree remove` would, but leave the
        // directory in place: the files are there, the worktree is not.
        await git(workspace, ['worktree', 'remove', '--force', worktreePath]);
        await fs.mkdir(worktreePath, { recursive: true });
        await fs.writeFile(path.join(worktreePath, 'tracked.txt'), 'orphaned\n', 'utf8');

        await expect(isolation.prepare(workspace, 'child-7', spec(), {
            reattachWorktreePath: worktreePath,
        })).rejects.toThrow('not registered with this repository');
    });

    it('leaves read-only and shared-workspace children on the primary workspace', async () => {
        const readOnly = await isolation.prepare(workspace, 'reader', spec({ tools: ['read'] }));
        expect(readOnly.cwd).toBe(workspace);
        expect(readOnly.isolationPath).toBeUndefined();

        const shared = await isolation.prepare(workspace, 'sharer', spec({ isolation: 'shared-workspace' }), {
            reattachWorktreePath: path.join(storage, 'subagents', 'worktrees', 'sharer'),
        });
        expect(shared.cwd).toBe(path.resolve(workspace));
        expect(shared.isolationPath).toBeUndefined();
        await shared.release();
    });
});

function spec(overrides: Partial<ResolvedAgentSpec> = {}): ResolvedAgentSpec {
    return {
        name: 'writer',
        source: 'invocation',
        task: 'Edit tracked.txt',
        model: { provider: 'deepseek', id: 'reasoner' },
        modelSource: 'invocation',
        tools: ['read', 'edit', 'write'],
        toolTrace: {
            registered: ['read', 'edit', 'write'],
            active: ['read', 'edit', 'write'],
            childSafe: ['read', 'edit', 'write'],
            denied: [],
            effective: ['read', 'edit', 'write'],
        },
        maxTurns: 4,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'worktree',
        diagnostics: [],
        ...overrides,
    };
}

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
    return stdout;
}
