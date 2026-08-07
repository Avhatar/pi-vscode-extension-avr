import { describe, expect, it, vi } from 'vitest';
import { PiSessionManager } from '../../../pi/session';

function createSession(messages: any[]): any {
    return {
        messages,
        model: undefined,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        sessionId: 'session-1',
        sessionName: undefined,
        getActiveToolNames: () => [],
        getContextUsage: () => undefined,
        subscribe: () => () => undefined,
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
    };
}

async function createManager(): Promise<any> {
    const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
    const entries = [
        { id: 'user-1', type: 'message', message: { role: 'user', content: 'Original request' } },
        { id: 'assistant-1', type: 'message', message: { role: 'assistant', content: 'Old answer' } },
        { id: 'compact-1', type: 'compaction', summary: 'Summary' },
        { id: 'user-2', type: 'message', message: { role: 'user', content: 'Middle request' } },
        { id: 'assistant-2', type: 'message', message: { role: 'assistant', content: 'Middle answer' } },
        { id: 'compact-2', type: 'compaction', summary: 'Latest summary' },
        { id: 'user-3', type: 'message', message: { role: 'user', content: 'Recent request' } },
        { id: 'assistant-3', type: 'message', message: { role: 'assistant', content: 'Recent answer' } },
    ];
    manager._sessionEntryToContextMessages = (entry: any) => {
        if (entry.type === 'message') return [entry.message];
        if (entry.type === 'compaction') {
            return [{ role: 'compactionSummary', summary: entry.summary }];
        }
        return [];
    };
    await manager._runtime.start(async () => ({
        session: createSession([
            { role: 'compactionSummary', summary: 'Latest summary' },
            { role: 'user', content: 'Recent request' },
            { role: 'assistant', content: 'Recent answer' },
        ]),
        sessionManager: { getBranch: () => entries },
    }));
    return manager;
}

describe('PiSessionManager transcript projection', () => {
    it('serializes a recent full-branch page without replacing compact model messages', async () => {
        const manager = await createManager();

        expect(manager.serializeState()).toMatchObject({
            messages: [
                { role: 'compactionSummary', summary: 'Latest summary' },
                { role: 'user', content: 'Recent request' },
                { role: 'assistant', content: 'Recent answer' },
            ],
            transcript: {
                sessionId: 'session-1',
                items: [
                    { id: 'user-1:0', entryId: 'user-1', message: { role: 'user', content: 'Original request' } },
                    { id: 'assistant-1:0', entryId: 'assistant-1', message: { role: 'assistant', content: 'Old answer' } },
                    { id: 'compact-1:0', entryId: 'compact-1', message: { role: 'compactionSummary', summary: 'Summary' } },
                    { id: 'user-2:0', entryId: 'user-2', message: { role: 'user', content: 'Middle request' } },
                    { id: 'assistant-2:0', entryId: 'assistant-2', message: { role: 'assistant', content: 'Middle answer' } },
                    { id: 'compact-2:0', entryId: 'compact-2', message: { role: 'compactionSummary', summary: 'Latest summary' } },
                    { id: 'user-3:0', entryId: 'user-3', message: { role: 'user', content: 'Recent request' } },
                    { id: 'assistant-3:0', entryId: 'assistant-3', message: { role: 'assistant', content: 'Recent answer' } },
                ],
                beforeCursor: 'user-1',
                hasMoreBefore: false,
                totalUserMessages: 3,
            },
        });
        await manager.dispose();
    });

    it('pages backwards and rejects a stale session identity', async () => {
        const manager = await createManager();

        expect(manager.getTranscriptPage('session-1', 'user-2', 2)).toMatchObject({
            items: [
                { entryId: 'assistant-1' },
                { entryId: 'compact-1' },
            ],
            beforeCursor: 'assistant-1',
            hasMoreBefore: true,
        });
        expect(() => manager.getTranscriptPage('other-session', 'user-2', 2))
            .toThrow('Transcript session changed');
        await manager.dispose();
    });

    it('reads the first user message from the full branch for title migration', async () => {
        const manager = await createManager();
        expect(manager.getFirstTranscriptUserMessage()).toEqual({
            role: 'user',
            content: 'Original request',
        });
        await manager.dispose();
    });
});
