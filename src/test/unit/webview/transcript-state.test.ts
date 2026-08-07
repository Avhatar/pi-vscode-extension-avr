import { describe, expect, it } from 'vitest';
import type { TranscriptPage } from '../../../shared/agent-protocol';
import {
    createTranscriptState,
    mergeTranscriptTail,
    prependTranscriptPage,
} from '../../../webview/transcript-state';

function page(
    sessionId: string,
    ids: string[],
    options: Partial<TranscriptPage> = {},
): TranscriptPage {
    return {
        sessionId,
        items: ids.map((id) => ({
            id: `${id}:0`,
            entryId: id,
            message: { role: id.startsWith('u') ? 'user' : 'assistant', content: id },
        })),
        beforeCursor: ids[0],
        hasMoreBefore: true,
        totalUserMessages: ids.filter((id) => id.startsWith('u')).length,
        ...options,
    };
}

function itemIds(messages: any[]): string[] {
    return messages.flatMap((message) => message._transcriptItemId ?? []);
}

describe('webview transcript state', () => {
    it('starts from the latest page and annotates stable identities', () => {
        const state = createTranscriptState(page('s1', ['u2', 'a2']));
        expect(itemIds(state.messages)).toEqual(['u2:0', 'a2:0']);
        expect(state).toMatchObject({
            sessionId: 's1',
            beforeCursor: 'u2',
            hasMoreBefore: true,
        });
    });

    it('prepends older pages without duplicates', () => {
        const current = createTranscriptState(page('s1', ['u2', 'a2']));
        const next = prependTranscriptPage(current, page('s1', ['u1', 'a1'], {
            beforeCursor: 'u1',
            hasMoreBefore: false,
            totalUserMessages: 2,
        }));

        expect(itemIds(next.messages)).toEqual(['u1:0', 'a1:0', 'u2:0', 'a2:0']);
        expect(next.beforeCursor).toBe('u1');
        expect(next.hasMoreBefore).toBe(false);
    });

    it('reconciles a new tail while retaining loaded ancestors and local errors', () => {
        const loaded = prependTranscriptPage(
            createTranscriptState(page('s1', ['u2', 'a2'])),
            page('s1', ['u1', 'a1'], { beforeCursor: 'u1', hasMoreBefore: false }),
        );
        loaded.messages.push({ role: 'error', content: 'Local error' });

        const next = mergeTranscriptTail(loaded, page('s1', ['a2', 'u3', 'a3']));
        expect(itemIds(next.messages)).toEqual(['u1:0', 'a1:0', 'u2:0', 'a2:0', 'u3:0', 'a3:0']);
        expect(next.messages.at(-1)).toMatchObject({ role: 'error', content: 'Local error' });
        expect(next.beforeCursor).toBe('u1');
        expect(next.hasMoreBefore).toBe(false);
    });

    it('resets when the session or active branch no longer matches', () => {
        const current = createTranscriptState(page('s1', ['u1', 'a1']));

        expect(itemIds(mergeTranscriptTail(current, page('s2', ['u9'], {
            beforeCursor: 'u9', hasMoreBefore: false,
        })).messages)).toEqual(['u9:0']);
        expect(itemIds(prependTranscriptPage(current, page('s1', ['u8'], {
            reset: true,
        })).messages)).toEqual(['u8:0']);
    });
});
