import { describe, expect, it } from 'vitest';
import type { SubagentActivityEvent, SubagentRun } from '../../../../pi/subagents/types';

describe('subagent runtime contracts', () => {
    it('serializes run snapshots and structured activity events', () => {
        const run: SubagentRun = {
            agentId: 'agent-1',
            parentSessionId: 'session-1',
            parentTabId: 'tab-1',
            name: 'research',
            source: 'project',
            taskPreview: 'Investigate auth',
            status: 'running',
            model: { provider: 'deepseek', id: 'reasoner' },
            currentTool: 'read',
            turnCount: 2,
        };
        const event: SubagentActivityEvent = {
            type: 'tool-started',
            agentId: run.agentId,
            toolName: 'read',
            description: 'Reading authentication code',
        };

        expect(JSON.parse(JSON.stringify(run))).toMatchObject({
            status: 'running',
            model: { provider: 'deepseek', id: 'reasoner' },
        });
        expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    });
});
