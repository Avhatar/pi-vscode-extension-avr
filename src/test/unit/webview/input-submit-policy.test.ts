import { describe, expect, it } from 'vitest';
import { decideInputSubmit, isCompactCommandText } from '../../../webview/input-submit-policy';

function context(overrides: Partial<Parameters<typeof decideInputSubmit>[0]> = {}) {
    return {
        text: 'hello',
        isStreaming: false,
        isCompacting: false,
        hasAttachments: false,
        steerRequested: false,
        ...overrides,
    };
}

describe('webview input submit policy', () => {
    it('sends directly only while the tab is idle', () => {
        expect(decideInputSubmit(context())).toEqual({ kind: 'send' });
        expect(decideInputSubmit(context({ hasAttachments: true, text: '' })))
            .toEqual({ kind: 'send' });
    });

    it('queues while a compaction runs instead of dispatching a doomed prompt', () => {
        expect(decideInputSubmit(context({ isCompacting: true })))
            .toEqual({ kind: 'queue' });
        expect(decideInputSubmit(context({ isStreaming: true })))
            .toEqual({ kind: 'queue' });
    });

    it('queues a compaction-time steer request because there is no turn to inject into', () => {
        expect(decideInputSubmit(context({ isStreaming: true, steerRequested: true })))
            .toEqual({ kind: 'steer' });
        expect(decideInputSubmit(context({ isCompacting: true, steerRequested: true })))
            .toEqual({ kind: 'queue' });
    });

    it('keeps /compact immediate while streaming and refuses a second concurrent one', () => {
        expect(decideInputSubmit(context({ text: '/compact', isStreaming: true })))
            .toEqual({ kind: 'compact' });
        expect(decideInputSubmit(context({ text: '/compact keep tests', isStreaming: true })))
            .toEqual({ kind: 'compact' });

        const rejected = decideInputSubmit(context({ text: '/compact', isCompacting: true }));
        expect(rejected.kind).toBe('reject');
        expect(rejected).toMatchObject({ message: expect.stringContaining('already running') });
    });

    it('queues attachments while busy instead of dropping them', () => {
        const busyStates = [{ isStreaming: true }, { isCompacting: true }];
        for (const busy of busyStates) {
            expect(decideInputSubmit(context({ ...busy, hasAttachments: true })))
                .toEqual({ kind: 'queue' });
            // Attachment-only (no text) is still a real submission while busy.
            expect(decideInputSubmit(context({ ...busy, text: '   ', hasAttachments: true })))
                .toEqual({ kind: 'queue' });
        }
    });

    it('queues rather than steers when attachments are present, since a live turn is text-only', () => {
        expect(decideInputSubmit(context({
            isStreaming: true,
            steerRequested: true,
            hasAttachments: true,
        }))).toEqual({ kind: 'queue' });
    });

    it('still refuses attachments on a /compact command', () => {
        const slashDecision = decideInputSubmit(context({
            text: '/compact',
            isStreaming: true,
            hasAttachments: true,
        }));
        expect(slashDecision).toMatchObject({
            kind: 'reject',
            message: expect.stringContaining('Slash commands cannot include attachments'),
        });
    });

    it('ignores an empty submission with no attachments while busy', () => {
        expect(decideInputSubmit(context({ text: '   ', isCompacting: true })))
            .toEqual({ kind: 'ignore' });
    });

    it('recognises compact command text', () => {
        expect(isCompactCommandText('  /compact  ')).toBe(true);
        expect(isCompactCommandText('/compact focus on tests')).toBe(true);
        expect(isCompactCommandText('/compaction')).toBe(false);
        expect(isCompactCommandText('compact')).toBe(false);
    });
});
