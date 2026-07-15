import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { namespaceChildToolCallId } from '../../manager';
import { routeSubagentMutation, type SubagentMutationEvent } from '../../mutations';
import type { ResolvedAgentSpec } from '../../types';
import { WriteIsolationManager } from '../../write-isolation';
import type { SmokeScenario } from '../types';

const execFileAsync = promisify(execFile);

export const writeWorktreeScenario: SmokeScenario = {
    id: 'write-worktree',
    label: 'Phase 7: Write agents and worktree isolation',
    description: 'Creates a confirmed temporary Git fixture to validate writer leases, namespaced mutations, isolated worktree review/apply, rejection, and cleanup.',
    fixtureSeed: 'phase-7-write-worktree-v1',
    confirmationMessage: 'This deterministic smoke test will create and modify a temporary Git repository under the operating-system temp directory. It will not touch the current workspace. Continue?',
    async run({ logger }) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-write-smoke-'));
        const workspace = path.join(root, 'workspace');
        const storage = path.join(root, 'extension-storage');
        const isolation = new WriteIsolationManager(storage, (message) => logger.event('write-isolation-log', { message }));
        try {
            await fs.mkdir(workspace, { recursive: true });
            await git(workspace, ['init']);
            await git(workspace, ['config', 'user.email', 'smoke@example.invalid']);
            await git(workspace, ['config', 'user.name', 'Pi Smoke']);
            await fs.writeFile(path.join(workspace, 'tracked.txt'), 'original\n', 'utf8');
            await git(workspace, ['add', 'tracked.txt']);
            await git(workspace, ['commit', '-m', 'fixture']);
            logger.event('write-fixture-created', { root, workspace, storage });

            const shared = await isolation.prepare(workspace, 'shared-writer', spec('shared-workspace', false));
            let leaseError = '';
            try { await isolation.prepare(workspace, 'second-writer', spec('shared-workspace', false)); }
            catch (error) { leaseError = error instanceof Error ? error.message : String(error); }
            logger.assert('workspace-writer-lease-rejects-concurrent-writer', leaseError.includes('already held'), true, leaseError);
            logger.assert('writer-lease-visible-while-held', isolation.isLeaseHeld(workspace), true, isolation.isLeaseHeld(workspace));
            await shared.release();
            logger.assert('writer-lease-released', !isolation.isLeaseHeld(workspace), true, isolation.isLeaseHeld(workspace));

            let backgroundSharedError = '';
            try { await isolation.prepare(workspace, 'background-shared', spec('shared-workspace', true)); }
            catch (error) { backgroundSharedError = error instanceof Error ? error.message : String(error); }
            logger.assert('background-write-requires-worktree', backgroundSharedError.includes('require isolation=worktree'), true, backgroundSharedError);

            const startId = namespaceChildToolCallId('writer-agent', 'tool-1');
            const endId = namespaceChildToolCallId('writer-agent', 'tool-1');
            logger.event('mutation-events', {
                start: { type: 'tool_execution_start', toolCallId: startId, toolName: 'edit', path: 'tracked.txt' },
                end: { type: 'tool_execution_end', toolCallId: endId, toolName: 'edit', isError: false },
            });
            logger.assert('child-tool-call-ids-are-namespaced', startId === 'writer-agent:tool-1' && endId === startId, 'writer-agent:tool-1', { startId, endId });
            const routedMutations: SubagentMutationEvent[] = [];
            const mutationSink = { handleExternalToolEvent: (event: SubagentMutationEvent) => routedMutations.push(event) };
            const sharedStart: SubagentMutationEvent = {
                type: 'tool_execution_start', agentId: 'writer-agent', toolCallId: startId,
                toolName: 'edit', args: { path: 'tracked.txt' },
            };
            const sharedEnd: SubagentMutationEvent = {
                type: 'tool_execution_end', agentId: 'writer-agent', toolCallId: endId,
                toolName: 'edit', isError: false,
            };
            routeSubagentMutation(sharedStart, mutationSink);
            routeSubagentMutation(sharedEnd, mutationSink);
            logger.assert('shared-mutations-route-to-diff-checkpoint-pipeline', routedMutations.length === 2 && routedMutations[0].toolCallId === routedMutations[1].toolCallId, 'start/end routed', routedMutations);
            const isolatedRoute = routeSubagentMutation({ ...sharedStart, isolationPath: 'extension-worktree' }, mutationSink);
            logger.assert('worktree-mutations-stay-out-of-primary-diff-pipeline', isolatedRoute === 'worktree' && routedMutations.length === 2, 'worktree and unchanged sink', { isolatedRoute, routed: routedMutations.length });

            const worktree = await isolation.prepare(workspace, 'worktree-writer', spec('worktree', true));
            logger.assert('worktree-created-under-extension-storage', Boolean(worktree.isolationPath?.startsWith(path.resolve(storage))), true, worktree.isolationPath);
            await fs.writeFile(path.join(worktree.cwd, 'tracked.txt'), 'changed by isolated child\n', 'utf8');
            const primaryBeforeApply = await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8');
            logger.assert('worktree-change-does-not-touch-primary-workspace', primaryBeforeApply === 'original\n', 'original', primaryBeforeApply.trim());
            const diff = await isolation.getWorktreeDiff(worktree.isolationPath!);
            logger.event('worktree-review', {
                path: worktree.isolationPath,
                diffBytes: Buffer.byteLength(diff, 'utf8'),
                containsTrackedFile: diff.includes('tracked.txt'),
                autoMerged: false,
            });
            logger.assert('review-diff-exposes-isolated-change', diff.includes('changed by isolated child') && diff.includes('tracked.txt'), true, diff.slice(0, 200));

            await isolation.applyWorktree(workspace, worktree.isolationPath!);
            const primaryAfterApply = await fs.readFile(path.join(workspace, 'tracked.txt'), 'utf8');
            logger.assert('explicit-apply-updates-primary-workspace', primaryAfterApply.trim() === 'changed by isolated child', 'changed by isolated child', primaryAfterApply.trim());
            const staged = await git(workspace, ['diff', '--cached', '--name-only']);
            logger.assert('explicit-apply-stages-reviewable-change', staged.trim() === 'tracked.txt', 'tracked.txt', staged.trim());

            await isolation.cleanupWorktree(workspace, worktree.isolationPath!);
            let worktreeExists = true;
            try { await fs.access(worktree.isolationPath!); } catch { worktreeExists = false; }
            logger.assert('worktree-cleanup-removes-isolated-directory', !worktreeExists, false, worktreeExists);

            const nonGit = path.join(root, 'not-git');
            await fs.mkdir(nonGit, { recursive: true });
            let nonGitError = '';
            try { await isolation.prepare(nonGit, 'non-git-writer', spec('worktree', true)); }
            catch (error) { nonGitError = error instanceof Error ? error.message : String(error); }
            logger.assert('worktree-write-rejected-outside-git', nonGitError.includes('requires a Git workspace'), true, nonGitError);
            logger.assert('smoke-never-touches-user-workspace', !path.resolve(workspace).startsWith(path.resolve(process.cwd())), true, { fixture: workspace, userWorkspace: process.cwd() });
            logger.step('write-worktree-cleanup', {
                fixtureRoot: root,
                writerLeaseHeld: isolation.isLeaseHeld(workspace),
                worktreePreservedBeforeReview: true,
                explicitApply: true,
                result: 'PASS',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    },
};

function spec(isolation: 'shared-workspace' | 'worktree', background: boolean): ResolvedAgentSpec {
    return {
        name: 'writer', source: 'invocation', task: 'Edit tracked.txt',
        model: { provider: 'deepseek', id: 'reasoner' }, modelSource: 'invocation',
        tools: ['read', 'edit', 'write'], toolTrace: {
            registered: ['read', 'edit', 'write'], active: ['read', 'edit', 'write'],
            childSafe: ['read', 'edit', 'write'], denied: [], effective: ['read', 'edit', 'write'],
        },
        maxTurns: 4, timeoutMinutes: 1, background, contextMode: 'fresh', isolation, diagnostics: [],
    };
}

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
    return stdout;
}
