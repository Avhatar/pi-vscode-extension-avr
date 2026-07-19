import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { ChatService } from '../../../core/chat/chat-service';
import { TabRegistry } from '../../../core/chat/tab-registry';
import { TabRuntime } from '../../../core/chat/tab-runtime';

describe('ChatController command dispatch results', () => {
    it('acknowledges a prompt after dispatch without waiting for the model turn', async () => {
        let settleTurn!: () => void;
        const turn = new Promise<void>((resolve) => { settleTurn = resolve; });
        const prompt = vi.fn(() => turn);
        const tab = createPromptTab({ prompt });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        const images = [{ type: 'image', data: 'abc', mimeType: 'image/png' }] as any;
        const files = [{
            type: 'file', data: 'text', mimeType: 'text/plain', name: 'notes.txt', size: 4,
        }] as any;
        let result: unknown;
        void controller.handleMessage({ type: 'prompt', text: 'hello', images, files }, 'tab-1')
            .then((value: unknown) => { result = value; });
        await vi.waitFor(() => expect(result).toEqual({ ok: true }));
        expect(prompt).toHaveBeenCalledWith('hello', images, files);

        settleTurn();
        await turn;
    });

    it('applies Plan Mode only to ordinary direct prompts, not compact commands', async () => {
        const prompt = vi.fn(async () => undefined);
        const compact = vi.fn(async () => undefined);
        const tab = createPromptTab({ prompt, compact });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => true);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller.sendStateSync = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        await controller.handleMessage({ type: 'prompt', text: 'make a plan' }, 'tab-1');
        await controller.handleMessage({ type: 'prompt', text: '/compact focus' }, 'tab-1');

        expect(prompt).toHaveBeenCalledWith(
            expect.stringMatching(/<plan-mode-instructions>[\s\S]*make a plan/),
            undefined,
            undefined,
        );
        expect(compact).toHaveBeenCalledWith('focus');
        expect(controller._isPlanModeEnabledFor).toHaveBeenCalledOnce();
        expect(controller.sendStateSync).toHaveBeenCalledWith('tab-1');
    });

    it('returns command_failed when direct mention augmentation rejects after turn setup', async () => {
        const prompt = vi.fn(async () => undefined);
        const tab = createPromptTab({ prompt });
        const error = new Error('mention indexing failed');
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._fileMentions = {
            augmentPromptIfNeeded: vi.fn(async () => { throw error; }),
        };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        await expect(controller.handleMessage({
            type: 'prompt', text: 'read @missing',
        }, 'tab-1')).resolves.toEqual({
            ok: false,
            code: 'command_failed',
            message: 'mention indexing failed',
        });
        expect(tab.turnCounter).toBe(1);
        expect(prompt).not.toHaveBeenCalled();
        expect(controller._postForTab).toHaveBeenCalledWith('tab-1', {
            type: 'error',
            message: 'mention indexing failed',
        });
    });

    it('awaits and forwards steer and follow-up commands through the selected tab', async () => {
        const steer = vi.fn(async () => undefined);
        const followUp = vi.fn(async () => undefined);
        const tab = createPromptTab({ steer, followUp });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._fileMentions = {
            augmentPromptIfNeeded: vi.fn(async (text: string) => `${text} expanded`),
        };
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();
        const images = [{ type: 'image', data: 'abc', mimeType: 'image/png' }] as any;
        const files = [{
            type: 'file', data: 'text', mimeType: 'text/plain', name: 'notes.txt', size: 4,
        }] as any;

        await expect(controller.handleMessage({
            type: 'steer', text: 'redirect', images, files,
        }, 'tab-1')).resolves.toEqual({ ok: true });
        await expect(controller.handleMessage({
            type: 'followUp', text: 'continue', images, files,
        }, 'tab-1')).resolves.toEqual({ ok: true });

        expect(controller._prepareCacheForRequest).toHaveBeenCalledTimes(2);
        expect(controller._logPromptToolState).toHaveBeenNthCalledWith(1, tab, 'steer');
        expect(controller._logPromptToolState).toHaveBeenNthCalledWith(2, tab, 'followUp');
        expect(steer).toHaveBeenCalledWith('redirect expanded', images, files);
        expect(followUp).toHaveBeenCalledWith('continue expanded', images, files);
    });

    it('maps streaming-command augmentation failure through the existing error transport', async () => {
        const steer = vi.fn(async () => undefined);
        const tab = createPromptTab({ steer });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._fileMentions = {
            augmentPromptIfNeeded: vi.fn(async () => { throw new Error('mention failed'); }),
        };
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        await expect(controller.handleMessage({
            type: 'steer', text: 'inspect @missing',
        }, 'tab-1')).resolves.toEqual({
            ok: false,
            code: 'command_failed',
            message: 'mention failed',
        });
        expect(steer).not.toHaveBeenCalled();
        expect(controller._postForTab).toHaveBeenCalledWith('tab-1', {
            type: 'error',
            message: 'mention failed',
        });
    });

    it('handles /name locally instead of sending it to the model or queue', async () => {
        const setSessionName = vi.fn();
        const prompt = vi.fn(async () => undefined);
        const controller = Object.create(ChatController.prototype) as any;
        const tab = createPromptTab({ setSessionName, prompt });
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
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
        expect(prompt).not.toHaveBeenCalled();
        expect(tab.queuedMessages).toEqual([]);
        expect(tab.turnCounter).toBe(0);
    });

    it('applies queue controls through the service and publishes every command', async () => {
        const tab = { id: 'tab-1', queuedMessages: [] as string[] };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._handleNameCommand = vi.fn(() => false);
        controller.sendStateSync = vi.fn();
        controller._postForTab = vi.fn();

        await controller.handleMessage({ type: 'queueMessage', text: '  raw  ' }, 'tab-1');
        await controller.handleMessage({
            type: 'editQueuedMessage', index: 0, text: '  edited  ',
        }, 'tab-1');
        await controller.handleMessage({
            type: 'editQueuedMessage', index: 4, text: 'ignored',
        }, 'tab-1');
        await controller.handleMessage({ type: 'removeQueuedMessage', index: 3 }, 'tab-1');
        await controller.handleMessage({ type: 'removeQueuedMessage', index: 0 }, 'tab-1');
        const queueBeforeCancel = tab.queuedMessages;
        await controller.handleMessage({ type: 'cancelQueue' }, 'tab-1');

        expect(tab.queuedMessages).toEqual([]);
        expect(tab.queuedMessages).not.toBe(queueBeforeCancel);
        expect(controller.sendStateSync).toHaveBeenCalledTimes(6);
        expect(controller.sendStateSync).toHaveBeenCalledWith('tab-1');
    });

    it('rejects an empty /name command without capturing similar prompts', async () => {
        const prompt = vi.fn(async () => undefined);
        const postForTab = vi.fn();
        const tab = createPromptTab({ setSessionName: vi.fn(), prompt });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
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
        expect(prompt).toHaveBeenCalledOnce();
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
        controller._tabs = createTabRegistry([tab]);
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
        controller._tabs = createTabRegistry([]);

        await expect(controller.handleMessage({ type: 'abort' }, 'missing-tab')).resolves.toEqual({
            ok: false,
            code: 'tab_not_found',
            message: 'Chat tab not found: missing-tab',
        });
    });

    it('returns command_failed while preserving the existing error event', async () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([{
            id: 'tab-1',
            session: { abort: vi.fn().mockRejectedValue(new Error('Abort failed')) },
        }], 'tab-1');
        controller._chatService = new ChatService({ now: () => 0 });
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

function createTabRegistry(tabs: any[], activeId?: string): TabRegistry<any> {
    const registry = new TabRegistry<any>();
    for (const tab of tabs) registry.register(tab);
    if (activeId) registry.activate(activeId);
    return registry;
}

function createPromptTab(session: Record<string, unknown>): any {
    return new TabRuntime<any, any, any>({
        id: 'tab-1',
        session: { dispose: vi.fn(), ...session },
        diffManager: {
            fileChanges: [],
            setCurrentTurn: vi.fn(),
            discardSuspended: vi.fn(),
            dispose: vi.fn(),
        },
        checkpointManager: {
            rollbackPoint: null,
            startTurn: vi.fn(),
            discardSuspended: vi.fn(),
            dispose: vi.fn(),
        },
    });
}
