import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { ChatService } from '../../../core/chat/chat-service';
import { TabRuntime } from '../../../core/chat/tab-runtime';
import { EventRouter } from '../../../pi/events';

interface FakeSession {
    readonly events: EventRouter;
    readonly prompts: string[];
    readonly todoStore: { subscribe(listener: () => void): () => void };
    readonly session: undefined;
    readonly sessionPath: undefined;
    prompt(text: string): Promise<void>;
    compact(instructions?: string): Promise<void>;
    getMessages(): any[];
    getCurrentModel(): undefined;
    serializeState(): any;
    setSubagentParentTabId(tabId: string): void;
    onSubagentStateChanged(listener: () => void): { dispose(): void };
    onSubagentMutation(listener: () => void): { dispose(): void };
    onSubagentNotification(listener: () => void): { dispose(): void };
    waitForNextPrompt(): Promise<string>;
    markIdle(): void;
    failNextPromptBeforeStart(): void;
    failNextPromptAfterStart(): void;
    dispose(): Promise<void>;
}

describe('ChatController queued messages', () => {
    const originalCacheRetention = process.env.PI_CACHE_RETENTION;
    let controller: any;

    afterEach(() => {
        if (controller) {
            for (const tab of controller._tabs.values()) tab.unsubscribe();
            controller = undefined;
        }
        if (originalCacheRetention === undefined) delete process.env.PI_CACHE_RETENTION;
        else process.env.PI_CACHE_RETENTION = originalCacheRetention;
    });

    it('waits for agent_settled before dispatching one FIFO message without consuming another tab queue', async () => {
        controller = createControllerHarness();
        const firstTab = createTab('tab-a');
        const secondTab = createTab('tab-b');
        controller._tabs.set(firstTab.id, firstTab);
        controller._tabs.set(secondTab.id, secondTab);
        controller._subscribeTab(firstTab);
        controller._subscribeTab(secondTab);

        await controller.handleMessage({ type: 'queueMessage', text: 'a-1' }, firstTab.id);
        await controller.handleMessage({ type: 'queueMessage', text: 'a-2' }, firstTab.id);
        await controller.handleMessage({ type: 'queueMessage', text: 'b-1' }, secondTab.id);

        expect(firstTab.session.prompts).toEqual([]);
        expect(secondTab.session.prompts).toEqual([]);
        expect(firstTab.queuedMessages).toEqual(['a-1', 'a-2']);
        expect(secondTab.queuedMessages).toEqual(['b-1']);

        firstTab.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(firstTab.isStreamingLocal).toBe(false));
        expect(firstTab.queuedMessages).toEqual(['a-1', 'a-2']);
        expect(firstTab.session.prompts).toEqual([]);

        const firstPrompt = firstTab.session.waitForNextPrompt();
        firstTab.session.markIdle();
        firstTab.session.events.dispatch({ type: 'agent_settled' } as any);
        await expect(firstPrompt).resolves.toBe('a-1');
        expect(firstTab.queuedMessages).toEqual(['a-2']);
        expect(secondTab.queuedMessages).toEqual(['b-1']);
        expect(secondTab.session.prompts).toEqual([]);

        firstTab.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(firstTab.isStreamingLocal).toBe(false));
        expect(firstTab.queuedMessages).toEqual(['a-2']);

        const secondPrompt = firstTab.session.waitForNextPrompt();
        firstTab.session.markIdle();
        firstTab.session.events.dispatch({ type: 'agent_settled' } as any);
        await expect(secondPrompt).resolves.toBe('a-2');
        expect(firstTab.queuedMessages).toEqual([]);
        expect(secondTab.queuedMessages).toEqual(['b-1']);

        secondTab.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(secondTab.isStreamingLocal).toBe(false));
        expect(secondTab.queuedMessages).toEqual(['b-1']);

        const otherTabPrompt = secondTab.session.waitForNextPrompt();
        secondTab.session.markIdle();
        secondTab.session.events.dispatch({ type: 'agent_settled' } as any);
        await expect(otherTabPrompt).resolves.toBe('b-1');
        expect(secondTab.queuedMessages).toEqual([]);

        expect(firstTab.session.prompts).toEqual(['a-1', 'a-2']);
        expect(secondTab.session.prompts).toEqual(['b-1']);
        expect(firstTab.checkpointManager.startTurn.mock.calls).toEqual([[1], [2]]);
        expect(secondTab.checkpointManager.startTurn.mock.calls).toEqual([[1]]);
    });

    it('reserves the tab while queued file mentions are prepared', async () => {
        controller = createControllerHarness();
        const tab = createTab('tab-a');
        controller._tabs.set(tab.id, tab);
        controller._subscribeTab(tab);

        let finishAugmentation!: (text: string) => void;
        const augmentation = new Promise<string>((resolve) => { finishAugmentation = resolve; });
        controller._fileMentions.augmentPromptIfNeeded = vi.fn(() => augmentation);

        await controller.handleMessage({ type: 'queueMessage', text: 'read @slow-file' }, tab.id);
        tab.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(tab.isStreamingLocal).toBe(false));
        controller.sendStateSync.mockClear();
        tab.session.markIdle();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        await vi.waitFor(() => expect(controller._fileMentions.augmentPromptIfNeeded).toHaveBeenCalledOnce());
        expect(controller.sendStateSync).toHaveBeenCalledWith(tab.id);
        expect(tab.isStreamingLocal).toBe(true);
        expect(tab.queuedMessages).toEqual(['read @slow-file']);

        await controller.handleMessage({ type: 'queueMessage', text: 'second task' }, tab.id);
        const nextPrompt = tab.session.waitForNextPrompt();
        finishAugmentation('read expanded file');

        await expect(nextPrompt).resolves.toBe('read expanded file');
        expect(tab.queuedMessages).toEqual(['second task']);
        expect(tab.checkpointManager.startTurn).toHaveBeenCalledOnce();
    });

    it('restores only prompts rejected before agent_start', async () => {
        controller = createControllerHarness();
        const beforeStart = createTab('tab-a');
        const afterStart = createTab('tab-b');
        controller._tabs.set(beforeStart.id, beforeStart);
        controller._tabs.set(afterStart.id, afterStart);
        controller._subscribeTab(beforeStart);
        controller._subscribeTab(afterStart);

        beforeStart.session.failNextPromptBeforeStart();
        await controller.handleMessage({ type: 'queueMessage', text: 'retry me' }, beforeStart.id);
        beforeStart.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(beforeStart.isStreamingLocal).toBe(false));
        beforeStart.session.markIdle();
        beforeStart.session.events.dispatch({ type: 'agent_settled' } as any);
        await vi.waitFor(() => expect(beforeStart.queuedMessages).toEqual(['retry me']));
        await vi.waitFor(() => expect(beforeStart.isStreamingLocal).toBe(false));

        afterStart.session.failNextPromptAfterStart();
        await controller.handleMessage({ type: 'queueMessage', text: 'do not duplicate' }, afterStart.id);
        afterStart.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(afterStart.isStreamingLocal).toBe(false));
        afterStart.session.markIdle();
        afterStart.session.events.dispatch({ type: 'agent_settled' } as any);
        await vi.waitFor(() => expect(controller._outputChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('[queued prompt error] failed after agent_start'),
        ));
        expect(afterStart.queuedMessages).toEqual([]);
    });

    it('continues to the next queued prompt after queued compaction finishes', async () => {
        controller = createControllerHarness();
        const tab = createTab('tab-a');
        controller._tabs.set(tab.id, tab);
        controller._subscribeTab(tab);

        await controller.handleMessage({ type: 'queueMessage', text: '/compact focus on tests' }, tab.id);
        await controller.handleMessage({ type: 'queueMessage', text: 'continue after compact' }, tab.id);
        tab.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(tab.isStreamingLocal).toBe(false));
        const nextPrompt = tab.session.waitForNextPrompt();
        tab.session.markIdle();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);

        await expect(nextPrompt).resolves.toBe('continue after compact');
        expect(tab.session.compact).toHaveBeenCalledWith('focus on tests');
        expect(tab.queuedMessages).toEqual([]);
    });

    it('waits for a slow agent_end reducer when the SDK settles first', async () => {
        controller = createControllerHarness();
        const tab = createTab('tab-a');
        tab.codexTurnModelId = 'codex-model';
        controller._tabs.set(tab.id, tab);
        controller._subscribeTab(tab);

        let finishAccounting!: () => void;
        const accounting = new Promise<void>((resolve) => { finishAccounting = resolve; });
        controller._refreshCodexUsageForTab = vi.fn(() => accounting);

        await controller.handleMessage({ type: 'queueMessage', text: 'after accounting' }, tab.id);
        const nextPrompt = tab.session.waitForNextPrompt();
        tab.session.events.dispatch({ type: 'agent_end' } as any);
        await vi.waitFor(() => expect(controller._refreshCodexUsageForTab).toHaveBeenCalledOnce());

        tab.session.markIdle();
        tab.session.events.dispatch({ type: 'agent_settled' } as any);
        await vi.waitFor(() => expect(tab.queuedMessages).toEqual(['after accounting']));
        expect(tab.session.prompts).toEqual([]);
        expect(tab.isStreamingLocal).toBe(true);

        finishAccounting();
        await expect(nextPrompt).resolves.toBe('after accounting');
        expect(tab.queuedMessages).toEqual([]);
        expect(tab.checkpointManager.startTurn).toHaveBeenCalledOnce();
    });
});

function createControllerHarness(): any {
    const controller = Object.create(ChatController.prototype) as any;
    controller._tabs = new Map();
    controller._activeTabId = 'tab-a';
    controller._sinks = new Set();
    controller._cacheMode = 'short';
    controller._subagentSmokeSnapshot = undefined;
    controller._outputChannel = { appendLine: vi.fn() };
    controller._context = {
        workspaceState: { get: vi.fn(), update: vi.fn(async () => undefined) },
        globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
    };
    controller._onLauncherStateChanged = { fire: vi.fn() };
    controller._chatService = new ChatService({ now: () => Date.now() });
    controller._fileMentions = { augmentPromptIfNeeded: async (text: string) => text };
    controller._applyPersistedToolSelection = vi.fn();
    controller._persistTabs = vi.fn();
    controller._logPromptToolState = vi.fn();
    controller._sweepPendingTools = vi.fn();
    controller.sendStateSync = vi.fn();
    return controller;
}

function createTab(id: string): any {
    const diffManager = {
        fileChanges: [],
        onFileChange: () => () => undefined,
        setCurrentTurn: vi.fn(),
        discardSuspended: vi.fn(),
        dispose: vi.fn(),
    };
    const checkpointManager = {
        rollbackPoint: null,
        startTurn: vi.fn(),
        discardSuspended: vi.fn(),
        dispose: vi.fn(),
    };
    const tab = new TabRuntime({
        id,
        session: createFakeSession(),
        diffManager,
        checkpointManager,
    });
    tab.isStreamingLocal = true;
    return tab;
}

function createFakeSession(): FakeSession {
    const promptWaiters: Array<(text: string) => void> = [];
    const prompts: string[] = [];
    const events = new EventRouter();
    let isBusy = true;
    let promptFailure: 'before-start' | 'after-start' | undefined;
    const disposable = { dispose(): void {} };

    return {
        events,
        prompts,
        todoStore: { subscribe: () => () => undefined },
        session: undefined,
        sessionPath: undefined,
        async prompt(text: string): Promise<void> {
            if (isBusy) {
                throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
            }
            if (promptFailure === 'before-start') {
                promptFailure = undefined;
                throw new Error('failed before agent_start');
            }
            isBusy = true;
            if (promptFailure === 'after-start') {
                promptFailure = undefined;
                events.dispatch({ type: 'agent_start' } as any);
                isBusy = false;
                throw new Error('failed after agent_start');
            }
            prompts.push(text);
            promptWaiters.shift()?.(text);
        },
        compact: vi.fn(async () => undefined),
        getMessages: () => [],
        getCurrentModel: () => undefined,
        serializeState: () => ({ messages: [], isStreaming: isBusy }),
        setSubagentParentTabId: vi.fn(),
        onSubagentStateChanged: () => disposable,
        onSubagentMutation: () => disposable,
        onSubagentNotification: () => disposable,
        waitForNextPrompt(): Promise<string> {
            return new Promise(resolve => promptWaiters.push(resolve));
        },
        markIdle(): void {
            isBusy = false;
        },
        failNextPromptBeforeStart(): void {
            promptFailure = 'before-start';
        },
        failNextPromptAfterStart(): void {
            promptFailure = 'after-start';
        },
        dispose: vi.fn(async () => undefined),
    };
}
