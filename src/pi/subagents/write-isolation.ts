import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedAgentSpec } from './types';

const execFileAsync = promisify(execFile);
const WRITE_TOOLS = new Set(['edit', 'write']);

export interface WriteExecutionLease {
    cwd: string;
    isolationPath?: string;
    release(): Promise<void>;
}

export interface WritePrepareOptions {
    /**
     * Existing worktree to reuse instead of creating a fresh one. Resume passes
     * the path its run recorded: the create path deliberately wipes the
     * directory first, which would destroy everything the child accumulated.
     * Reattachment is strict — an unusable path fails rather than falling back
     * to a fresh worktree, because an empty checkout is indistinguishable from
     * a child that did no work.
     */
    reattachWorktreePath?: string;
}

export class WriteIsolationManager {
    private readonly sharedLeases = new Map<string, string>();
    private readonly worktreesRoot: string;

    constructor(storageRoot: string, private readonly log?: (message: string) => void) {
        this.worktreesRoot = path.resolve(storageRoot, 'subagents', 'worktrees');
    }

    hasWrites(spec: ResolvedAgentSpec): boolean {
        return spec.tools.some((tool) => WRITE_TOOLS.has(tool));
    }

    async prepare(
        workspaceCwd: string,
        agentId: string,
        spec: ResolvedAgentSpec,
        options: WritePrepareOptions = {},
    ): Promise<WriteExecutionLease> {
        if (!this.hasWrites(spec)) return { cwd: workspaceCwd, release: async () => {} };
        const workspace = path.resolve(workspaceCwd);
        if (spec.isolation === 'worktree') {
            const gitRoot = await this.gitRoot(workspace);
            const worktreePath = path.join(this.worktreesRoot, safeSegment(agentId));
            if (options.reattachWorktreePath) {
                await this.assertReattachable(gitRoot, worktreePath, options.reattachWorktreePath);
                this.log?.(`[subagent worktree reattached] agentId=${agentId} path=${worktreePath}`);
                return { cwd: worktreePath, isolationPath: worktreePath, release: async () => {} };
            }
            await fs.mkdir(this.worktreesRoot, { recursive: true });
            await fs.rm(worktreePath, { recursive: true, force: true });
            // `--force` because the `fs.rm` above deletes the directory without
            // unregistering it, and git then refuses the path as "missing but
            // already registered". With `--detach` that is the only check being
            // overridden — no branch is ever claimed from another worktree.
            await execFileAsync('git', [
                '-C', gitRoot, 'worktree', 'add', '--force', '--detach', worktreePath, 'HEAD',
            ]);
            this.log?.(`[subagent worktree created] agentId=${agentId} path=${worktreePath}`);
            return {
                cwd: worktreePath,
                isolationPath: worktreePath,
                // Worktrees are intentionally preserved for review/apply.
                release: async () => {},
            };
        }
        if (spec.background) {
            throw new Error('Background write-capable subagents require isolation=worktree.');
        }
        const owner = this.sharedLeases.get(workspace);
        if (owner && owner !== agentId) {
            throw new Error(`Workspace writer lease is already held by subagent ${owner}.`);
        }
        this.sharedLeases.set(workspace, agentId);
        this.log?.(`[subagent writer lease acquired] agentId=${agentId} workspace=${workspace}`);
        return {
            cwd: workspace,
            release: async () => {
                if (this.sharedLeases.get(workspace) === agentId) {
                    this.sharedLeases.delete(workspace);
                    this.log?.(`[subagent writer lease released] agentId=${agentId} workspace=${workspace}`);
                }
            },
        };
    }

    async getWorktreeDiff(worktreePath: string): Promise<string> {
        this.assertWorktreePath(worktreePath);
        // Intent-to-add makes untracked child artifacts visible in the review
        // patch without staging their contents or touching the primary index.
        await execFileAsync('git', ['-C', worktreePath, 'add', '--intent-to-add', '--', '.']);
        const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'diff', '--binary', 'HEAD'], {
            maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
    }

    async applyWorktree(workspaceCwd: string, worktreePath: string): Promise<void> {
        const diff = await this.getWorktreeDiff(worktreePath);
        if (!diff.trim()) throw new Error('The worktree has no changes to apply.');
        const patchPath = path.join(this.worktreesRoot, `${safeSegment(path.basename(worktreePath))}.patch`);
        await fs.writeFile(patchPath, diff, 'utf8');
        try {
            await execFileAsync('git', ['-C', await this.gitRoot(workspaceCwd), 'apply', '--index', patchPath]);
        } finally {
            await fs.rm(patchPath, { force: true });
        }
    }

    async cleanupWorktree(workspaceCwd: string, worktreePath: string): Promise<void> {
        this.assertWorktreePath(worktreePath);
        const gitRoot = await this.gitRoot(workspaceCwd);
        await execFileAsync('git', ['-C', gitRoot, 'worktree', 'remove', '--force', worktreePath]);
        await fs.rm(worktreePath, { recursive: true, force: true });
        this.log?.(`[subagent worktree removed] path=${worktreePath}`);
    }

    isLeaseHeld(workspaceCwd: string): boolean {
        return this.sharedLeases.has(path.resolve(workspaceCwd));
    }

    /**
     * Refuses to silently recreate what a resume is meant to reuse.
     *
     * The create path opens with `fs.rm` over the whole worktree, so a reattach
     * that cannot find its checkout must fail loudly. Falling back to a fresh
     * worktree would hand the child an empty tree that looks exactly like a
     * child which had done no work, and the parent would review an empty diff
     * and conclude the run failed.
     */
    private async assertReattachable(
        gitRoot: string,
        expectedPath: string,
        requestedPath: string,
    ): Promise<void> {
        this.assertWorktreePath(requestedPath);
        if (pathKey(requestedPath) !== pathKey(expectedPath)) {
            throw new Error(
                `Recorded worktree ${requestedPath} is not this agent's worktree (${expectedPath}); refusing to reattach.`,
            );
        }
        try {
            await fs.access(expectedPath);
        } catch {
            throw new Error(`Preserved worktree ${expectedPath} no longer exists and cannot be reattached.`);
        }
        const registered = (await this.listWorktrees(gitRoot)).get(pathKey(expectedPath));
        if (!registered) {
            throw new Error(
                `Preserved worktree ${expectedPath} is not registered with this repository and cannot be reattached.`,
            );
        }
        if (registered.prunable) {
            throw new Error(`Preserved worktree ${expectedPath} is stale and cannot be reattached.`);
        }
    }

    /** Registered worktrees keyed by normalized path, with their stale flag. */
    private async listWorktrees(gitRoot: string): Promise<Map<string, { prunable: boolean }>> {
        const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'worktree', 'list', '--porcelain']);
        const entries = new Map<string, { prunable: boolean }>();
        let current: { path: string; prunable: boolean } | undefined;
        const flush = (): void => {
            if (current) entries.set(pathKey(current.path), { prunable: current.prunable });
            current = undefined;
        };
        for (const line of stdout.split(/\r?\n/)) {
            if (line.startsWith('worktree ')) {
                flush();
                current = { path: line.slice('worktree '.length).trim(), prunable: false };
            } else if (current && line.startsWith('prunable')) {
                current.prunable = true;
            } else if (line.trim() === '') {
                flush();
            }
        }
        flush();
        return entries;
    }

    private async gitRoot(cwd: string): Promise<string> {
        try {
            const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
            return stdout.trim();
        } catch {
            throw new Error('Worktree isolation requires a Git workspace with a valid HEAD commit.');
        }
    }

    private assertWorktreePath(candidate: string): void {
        const relative = path.relative(this.worktreesRoot, path.resolve(candidate));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('Worktree path is outside extension-owned storage.');
        }
    }
}

function safeSegment(value: string): string {
    const result = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
    if (!result || result === '.' || result === '..') throw new Error('Invalid worktree identifier.');
    return result;
}

/** Git prints worktree paths with forward slashes, and on Windows the drive
 *  letter case need not match ours, so registration lookups compare on a
 *  normalized key rather than the raw string. */
function pathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
