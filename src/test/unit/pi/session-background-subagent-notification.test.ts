import { describe, expect, it, vi } from 'vitest';
import { PiSessionManager } from '../../../pi/session';
import { SubagentRunError } from '../../../pi/subagents/runtime';

function createSession(isStreaming: boolean): any {
    return {
        messages: [],
        model: undefined,
        thinkingLevel: 'medium',
        isStreaming,
        isCompacting: false,
        sessionId: 'session-1',
        sessionName: 'Session',
        getActiveToolNames: () => [],
        getContextUsage: () => undefined,
        subscribe: () => () => undefined,
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
    };
}

function failedRun(): any {
    return {
        agentId: 'background-1',
        parentSessionId: 'parent',
        name: 'implementer',
        source: 'invocation',
        task: 'Refactor the card renderer.',
        taskPreview: 'Refactor the card renderer.',
        status: 'failed',
        turnCount: 12,
        model: { provider: 'deepseek', id: 'reasoner' },
        error: 'Subagent exceeded its maximum turn count.',
        finishedAt: 1_000,
    };
}

async function startManager(): Promise<{ manager: any; appendCustomMessageEntry: any }> {
    const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
    const appendCustomMessageEntry = vi.fn();
    await manager._runtime.start(async () => ({
        session: createSession(false),
        sessionManager: { appendCustomMessageEntry },
    }));
    return { manager, appendCustomMessageEntry };
}

describe('background subagent notifications', () => {
    it('salvages the stranded partial result into the parent notification', async () => {
        const { manager, appendCustomMessageEntry } = await startManager();

        manager._deliverBackgroundSubagentNotification(
            failedRun(),
            undefined,
            new SubagentRunError(
                'max-turns',
                'Subagent exceeded its maximum turn count.',
                'background-1',
                'Refactored CardData and started on CardView.',
            ),
        );

        const [, content, , details] = appendCustomMessageEntry.mock.calls[0];
        expect(content).toContain('Subagent exceeded its maximum turn count.');
        expect(content).toContain('Refactored CardData and started on CardView.');
        expect(details.result).toContain('Refactored CardData and started on CardView.');
        await manager.dispose();
    });

    it('keeps a bare reason when the child produced nothing to salvage', async () => {
        const { manager, appendCustomMessageEntry } = await startManager();

        manager._deliverBackgroundSubagentNotification(
            failedRun(),
            undefined,
            new SubagentRunError('runtime-error', 'Child runtime exploded.', 'background-1'),
        );

        const [, content] = appendCustomMessageEntry.mock.calls[0];
        expect(content).toContain('Child runtime exploded.');
        expect(content).not.toContain('salvaged');
        await manager.dispose();
    });

    it('reports a completed background child with its delivered result', async () => {
        const { manager, appendCustomMessageEntry } = await startManager();

        manager._deliverBackgroundSubagentNotification(
            { ...failedRun(), status: 'completed', error: undefined },
            {
                agentId: 'background-1',
                result: 'Card renderer refactored and verified.',
                model: { provider: 'deepseek', id: 'reasoner' },
                turnCount: 9,
                truncated: false,
            },
            undefined,
        );

        const [, content, , details] = appendCustomMessageEntry.mock.calls[0];
        expect(content).toContain('Card renderer refactored and verified.');
        expect(details.status).toBe('completed');
        await manager.dispose();
    });
});
