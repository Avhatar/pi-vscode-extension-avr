import { describe, expect, it } from 'vitest';
import { projectSubagentLauncherSnapshot } from '../../../../pi/subagents/launcher-state';
import type { SubagentManagerSnapshot } from '../../../../pi/subagents/runtime';

function snapshot(): SubagentManagerSnapshot {
    return {
        activeCount: 1,
        queuedCount: 0,
        runs: [{
            agentId: 'child-1',
            parentSessionId: 'parent',
            parentTabId: 'tab',
            name: 'reviewer',
            source: 'project',
            taskPreview: 'Review auth',
            status: 'running',
            model: { provider: 'deepseek', id: 'reasoner' },
            currentTool: 'grep',
            activity: 'Running grep',
            startedAt: 1_000,
            turnCount: 2,
        }],
    };
}

describe('subagent launcher projection', () => {
    it('projects actual model, tool, elapsed time, and stop capability', () => {
        const projected = projectSubagentLauncherSnapshot(snapshot(), {
            enabled: true,
            toggleDisabled: false,
            now: 6_000,
        });
        expect(projected).toMatchObject({
            enabled: true,
            activeCount: 1,
            runs: [{
                modelLabel: 'deepseek/reasoner',
                currentTool: 'grep',
                elapsedMs: 5_000,
                canStop: true,
            }],
        });
    });

    it('freezes terminal elapsed time at finishedAt', () => {
        const value = snapshot();
        value.activeCount = 0;
        value.runs[0].status = 'completed';
        value.runs[0].finishedAt = 4_000;
        const projected = projectSubagentLauncherSnapshot(value, {
            enabled: true,
            toggleDisabled: false,
            now: 10_000,
        });
        expect(projected.runs[0].elapsedMs).toBe(3_000);
        expect(projected.runs[0].canStop).toBe(false);
    });

    it('marks smoke rows as non-stoppable', () => {
        const projected = projectSubagentLauncherSnapshot(snapshot(), {
            enabled: true,
            toggleDisabled: false,
            now: 6_000,
            smokeSimulation: true,
        });
        expect(projected.smokeSimulation).toBe(true);
        expect(projected.runs[0].canStop).toBe(false);
    });
});
