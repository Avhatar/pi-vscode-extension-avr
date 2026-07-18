import { describe, expect, it } from 'vitest';
import {
    INTERRUPTED_TURN_NOTICE,
    mergeStateMessages,
} from '../../../webview/interrupted-turn-notice';

describe('mergeStateMessages interrupted turn notice', () => {
    it('adds one persistent warning for an incomplete restored turn', () => {
        const incoming = [{ role: 'assistant', content: 'Thought' }];
        const first = mergeStateMessages(incoming, [], true);
        const second = mergeStateMessages(incoming, first, true);

        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(second[1]).toMatchObject({
            role: 'error',
            severity: 'warning',
            content: INTERRUPTED_TURN_NOTICE,
            _piInterruptedTurnNotice: true,
        });
        expect(second[1]).toBe(first[1]);
    });

    it('removes the interruption warning when a new turn starts but preserves other local errors', () => {
        const providerError = { role: 'error', content: 'Provider failed', severity: 'error' };
        const interrupted = mergeStateMessages([], [providerError], true);

        expect(mergeStateMessages([{ role: 'user', content: 'Continue' }], interrupted, false)).toEqual([
            { role: 'user', content: 'Continue' },
            providerError,
        ]);
    });
});
