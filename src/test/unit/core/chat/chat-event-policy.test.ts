import { describe, expect, it } from 'vitest';
import {
    classifyAssistantTurnIssue,
    collectOrphanedTools,
    findLastAssistantMessage,
    shouldDispatchQueueAfterTerminal,
    shouldSyncStateForEvent,
    turnCompletionOutcome,
} from '../../../../core/chat/chat-event-policy';

describe('portable terminal event policy', () => {
    it('finds the latest assistant message without copying the transcript', () => {
        const last = { role: 'assistant', content: [{ type: 'text', text: 'last' }] };
        expect(findLastAssistantMessage([
            { role: 'assistant', content: 'first' },
            { role: 'toolResult' },
            last,
            { role: 'custom' },
        ])).toBe(last);
        expect(findLastAssistantMessage([{ role: 'user' }])).toBeUndefined();
    });

    it('classifies provider errors, empty output, truncation, and unknown stop reasons', () => {
        expect(classifyAssistantTurnIssue({
            role: 'assistant', stopReason: 'error', errorMessage: 'provider failed', content: [],
        })).toEqual({ kind: 'provider-error', message: 'provider failed' });
        expect(classifyAssistantTurnIssue({
            role: 'assistant', stopReason: 'stop', provider: 'qwen', model: 'coder', content: [],
        })).toEqual({
            kind: 'provider-error',
            message: expect.stringContaining('qwen/coder returned an empty response'),
        });
        expect(classifyAssistantTurnIssue({
            role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'partial' }],
        })).toEqual({
            kind: 'notice',
            severity: 'warning',
            message: expect.stringContaining('output token limit'),
        });
        expect(classifyAssistantTurnIssue({
            role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'partial' }],
        })).toEqual({
            kind: 'notice',
            severity: 'info',
            message: 'Turn ended with unexpected stop reason "toolUse". The response above may be incomplete.',
        });
        expect(classifyAssistantTurnIssue({
            role: 'assistant', stopReason: 'aborted', content: [],
        })).toBeUndefined();
        expect(classifyAssistantTurnIssue({
            role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }],
        })).toBeUndefined();
    });

    it('maps terminal messages to notification outcomes', () => {
        expect(turnCompletionOutcome(undefined)).toBe('completed');
        expect(turnCompletionOutcome({ role: 'assistant', stopReason: 'aborted', content: [] })).toBe('stopped');
        expect(turnCompletionOutcome({ role: 'assistant', stopReason: 'error', content: [] })).toBe('failed');
        expect(turnCompletionOutcome({ role: 'assistant', stopReason: 'stop', content: [] })).toBe('failed');
        expect(turnCompletionOutcome({ role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'partial' }] })).toBe('truncated');
        expect(turnCompletionOutcome({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] })).toBe('completed');
    });

    it('projects orphaned tool timings without mutating the source map', () => {
        const tools = new Map([
            ['call-1', { name: 'bash', startTime: 100 }],
            ['call-2', { name: 'read', startTime: 500 }],
        ]);
        expect(collectOrphanedTools(tools, 400)).toEqual([
            { id: 'call-1', name: 'bash', elapsedMs: 300 },
            { id: 'call-2', name: 'read', elapsedMs: 0 },
        ]);
        expect(tools.size).toBe(2);
    });

    it('preserves agent_end/agent_settled queue race and state-sync event sets', () => {
        expect(shouldDispatchQueueAfterTerminal('agent_end', {
            isStreamingLocal: true,
            isSessionStreaming: false,
        })).toBe(true);
        expect(shouldDispatchQueueAfterTerminal('agent_end', {
            isStreamingLocal: false,
            isSessionStreaming: true,
        })).toBe(false);
        expect(shouldDispatchQueueAfterTerminal('agent_settled', {
            isStreamingLocal: false,
            isSessionStreaming: false,
        })).toBe(true);
        expect(shouldDispatchQueueAfterTerminal('agent_settled', {
            isStreamingLocal: true,
            isSessionStreaming: false,
        })).toBe(false);
        expect(shouldDispatchQueueAfterTerminal('message_end', {
            isStreamingLocal: false,
            isSessionStreaming: false,
        })).toBe(false);

        expect(shouldSyncStateForEvent('agent_start')).toBe(true);
        expect(shouldSyncStateForEvent('agent_end')).toBe(true);
        expect(shouldSyncStateForEvent('message_end')).toBe(true);
        expect(shouldSyncStateForEvent('turn_end')).toBe(true);
        expect(shouldSyncStateForEvent('compaction_start')).toBe(true);
        expect(shouldSyncStateForEvent('compaction_end')).toBe(true);
        expect(shouldSyncStateForEvent('agent_settled')).toBe(false);
    });
});
