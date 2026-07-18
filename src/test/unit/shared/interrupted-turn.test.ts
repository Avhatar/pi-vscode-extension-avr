import { describe, expect, it } from 'vitest';
import {
    TURN_LIFECYCLE_CUSTOM_TYPE,
    hasIncompleteTurnTail,
    hasInterruptedTurnLifecycle,
} from '../../../shared/interrupted-turn';

describe('hasIncompleteTurnTail', () => {
    it('detects persisted user and assistant tool-call tails that require continuation', () => {
        expect(hasIncompleteTurnTail([
            { role: 'user', content: [{ type: 'text', text: 'Continue the task' }] },
        ])).toBe(true);
        expect(hasIncompleteTurnTail([
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Planning' },
                    { type: 'toolCall', id: 'tool-1', name: 'todo', arguments: {} },
                ],
            },
        ])).toBe(true);
    });

    it('does not guess from an ambiguous legacy tool-result tail', () => {
        expect(hasIncompleteTurnTail([
            { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'todo' }] },
            { role: 'toolResult', toolCallId: 'tool-1', toolName: 'todo', content: [] },
        ])).toBe(false);
    });

    it('ignores trailing custom metadata and recognizes a final assistant response as complete', () => {
        expect(hasIncompleteTurnTail([
            { role: 'user', content: 'Do the work' },
            { role: 'custom', customType: 'metadata' },
        ])).toBe(true);
        expect(hasIncompleteTurnTail([
            { role: 'user', content: 'Do the work' },
            { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
            { role: 'custom', customType: 'metadata' },
        ])).toBe(false);
    });

    it('uses the latest durable lifecycle marker to distinguish interrupted and completed tool turns', () => {
        const started = {
            type: 'custom',
            customType: TURN_LIFECYCLE_CUSTOM_TYPE,
            data: { status: 'started' },
        };
        const completed = {
            type: 'custom',
            customType: TURN_LIFECYCLE_CUSTOM_TYPE,
            data: { status: 'completed' },
        };

        expect(hasInterruptedTurnLifecycle([completed, started])).toBe(true);
        expect(hasInterruptedTurnLifecycle([started, completed])).toBe(false);
        expect(hasInterruptedTurnLifecycle([])).toBe(false);
    });

    it('does not mark empty or completed error responses as incomplete', () => {
        expect(hasIncompleteTurnTail([])).toBe(false);
        expect(hasIncompleteTurnTail([
            { role: 'assistant', content: [{ type: 'text', text: 'Provider failed' }], stopReason: 'error' },
        ])).toBe(false);
    });
});
