import { describe, expect, it } from 'vitest';
import { buildTranscriptPage } from '../../../../core/chat/transcript-pagination';

interface Entry {
    id: string;
    text?: string;
    hidden?: boolean;
    extra?: string;
}

function project(entry: Entry): Array<{ role: string; content: string }> {
    if (entry.hidden) return [];
    const messages = [{ role: 'user', content: entry.text ?? entry.id }];
    if (entry.extra) messages.push({ role: 'assistant', content: entry.extra });
    return messages;
}

describe('buildTranscriptPage', () => {
    it('returns the latest renderable entries with stable item ids', () => {
        const page = buildTranscriptPage([
            { id: 'one', text: 'one' },
            { id: 'hidden', hidden: true },
            { id: 'two', text: 'two', extra: 'reply' },
            { id: 'three', text: 'three' },
        ], project, { limit: 2 });

        expect(page).toEqual({
            items: [
                { id: 'two:0', entryId: 'two', message: { role: 'user', content: 'two' } },
                { id: 'two:1', entryId: 'two', message: { role: 'assistant', content: 'reply' } },
                { id: 'three:0', entryId: 'three', message: { role: 'user', content: 'three' } },
            ],
            beforeCursor: 'two',
            hasMoreBefore: true,
            cursorFound: true,
        });
    });

    it('returns the previous page before an entry cursor and skips metadata-only entries', () => {
        const page = buildTranscriptPage([
            { id: 'one' },
            { id: 'hidden', hidden: true },
            { id: 'two' },
            { id: 'three' },
        ], project, { beforeEntryId: 'three', limit: 2 });

        expect(page.items.map((item) => item.entryId)).toEqual(['one', 'two']);
        expect(page.beforeCursor).toBe('one');
        expect(page.hasMoreBefore).toBe(false);
        expect(page.cursorFound).toBe(true);
    });

    it('falls back to the latest page and marks an unknown cursor', () => {
        const page = buildTranscriptPage([
            { id: 'one' },
            { id: 'two' },
            { id: 'three' },
        ], project, { beforeEntryId: 'missing', limit: 1 });

        expect(page.items.map((item) => item.entryId)).toEqual(['three']);
        expect(page.beforeCursor).toBe('three');
        expect(page.hasMoreBefore).toBe(true);
        expect(page.cursorFound).toBe(false);
    });

    it('reports an empty transcript without another page', () => {
        expect(buildTranscriptPage([
            { id: 'metadata', hidden: true },
        ], project, { limit: 20 })).toEqual({
            items: [],
            beforeCursor: undefined,
            hasMoreBefore: false,
            cursorFound: true,
        });
    });
});
