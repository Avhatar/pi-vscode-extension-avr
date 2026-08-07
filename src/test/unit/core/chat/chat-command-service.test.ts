import { describe, expect, it, vi } from 'vitest';
import { ChatCommandService } from '../../../../core/chat/chat-command-service';

function createHarness() {
    const chat = {
        dispatchDirectPrompt: vi.fn(async () => ({ kind: 'prompt_dispatched' })),
        dispatchStreamingCommand: vi.fn(async () => undefined),
        applyQueueControl: vi.fn(),
        undoFileChange: vi.fn(async () => undefined),
        restoreCheckpoint: vi.fn(async () => ['a.txt']),
        redoCheckpoint: vi.fn(async () => ['a.txt']),
    };
    const session = {
        getModels: vi.fn(() => [{ provider: 'p', id: 'm' }]),
        getCurrentModel: vi.fn(() => ({ provider: 'p', id: 'm' })),
        getThinkingLevel: vi.fn(() => 'high'),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        getSessions: vi.fn(async () => [{ id: 's', path: '/s' }]),
        getTranscriptPage: vi.fn(() => ({ sessionId: 's', items: [], hasMoreBefore: false, totalUserMessages: 0 })),
        session: { sessionId: 's' },
        getSkills: vi.fn(() => [{ name: 'skill' }]),
    };
    const tab = {
        id: 'tab-1',
        session,
    } as any;
    const emit = vi.fn();
    const publishState = vi.fn();
    const handleName = vi.fn(() => false);
    const notifyFileHistory = vi.fn();
    const fileMentions = {
        isReady: true,
        ensureIndexed: vi.fn<() => Promise<void>>(async () => undefined),
        search: vi.fn(async () => [{ relativePath: 'src/a.ts', basename: 'a.ts', insertText: '@src/a.ts ' }]),
        augmentPromptIfNeeded: vi.fn(async (text: string) => text),
    };
    const callbacks = {
        directPrompt: {} as any,
        streaming: {} as any,
        fileMentions,
        getFavorites: () => ['p:m'],
        handleName,
        publishState,
        emit,
        notifyFileHistory,
    };
    return {
        service: new ChatCommandService(chat as any),
        chat,
        session,
        tab,
        callbacks,
        emit,
        publishState,
        handleName,
        notifyFileHistory,
        fileMentions,
    };
}

describe('portable ChatCommandService', () => {
    it('returns host lifecycle and preference intents without executing host policy', async () => {
        const { service, tab, callbacks } = createHarness();
        const cases = [
            [{ type: 'setCacheMode', mode: 'long' }, { type: 'setCacheMode', mode: 'long' }],
            [{ type: 'toggleFavorite', provider: 'p', modelId: 'm' }, { type: 'toggleFavorite', provider: 'p', modelId: 'm' }],
            [{ type: 'newSession' }, { type: 'newSession' }],
            [{ type: 'loadSession', sessionPath: '/session' }, { type: 'loadSession', sessionPath: '/session' }],
            [{ type: 'createTab' }, { type: 'createTab' }],
            [{ type: 'closeTab', tabId: 'tab-2' }, { type: 'closeTab', tabId: 'tab-2' }],
            [{ type: 'switchTab', tabId: 'tab-2' }, { type: 'switchTab', tabId: 'tab-2' }],
            [{ type: 'setTodoEnabled', enabled: false }, { type: 'setTodoEnabled', enabled: false }],
            [{ type: 'setSubagentsEnabled', enabled: true }, { type: 'setSubagentsEnabled', enabled: true }],
            [{ type: 'setPlanModeEnabled', enabled: true }, { type: 'setPlanModeEnabled', enabled: true }],
            [{ type: 'setFileUndoViewEnabled', enabled: true }, { type: 'setFileUndoViewEnabled', enabled: true }],
            [{ type: 'setToolDisabled', toolName: 'read', disabled: true }, { type: 'setToolDisabled', toolName: 'read', disabled: true }],
            [{ type: 'setToolsBulk', disabled: ['read'] }, { type: 'setToolsBulk', disabled: ['read'] }],
        ] as const;
        for (const [message, intent] of cases) {
            await expect(service.dispatch(tab, message, callbacks)).resolves.toEqual({ intent });
        }
    });

    it('routes prompt, streaming, queue, and rename commands through existing portable services', async () => {
        const { service, chat, tab, callbacks, handleName, publishState } = createHarness();

        await service.dispatch(tab, { type: 'prompt', text: 'task' }, callbacks);
        expect(handleName).toHaveBeenCalledWith('task', false);
        expect(chat.dispatchDirectPrompt).toHaveBeenCalledWith(tab, { type: 'prompt', text: 'task' }, callbacks.directPrompt);

        await service.dispatch(tab, { type: 'steer', text: 'guide' }, callbacks);
        expect(chat.dispatchStreamingCommand).toHaveBeenCalledWith(
            { type: 'steer', text: 'guide' },
            callbacks.streaming,
        );

        await service.dispatch(tab, { type: 'queueMessage', text: 'next' }, callbacks);
        expect(chat.applyQueueControl).toHaveBeenCalledWith(tab, { type: 'queueMessage', text: 'next' });
        expect(publishState).toHaveBeenCalled();

        await service.dispatch(tab, { type: 'renameTab', name: 'Local' }, callbacks);
        expect(handleName).toHaveBeenCalledWith('/name Local', false);
        expect(chat.dispatchDirectPrompt).toHaveBeenCalledTimes(1);

        handleName.mockReturnValueOnce(true);
        await service.dispatch(tab, { type: 'prompt', text: '/name Local' }, callbacks);
        expect(chat.dispatchDirectPrompt).toHaveBeenCalledTimes(1);
    });

    it('routes model, session, state, and skill commands through semantic messages', async () => {
        const { service, session, tab, callbacks, emit, publishState } = createHarness();

        await service.dispatch(tab, { type: 'getModels' }, callbacks);
        expect(emit).toHaveBeenCalledWith({
            type: 'models',
            models: [{ provider: 'p', id: 'm' }],
            current: { provider: 'p', id: 'm' },
            thinkingLevel: 'high',
            favorites: ['p:m'],
        });

        await expect(service.dispatch(
            tab,
            { type: 'setModel', provider: 'p2', modelId: 'm2' },
            callbacks,
        )).resolves.toEqual({ intent: { type: 'setModel', provider: 'p2', modelId: 'm2' } });
        expect(session.setModel).not.toHaveBeenCalled();

        await expect(service.dispatch(
            tab,
            { type: 'setThinkingLevel', level: 'low' },
            callbacks,
        )).resolves.toEqual({ intent: { type: 'setThinkingLevel', level: 'low' } });
        expect(session.setThinkingLevel).not.toHaveBeenCalled();

        await service.dispatch(tab, { type: 'getSessions' }, callbacks);
        expect(emit).toHaveBeenCalledWith({
            type: 'sessions',
            sessions: [{ id: 's', path: '/s' }],
            currentSessionId: 's',
        });

        await expect(service.dispatch(tab, {
            type: 'getTranscriptPage', sessionId: 's', beforeEntryId: 'entry-20', limit: 80,
        }, callbacks)).resolves.toEqual({
            result: { sessionId: 's', items: [], hasMoreBefore: false, totalUserMessages: 0 },
        });
        expect(session.getTranscriptPage).toHaveBeenCalledWith('s', 'entry-20', 80);

        await service.dispatch(tab, { type: 'getSkills' }, callbacks);
        expect(emit).toHaveBeenCalledWith({ type: 'skills', skills: [{ name: 'skill' }] });
        await service.dispatch(tab, { type: 'getState' }, callbacks);
        expect(publishState).toHaveBeenCalled();
    });

    it('emits indexing and final workspace suggestions in order', async () => {
        const { service, tab, callbacks, emit, fileMentions } = createHarness();
        let finish!: () => void;
        fileMentions.isReady = false;
        fileMentions.ensureIndexed.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

        const dispatch = service.dispatch(tab, {
            type: 'searchWorkspaceFiles', query: 'a', requestId: 7,
        }, callbacks);
        await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({
            type: 'workspaceFileSuggestions', requestId: 7, query: 'a', isIndexing: true, items: [],
        }));
        finish();
        await dispatch;
        expect(emit).toHaveBeenLastCalledWith({
            type: 'workspaceFileSuggestions',
            requestId: 7,
            query: 'a',
            items: [{ relativePath: 'src/a.ts', basename: 'a.ts', insertText: '@src/a.ts ' }],
        });
    });

    it('routes file-history transactions and reports only non-empty native-notice intents', async () => {
        const { service, chat, tab, callbacks, notifyFileHistory, publishState } = createHarness();

        await service.dispatch(tab, {
            type: 'undoFileChange', filePath: 'a.txt', toolCallId: 'tool-1',
        }, callbacks);
        expect(chat.undoFileChange).toHaveBeenCalledWith(tab, 'a.txt', 'tool-1');

        await service.dispatch(tab, { type: 'restoreCheckpoint', messageIndex: 0 }, callbacks);
        expect(notifyFileHistory).toHaveBeenCalledWith('restore', 1);
        await service.dispatch(tab, { type: 'redoCheckpoint' }, callbacks);
        expect(notifyFileHistory).toHaveBeenCalledWith('redo', 1);
        expect(publishState).toHaveBeenCalledTimes(3);
    });
});
