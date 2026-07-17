import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { EventRouter } from '../../../pi/events';
import { TurnNotificationGate } from '../../../notifications/turn-notification-gate';

interface FakeSession {
    readonly events: EventRouter;
    readonly prompts: string[];
    readonly todoStore: { subscribe(listener: () => void): () => void };
    readonly session: undefined;
    readonly sessionPath: undefined;
    prompt(text: string): Promise<void>;
    getMessages(): any[];
    getCurrentModel(): undefined;
    serializeState(): any;
    setSubagentParentTabId(tabId: string): void;
    onSubagentStateChanged(listener: () => void): { dispose(): void };
    onSubagentMutation(listener: () => void): { dispose(): void };
    onSubagentNotification(listener: () => void): { dispose(): void };
    waitForNextPrompt(): Promise<string>;
}

describe('ChatController queued messages', () => {
    const originalCacheRetention = process.env.PI_CACHE_RETENTION;
    let controller: any;

    afterEach(() => {
        if (controller) {
            for (const tabId of controller._tabs.keys()) controller._unsubscribeTab(tabId);
            controller = undefined;
        }
        if (originalCacheRetention === undefined) delete process.env.PI_CACHE_RETENTION;
        else process.env.PI_CACHE_RETENTION = originalCacheRetention;
    });

    it('dispatches one FIFO message on agent_end without consuming another tab queue', async () => {
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

        const firstPrompt = firstTab.session.waitForNextPrompt();
        firstTab.session.events.dispatch({ type: 'agent_end' } as any);
        await expect(firstPrompt).resolves.toBe('a-1');
        expect(firstTab.queuedMessages).toEqual(['a-2']);
        expect(secondTab.queuedMessages).toEqual(['b-1']);
        expect(secondTab.session.prompts).toEqual([]);

        const secondPrompt = firstTab.session.waitForNextPrompt();
        firstTab.session.events.dispatch({ type: 'agent_end' } as any);
        await expect(secondPrompt).resolves.toBe('a-2');
        expect(firstTab.queuedMessages).toEqual([]);
        expect(secondTab.queuedMessages).toEqual(['b-1']);

        const otherTabPrompt = secondTab.session.waitForNextPrompt();
        secondTab.session.events.dispatch({ type: 'agent_end' } as any);
        await expect(otherTabPrompt).resolves.toBe('b-1');
        expect(secondTab.queuedMessages).toEqual([]);

        expect(firstTab.session.prompts).toEqual(['a-1', 'a-2']);
        expect(secondTab.session.prompts).toEqual(['b-1']);
        expect(firstTab.checkpointManager.startTurn.mock.calls).toEqual([[1], [2]]);
        expect(secondTab.checkpointManager.startTurn.mock.calls).toEqual([[1]]);
    });
});

function createControllerHarness(): any {
    const controller = Object.create(ChatController.prototype) as any;
    controller._tabs = new Map();
    controller._activeTabId = 'tab-a';
    controller._tabSubscriptions = new Map();
    controller._sinks = new Set();
    controller._cacheMode = 'short';
    controller._subagentSmokeSnapshot = undefined;
    controller._outputChannel = { appendLine: vi.fn() };
    controller._context = {
        workspaceState: { get: vi.fn(), update: vi.fn(async () => undefined) },
        globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
    };
    controller._onLauncherStateChanged = { fire: vi.fn() };
    controller._fileMentions = { augmentPromptIfNeeded: async (text: string) => text };
    controller._applyPersistedToolSelection = vi.fn();
    controller._persistTabs = vi.fn();
    controller._logPromptToolState = vi.fn();
    controller._sweepPendingTools = vi.fn();
    controller.sendStateSync = vi.fn();
    return controller;
}

function createTab(id: string): any {
    const session = createFakeSession();
    return {
        id,
        name: 'New Agent',
        session,
        diffManager: {
            fileChanges: [],
            onFileChange: () => () => undefined,
            setCurrentTurn: vi.fn(),
            discardSuspended: vi.fn(),
        },
        checkpointManager: {
            rollbackPoint: null,
            startTurn: vi.fn(),
            discardSuspended: vi.fn(),
        },
        turnCounter: 0,
        suspendedMessages: [],
        streamingText: '',
        streamingThinking: '',
        isThinking: false,
        thinkingStartTime: 0,
        streamingThinkingDuration: 0,
        agentStartTime: 0,
        totalTurnDurationMs: 0,
        messageMeta: new Map(),
        turnNotificationGate: new TurnNotificationGate(),
        hasNotification: false,
        queuedMessages: [],
        isStreamingLocal: true,
        isCompacting: false,
        errorReportedThisRun: false,
        lastTurnEndAt: 0,
        maxIdleGapMs: 0,
        cacheEffective: 'short',
        pendingTools: new Map(),
    };
}

function createFakeSession(): FakeSession {
    const promptWaiters: Array<(text: string) => void> = [];
    const prompts: string[] = [];
    const events = new EventRouter();
    const disposable = { dispose(): void {} };

    return {
        events,
        prompts,
        todoStore: { subscribe: () => () => undefined },
        session: undefined,
        sessionPath: undefined,
        async prompt(text: string): Promise<void> {
            prompts.push(text);
            promptWaiters.shift()?.(text);
        },
        getMessages: () => [],
        getCurrentModel: () => undefined,
        serializeState: () => ({ messages: [], isStreaming: false }),
        setSubagentParentTabId: vi.fn(),
        onSubagentStateChanged: () => disposable,
        onSubagentMutation: () => disposable,
        onSubagentNotification: () => disposable,
        waitForNextPrompt(): Promise<string> {
            return new Promise(resolve => promptWaiters.push(resolve));
        },
    };
}
