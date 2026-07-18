import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { TabRuntime } from '../../../core/chat/tab-runtime';

describe('ChatController command dispatch results', () => {
    it('acknowledges a prompt after dispatch without waiting for the model turn', async () => {
        let settleTurn!: () => void;
        const turn = new Promise<void>((resolve) => { settleTurn = resolve; });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map([['tab-1', {
            id: 'tab-1',
            session: {},
            checkpointManager: {
                rollbackPoint: null,
                startTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            diffManager: {
                setCurrentTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            suspendedMessages: [],
            turnCounter: 0,
        }]]);
        controller._activeTabId = 'tab-1';
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._promptUserTask = vi.fn(() => turn);
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        let result: unknown;
        void controller.handleMessage({ type: 'prompt', text: 'hello' }, 'tab-1')
            .then((value: unknown) => { result = value; });
        await vi.waitFor(() => expect(result).toEqual({ ok: true }));
        expect(controller._promptUserTask).toHaveBeenCalledOnce();

        settleTurn();
        await turn;
    });

    it('handles /name locally instead of sending it to the model or queue', async () => {
        const setSessionName = vi.fn();
        const promptUserTask = vi.fn(async () => undefined);
        const controller = Object.create(ChatController.prototype) as any;
        const tab = {
            id: 'tab-1',
            session: { setSessionName },
            checkpointManager: {
                rollbackPoint: null,
                startTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            diffManager: {
                setCurrentTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            suspendedMessages: [],
            queuedMessages: [],
            turnCounter: 0,
        };
        controller._tabs = new Map([['tab-1', tab]]);
        controller._activeTabId = 'tab-1';
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._promptUserTask = promptUserTask;
        controller._updateTabName = vi.fn();
        controller.sendStateSync = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        await expect(controller.handleMessage(
            { type: 'prompt', text: '/name Authentication cleanup' },
            'tab-1',
        )).resolves.toEqual({ ok: true });
        await expect(controller.handleMessage(
            { type: 'queueMessage', text: '/name Streaming rename' },
            'tab-1',
        )).resolves.toEqual({ ok: true });

        expect(setSessionName).toHaveBeenNthCalledWith(1, 'Authentication cleanup');
        expect(setSessionName).toHaveBeenNthCalledWith(2, 'Streaming rename');
        expect(promptUserTask).not.toHaveBeenCalled();
        expect(tab.queuedMessages).toEqual([]);
        expect(tab.turnCounter).toBe(0);
    });

    it('rejects an empty /name command without capturing similar prompts', async () => {
        const promptUserTask = vi.fn(async () => undefined);
        const postForTab = vi.fn();
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map([['tab-1', {
            id: 'tab-1',
            session: { setSessionName: vi.fn() },
            checkpointManager: {
                rollbackPoint: null,
                startTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            diffManager: {
                setCurrentTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            suspendedMessages: [],
            queuedMessages: [],
            turnCounter: 0,
        }]]);
        controller._activeTabId = 'tab-1';
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._promptUserTask = promptUserTask;
        controller._updateTabName = vi.fn();
        controller.sendStateSync = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = postForTab;

        await expect(controller.handleMessage(
            { type: 'prompt', text: '  /name  ' },
            'tab-1',
        )).resolves.toEqual({
            ok: false,
            code: 'command_failed',
            message: 'Usage: /name <name>',
        });
        expect(postForTab).toHaveBeenCalledWith('tab-1', {
            type: 'error',
            message: 'Usage: /name <name>',
        });

        await expect(controller.handleMessage(
            { type: 'prompt', text: '/nameplate cleanup' },
            'tab-1',
        )).resolves.toEqual({ ok: true });
        expect(promptUserTask).toHaveBeenCalledOnce();
    });

    it('unsubscribes tabs without disposing tab or host-owned resources on controller shutdown', () => {
        const unsubscribe = vi.fn();
        const sessionDispose = vi.fn();
        const diffDispose = vi.fn();
        const checkpointDispose = vi.fn();
        const tab = new TabRuntime({
            id: 'tab-1',
            session: { dispose: sessionDispose },
            diffManager: { dispose: diffDispose },
            checkpointManager: { dispose: checkpointDispose },
        });
        tab.addSubscription(unsubscribe);

        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map([['tab-1', tab]]);
        controller._authChangedSubscription = { dispose: vi.fn() };
        controller._codexUsageUnsubscribe = vi.fn();
        const fileMentionsDispose = vi.fn();
        controller._fileMentions = { dispose: fileMentionsDispose };
        controller._sinks = new Set([{}]);
        controller._openPanels = new Map([['tab-1', {}]]);
        controller._panelOpener = vi.fn();
        controller._onTabRenamed = { dispose: vi.fn() };
        controller._onLauncherStateChanged = { dispose: vi.fn() };

        controller.dispose();

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(sessionDispose).not.toHaveBeenCalled();
        expect(diffDispose).not.toHaveBeenCalled();
        expect(checkpointDispose).not.toHaveBeenCalled();
        expect(fileMentionsDispose).not.toHaveBeenCalled();
    });

    it('reports a missing target tab without dispatching', async () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map();
        controller._activeTabId = 'missing-tab';

        await expect(controller.handleMessage({ type: 'abort' }, 'missing-tab')).resolves.toEqual({
            ok: false,
            code: 'tab_not_found',
            message: 'Chat tab not found: missing-tab',
        });
    });

    it('returns command_failed while preserving the existing error event', async () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map([['tab-1', {
            id: 'tab-1',
            session: { abort: vi.fn().mockRejectedValue(new Error('Abort failed')) },
        }]]);
        controller._activeTabId = 'tab-1';
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        await expect(controller.handleMessage({ type: 'abort' }, 'tab-1')).resolves.toEqual({
            ok: false,
            code: 'command_failed',
            message: 'Abort failed',
        });
        expect(controller._postForTab).toHaveBeenCalledWith('tab-1', {
            type: 'error',
            message: 'Abort failed',
        });
    });
});
