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

export class WriteIsolationManager {
    private readonly sharedLeases = new Map<string, string>();
    private readonly worktreesRoot: string;

    constructor(storageRoot: string, private readonly log?: (message: string) => void) {
        this.worktreesRoot = path.resolve(storageRoot, 'subagents', 'worktrees');
    }

    hasWrites(spec: ResolvedAgentSpec): boolean {
        return spec.tools.some((tool) => WRITE_TOOLS.has(tool));
    }

    async prepare(workspaceCwd: string, agentId: string, spec: ResolvedAgentSpec): Promise<WriteExecutionLease> {
        if (!this.hasWrites(spec)) return { cwd: workspaceCwd, release: async () => {} };
        const workspace = path.resolve(workspaceCwd);
        if (spec.isolation === 'worktree') {
            const gitRoot = await this.gitRoot(workspace);
            const worktreePath = path.join(this.worktreesRoot, safeSegment(agentId));
            await fs.mkdir(this.worktreesRoot, { recursive: true });
            await fs.rm(worktreePath, { recursive: true, force: true });
            await execFileAsync('git', ['-C', gitRoot, 'worktree', 'add', '--detach', worktreePath, 'HEAD']);
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
