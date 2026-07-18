import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../../../../core/chat/chat-service';
import { TabRuntime } from '../../../../core/chat/tab-runtime';
import type { CodexTurnUsage, SerializedAgentState, TabInfo } from '../../../../shared/agent-protocol';

class FakeSession {
    readonly markTurnStarted = vi.fn();
    readonly markTurnCompleted = vi.fn();
    sessionPath = '/sessions/chat.jsonl';
    session: { sessionName?: string } | undefined;
    messages: any[] = [];

    serializeState(): SerializedAgentState {
        return {
            messages: [...this.messages],
            isStreaming: true,
            tools: ['read'],
            sessionId: 'session-1',
        };
    }

    getMessages(): any[] {
        return this.messages;
    }

    dispose(): void {}
}

function createTab() {
    const session = new FakeSession();
    const diffManager = {
        fileChanges: [{
            filePath: 'src/main.ts',
            toolCallId: 'tool-1',
            toolName: 'edit',
            isNew: false,
            addedLines: 1,
            removedLines: 0,
            turnIndex: 1,
        }],
        setCurrentTurn: vi.fn(),
        discardSuspended: vi.fn(),
        dispose(): void {},
    };
    const checkpointManager = {
        rollbackPoint: 1 as number | null,
        startTurn: vi.fn(),
        discardSuspended: vi.fn(function (this: { rollbackPoint: number | null }) {
            this.rollbackPoint = null;
        }),
        dispose(): void {},
    };
    return new TabRuntime({ id: 'tab-1', session, diffManager, checkpointManager });
}

describe('portable ChatService event and state projection', () => {
    it('builds the complete serialized chat state without owning transport', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        tab.session.messages = [
            { role: 'user', content: 'task' },
            { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ];
        tab.isStreamingLocal = false;
        tab.isCompacting = true;
        tab.suspendedMessages = [
            { role: 'assistant', content: [{ type: 'text', text: 'suspended' }] },
        ];
        tab.streamingText = 'draft';
        tab.streamingThinking = 'reasoning';
        tab.isThinking = true;
        tab.thinkingStartTime = 123;
        tab.streamingThinkingDuration = 4;
        tab.queuedMessages = ['next'];
        tab.messageMeta.set(0, {
            thinkingDurationSec: 4,
            messageEndTime: 456,
            turnDurationMs: 700,
            totalTurnDurationMs: 900,
        });
        tab.messageMeta.set(1, {
            thinkingDurationSec: 2,
            messageEndTime: 789,
            codexTurn: {
                capturedAt: 800,
                primary: { beforePercent: 1, afterPercent: 2, deltaPercent: 1 },
            },
        });
        const tabs: TabInfo[] = [{
            id: 'tab-1', name: 'Chat', isActive: true, isStreaming: true, hasNotification: false,
        }];

        const state = service.buildState(tab, {
            activeTabId: 'tab-1',
            getTabs: () => tabs,
            cacheMode: 'auto',
            getCacheEffective: () => 'long',
            getFileUndoViewEnabled: () => true,
        });

        expect(state).toMatchObject({
            isStreaming: false,
            isCompacting: true,
            fileChanges: tab.diffManager.fileChanges,
            rollbackPoint: 1,
            tabs,
            activeTabId: 'tab-1',
            sessionPath: '/sessions/chat.jsonl',
            streamingText: 'draft',
            streamingThinking: 'reasoning',
            isThinking: true,
            thinkingStartTime: 123,
            streamingThinkingDuration: 4,
            queuedMessages: ['next'],
            cacheMode: 'auto',
            cacheEffective: 'long',
            fileUndoViewEnabled: true,
        });
        expect(state.messages).toHaveLength(3);
        expect(state.messages[1]).toMatchObject({
            _thinkingDurationSec: 4,
            _messageEndTime: 456,
            _turnDurationMs: 700,
            _totalTurnDurationMs: 900,
        });
        expect(state.messages[2]).toMatchObject({
            _thinkingDurationSec: 2,
            _messageEndTime: 789,
            _codexTurnUsage: { capturedAt: 800 },
        });
        expect(tab.cacheEffective).toBe('long');
    });

    it('reduces streaming events with a deterministic clock and resets buffers at message end', () => {
        const now = vi.fn()
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(2000)
            .mockReturnValueOnce(3000)
            .mockReturnValueOnce(6600)
            .mockReturnValueOnce(7000);
        const service = new ChatService({ now });
        const tab = createTab();
        tab.turnNotificationGate.arm();

        service.reduceEvent(tab, { type: 'agent_start' });
        expect(tab.session.markTurnStarted).not.toHaveBeenCalled();
        expect(tab.isStreamingLocal).toBe(true);
        expect(tab.agentStartTime).toBe(1000);

        service.reduceEvent(tab, {
            type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read',
        });
        expect(tab.pendingTools.get('call-1')).toEqual({ name: 'read', startTime: 2000 });
        service.reduceEvent(tab, { type: 'tool_execution_end', toolCallId: 'call-1' });
        expect(tab.pendingTools.size).toBe(0);

        service.reduceEvent(tab, {
            type: 'message_update', assistantMessageEvent: { type: 'thinking_start' },
        });
        service.reduceEvent(tab, {
            type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'why' },
        });
        service.reduceEvent(tab, {
            type: 'message_update', assistantMessageEvent: { type: 'thinking_end' },
        });
        service.reduceEvent(tab, {
            type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' },
        });
        expect(tab.streamingThinking).toBe('why');
        expect(tab.streamingText).toBe('answer');
        expect(tab.streamingThinkingDuration).toBe(4);

        tab.session.messages = [{ role: 'assistant', content: [] }];
        service.reduceEvent(tab, { type: 'message_end', message: { role: 'assistant' } });
        expect(tab.messageMeta.get(0)).toMatchObject({
            thinkingDurationSec: 4,
            messageEndTime: 7000,
        });
        expect(tab.streamingText).toBe('');
        expect(tab.streamingThinking).toBe('');
        expect(tab.isThinking).toBe(false);
    });

    it('finalizes agent-end metadata in two phases and settles one armed completion', () => {
        const service = new ChatService({ now: () => 7000 });
        const tab = createTab();
        tab.name = 'Portable chat';
        tab.session.messages = [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }];
        tab.turnNotificationGate.arm();
        service.reduceEvent(tab, { type: 'agent_start' });
        tab.agentStartTime = 1000;
        tab.streamingText = 'done';
        tab.streamingThinking = 'thought';
        tab.isThinking = true;

        const end = service.beginAgentEnd(tab, 'completed');
        const codexTurn: CodexTurnUsage = {
            capturedAt: 6900,
            primary: { beforePercent: 10, afterPercent: 12, deltaPercent: 2 },
        };
        service.completeAgentEnd(tab, end, codexTurn);

        expect(end).toEqual({ turnEndAt: 7000, turnDurationMs: 6000 });
        expect(tab.messageMeta.get(0)).toMatchObject({
            codexTurn,
            turnDurationMs: 6000,
            totalTurnDurationMs: 6000,
        });
        expect(tab.isStreamingLocal).toBe(false);
        expect(tab.lastTurnEndAt).toBe(7000);
        expect(service.settleAgent(tab)).toEqual({
            tabName: 'Portable chat',
            outcome: 'completed',
            durationMs: 6000,
        });
        expect(service.settleAgent(tab)).toBeUndefined();
    });

    it('derives names from persisted session metadata before the first user message', () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.session.messages = [{ role: 'user', content: 'first user request' }];

        expect(service.updateTabName(tab)).toEqual({ changed: true, name: 'first user request' });
        expect(service.updateTabName(tab)).toEqual({ changed: false, name: 'first user request' });

        tab.session.session = { sessionName: 'Persisted name' };
        expect(service.updateTabName(tab)).toEqual({ changed: true, name: 'Persisted name' });
    });
});

function createQueueCallbacks(overrides: Record<string, unknown> = {}): any {
    return {
        augmentPrompt: vi.fn(async (text: string) => text),
        compact: vi.fn(async () => undefined),
        prompt: vi.fn(async (_text: string, onAgentStart: () => void) => onAgentStart()),
        isSessionStreaming: vi.fn(() => false),
        prepareRequest: vi.fn(),
        logQueuedPrompt: vi.fn(),
        publishState: vi.fn(),
        reportError: vi.fn(),
        ...overrides,
    };
}

describe('portable ChatService queue orchestration', () => {
    it('reserves only a tab with a queued head', () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = [];
        tab.isStreamingLocal = false;

        expect(service.reserveQueuedDispatch(tab)).toBe(false);
        expect(tab.isStreamingLocal).toBe(false);

        tab.queuedMessages.push('next');
        expect(service.reserveQueuedDispatch(tab)).toBe(true);
        expect(tab.isStreamingLocal).toBe(true);
        expect(tab.queuedMessages).toEqual(['next']);
    });

    it('prepares and starts one queued prompt in the existing operation order', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['read @file'];
        tab.suspendedMessages = [{ role: 'assistant', content: 'old branch' }];
        const order: string[] = [];
        tab.checkpointManager.discardSuspended.mockImplementation(() => {
            order.push('discard-checkpoint');
            tab.checkpointManager.rollbackPoint = null;
        });
        tab.diffManager.discardSuspended.mockImplementation(() => order.push('discard-diff'));
        tab.checkpointManager.startTurn.mockImplementation(() => order.push('start-checkpoint'));
        tab.diffManager.setCurrentTurn.mockImplementation(() => order.push('start-diff'));
        const callbacks = createQueueCallbacks({
            augmentPrompt: vi.fn(async () => {
                order.push('augment');
                return 'read expanded file';
            }),
            prepareRequest: vi.fn(() => order.push('prepare-cache')),
            logQueuedPrompt: vi.fn(() => order.push('log-tools')),
            publishState: vi.fn(() => order.push('publish')),
            prompt: vi.fn(async (text: string, onAgentStart: () => void) => {
                order.push(`prompt:${text}`);
                onAgentStart();
            }),
        });

        service.reserveQueuedDispatch(tab);
        await service.dispatchNextQueued(tab, callbacks);

        expect(order).toEqual([
            'augment',
            'discard-checkpoint',
            'discard-diff',
            'start-checkpoint',
            'start-diff',
            'prepare-cache',
            'log-tools',
            'publish',
            'prompt:read expanded file',
        ]);
        expect(tab.queuedMessages).toEqual([]);
        expect(tab.suspendedMessages).toEqual([]);
        expect(tab.turnCounter).toBe(1);
        expect(tab.checkpointManager.startTurn).toHaveBeenCalledWith(1);
        expect(tab.diffManager.setCurrentTurn).toHaveBeenCalledWith(1);
    });

    it('restores only a queued prompt rejected before agent_start', async () => {
        const service = new ChatService({ now: () => 0 });
        const beforeStart = createTab();
        beforeStart.queuedMessages = ['retry raw text'];
        const beforeError = new Error('before start');
        const beforeCallbacks = createQueueCallbacks({
            augmentPrompt: vi.fn(async () => 'augmented retry'),
            prompt: vi.fn(async () => { throw beforeError; }),
        });

        service.reserveQueuedDispatch(beforeStart);
        await service.dispatchNextQueued(beforeStart, beforeCallbacks);
        await vi.waitFor(() => expect(beforeStart.queuedMessages).toEqual(['retry raw text']));
        expect(beforeCallbacks.reportError).toHaveBeenCalledWith(beforeError);
        expect(beforeStart.isStreamingLocal).toBe(false);
        expect(beforeCallbacks.publishState).toHaveBeenCalled();

        const afterStart = createTab();
        afterStart.queuedMessages = ['do not restore'];
        const afterError = new Error('after start');
        const afterCallbacks = createQueueCallbacks({
            prompt: vi.fn(async (_text: string, onAgentStart: () => void) => {
                onAgentStart();
                throw afterError;
            }),
        });

        service.reserveQueuedDispatch(afterStart);
        await service.dispatchNextQueued(afterStart, afterCallbacks);
        await vi.waitFor(() => expect(afterCallbacks.reportError).toHaveBeenCalledWith(afterError));
        expect(afterStart.queuedMessages).toEqual([]);
        expect(afterStart.isStreamingLocal).toBe(true);
    });

    it('completes queued compaction before reserving and dispatching the next head', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['/compact focus on tests', 'continue'];
        const publishedStreaming: boolean[] = [];
        const callbacks = createQueueCallbacks({
            augmentPrompt: vi.fn(async (text: string) => `augmented ${text}`),
            publishState: vi.fn(() => publishedStreaming.push(tab.isStreamingLocal)),
        });

        service.reserveQueuedDispatch(tab);
        await service.dispatchNextQueued(tab, callbacks);

        expect(callbacks.compact).toHaveBeenCalledWith('focus on tests');
        expect(callbacks.augmentPrompt).toHaveBeenCalledWith('continue');
        expect(callbacks.prompt).toHaveBeenCalledWith('augmented continue', expect.any(Function));
        expect(tab.queuedMessages).toEqual([]);
        expect(publishedStreaming).toEqual([false, true, true]);
    });

    it('restarts preparation from the current head when controls change during augmentation', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['stale head'];
        let finishStale!: (text: string) => void;
        const staleAugmentation = new Promise<string>((resolve) => { finishStale = resolve; });
        const callbacks = createQueueCallbacks({
            augmentPrompt: vi.fn((text: string) => text === 'stale head'
                ? staleAugmentation
                : Promise.resolve(`augmented ${text}`)),
        });

        service.reserveQueuedDispatch(tab);
        const dispatch = service.dispatchNextQueued(tab, callbacks);
        await vi.waitFor(() => expect(callbacks.augmentPrompt).toHaveBeenCalledWith('stale head'));
        tab.queuedMessages[0] = 'current head';
        finishStale('stale expansion');
        await dispatch;

        expect(callbacks.augmentPrompt).toHaveBeenNthCalledWith(2, 'current head');
        expect(callbacks.prompt).toHaveBeenCalledWith('augmented current head', expect.any(Function));
        expect(callbacks.prompt).not.toHaveBeenCalledWith('stale expansion', expect.any(Function));
    });

    it('keeps the raw head and publishes an idle state when augmentation fails', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['read @missing'];
        tab.isStreamingLocal = true;
        const error = new Error('index failed');
        const callbacks = createQueueCallbacks({
            augmentPrompt: vi.fn(async () => { throw error; }),
        });

        await service.dispatchNextQueued(tab, callbacks);

        expect(tab.queuedMessages).toEqual(['read @missing']);
        expect(tab.isStreamingLocal).toBe(false);
        expect(callbacks.reportError).toHaveBeenCalledWith(error);
        expect(callbacks.publishState).toHaveBeenCalledOnce();
        expect(callbacks.prompt).not.toHaveBeenCalled();
    });
});
