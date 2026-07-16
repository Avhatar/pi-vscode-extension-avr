import type { LauncherSubagentSnapshot } from '../../shared/protocol';
import type { SubagentManagerSnapshot } from './runtime';
import type { SubagentRunStatus } from './types';

export interface ProjectSubagentLauncherOptions {
    enabled: boolean;
    toggleDisabled: boolean;
    now?: number;
    smokeSimulation?: boolean;
}

const ACTIVE_STATUSES = new Set<SubagentRunStatus>([
    'queued', 'starting', 'running', 'waiting_for_permission', 'retrying',
]);

export function projectSubagentLauncherSnapshot(
    snapshot: SubagentManagerSnapshot,
    options: ProjectSubagentLauncherOptions,
): LauncherSubagentSnapshot {
    const now = options.now ?? Date.now();
    return {
        enabled: options.enabled,
        toggleDisabled: options.toggleDisabled,
        activeCount: snapshot.activeCount,
        queuedCount: snapshot.queuedCount,
        runs: snapshot.runs.map((run) => {
            const active = ACTIVE_STATUSES.has(run.status);
            const controlsEnabled = !options.smokeSimulation;
            return {
            agentId: run.agentId,
            name: run.name,
            task: run.task ?? run.taskPreview,
            taskPreview: run.taskPreview,
            ...(run.result ? { result: run.result } : {}),
            ...(run.resultPreview ? { resultPreview: run.resultPreview } : {}),
            status: run.status,
            ...(run.model ? { modelLabel: `${run.model.provider}/${run.model.id}` } : {}),
            ...(run.currentTool ? { currentTool: run.currentTool } : {}),
            ...(run.activity ? { activity: run.activity } : {}),
            elapsedMs: elapsed(run.startedAt ?? run.queuedAt, run.finishedAt, now),
            ...(run.queueWaitMs !== undefined ? { queueWaitMs: run.queueWaitMs } : {}),
            turnCount: run.turnCount,
            ...(run.error ? { error: run.error } : {}),
            canDismiss: !active && controlsEnabled,
        };
        }),
        ...(options.smokeSimulation ? { smokeSimulation: true } : {}),
    };
}

function elapsed(startedAt: number | undefined, finishedAt: number | undefined, now: number): number {
    if (startedAt === undefined) return 0;
    return Math.max(0, (finishedAt ?? now) - startedAt);
}
