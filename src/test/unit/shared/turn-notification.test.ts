import { describe, expect, it } from 'vitest';
import { formatTurnCompletionMessage } from '../../../shared/turn-notification';

describe('turn completion notification formatting', () => {
    it('formats a successful turn with a short duration', () => {
        expect(formatTurnCompletionMessage({
            tabName: 'Refactor API',
            outcome: 'completed',
            durationMs: 42_400,
        })).toBe('Pi Code: Refactor API completed in 42s.');
    });

    it('describes non-success outcomes and longer durations', () => {
        expect(formatTurnCompletionMessage({
            tabName: 'Tests',
            outcome: 'failed',
            durationMs: 125_000,
        })).toBe('Pi Code: Tests failed in 2m 5s.');
        expect(formatTurnCompletionMessage({
            tabName: 'Agent',
            outcome: 'stopped',
        })).toBe('Pi Code: Agent was stopped.');
        expect(formatTurnCompletionMessage({
            tabName: 'Agent',
            outcome: 'truncated',
        })).toBe('Pi Code: Agent finished with a truncated response.');
    });
});
