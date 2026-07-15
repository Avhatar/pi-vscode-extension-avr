import { projectSubagentLauncherSnapshot } from '../../launcher-state';
import type { SubagentManagerSnapshot } from '../../runtime';
import type { SubagentRun, SubagentRunStatus } from '../../types';
import type { SmokeScenario } from '../types';

const NOW = 1_000_000;

export const launcherLifecycleScenario: SmokeScenario = {
    id: 'launcher-lifecycle',
    label: 'Phase 4: Launcher lifecycle panel',
    description: 'Injects deterministic queued, starting, running, retrying, completed, failed, and cancelled rows into the real launcher state path.',
    fixtureSeed: 'phase-4-launcher-lifecycle-v1',
    async run({ logger, showLauncherSnapshot }) {
        const managerSnapshot: SubagentManagerSnapshot = {
            activeCount: 4,
            queuedCount: 1,
            runs: [
                run('queued-child', 'queued', 0, undefined, 'Waiting for a coordinator slot'),
                run('starting-child', 'starting', 2_000, undefined, 'Creating isolated child session'),
                run('security-review-with-a-long-name', 'running', 5_000, undefined, 'Running grep', {
                    provider: 'provider-with-an-intentionally-long-cross-provider-label',
                    id: 'deepseek-v4-pro-reasoning-preview-2026-07',
                }, 'grep'),
                run('provider-retry', 'retrying', 8_000, undefined, 'Retrying provider request (attempt 2)', {
                    provider: 'anthropic', id: 'claude-sonnet-4-5',
                }),
                run('completed-review', 'completed', 12_000, 5_000, 'Completed', {
                    provider: 'google', id: 'gemini-2.5-pro',
                }),
                run('failed-review', 'failed', 15_000, 4_000, 'Failed', {
                    provider: 'deepseek', id: 'deepseek-reasoner',
                }, undefined, 'Simulated provider failure'),
                run('cancelled-review', 'cancelled', 20_000, 3_000, 'Cancelled'),
            ],
        };
        const projected = projectSubagentLauncherSnapshot(managerSnapshot, {
            enabled: true,
            toggleDisabled: false,
            now: NOW,
            smokeSimulation: true,
        });
        showLauncherSnapshot?.(projected);

        logger.event('launcher-snapshot-injected', {
            installedHost: Boolean(showLauncherSnapshot),
            rows: projected.runs.length,
            activeCount: projected.activeCount,
            queuedCount: projected.queuedCount,
            smokeSimulation: projected.smokeSimulation,
        });
        for (const row of projected.runs) {
            logger.event('launcher-row', {
                agentId: row.agentId,
                status: row.status,
                model: row.modelLabel,
                currentTool: row.currentTool,
                activity: row.activity,
                elapsedMs: row.elapsedMs,
                canStop: row.canStop,
            });
        }

        const statuses = projected.runs.map((row) => row.status);
        logger.assert('all-required-lifecycle-statuses', same(statuses, [
            'queued', 'starting', 'running', 'retrying', 'completed', 'failed', 'cancelled',
        ]), true, statuses);
        logger.assert('active-and-queued-counts', projected.activeCount === 4 && projected.queuedCount === 1, 'active=4 queued=1', `active=${projected.activeCount} queued=${projected.queuedCount}`);
        logger.assert('long-cross-provider-model-label-retained', (projected.runs[2].modelLabel?.length ?? 0) > 70, true, projected.runs[2].modelLabel);
        logger.assert('current-tool-is-visible', projected.runs[2].currentTool === 'grep', 'grep', projected.runs[2].currentTool);
        logger.assert('running-elapsed-time-projected', projected.runs[2].elapsedMs === 5_000, 5_000, projected.runs[2].elapsedMs);
        logger.assert('completed-elapsed-time-is-frozen', projected.runs[4].elapsedMs === 5_000, 5_000, projected.runs[4].elapsedMs);
        logger.assert('failed-error-is-retained', projected.runs[5].error === 'Simulated provider failure', 'Simulated provider failure', projected.runs[5].error);
        logger.assert('smoke-rows-cannot-route-stop', projected.runs.every((row) => !row.canStop), true, projected.runs.map((row) => row.canStop));
        logger.assert('smoke-marker-keeps-rows-until-reset', projected.smokeSimulation === true, true, projected.smokeSimulation);
        logger.assert('toggle-state-projected', projected.enabled && !projected.toggleDisabled, 'enabled and interactive in live state', { enabled: projected.enabled, toggleDisabled: projected.toggleDisabled });
        logger.step('launcher-lifecycle-ready-for-inspection', {
            result: 'PASS',
            instruction: showLauncherSnapshot
                ? 'Inspect Subagents in the launcher, then click Reset.'
                : 'Unit host has no visual launcher.',
        });
    },
};

function run(
    agentId: string,
    status: SubagentRunStatus,
    ageMs: number,
    durationMs: number | undefined,
    activity: string,
    model = { provider: 'openai-codex', id: 'gpt-5.6-codex' },
    currentTool?: string,
    error?: string,
): SubagentRun {
    const startedAt = ageMs > 0 ? NOW - ageMs : undefined;
    const finishedAt = startedAt !== undefined && durationMs !== undefined ? startedAt + durationMs : undefined;
    return {
        agentId,
        parentSessionId: 'smoke-parent',
        parentTabId: 'smoke-tab',
        name: agentId,
        source: 'invocation',
        taskPreview: `Deterministic task for ${agentId}`,
        status,
        model,
        ...(currentTool ? { currentTool } : {}),
        activity,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        turnCount: status === 'queued' || status === 'starting' ? 0 : 2,
        ...(error ? { error } : {}),
    };
}

function same<T>(actual: readonly T[], expected: readonly T[]): boolean {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
