import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../../../../core/chat/chat-service';
import { TabRuntime } from '../../../../core/chat/tab-runtime';
import type { CodexTurnUsage, SerializedAgentState, TabInfo } from '../../../../shared/agent-protocol';
import { isServerMessage } from '../../../../shared/protocol-runtime';

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
        tab.pendingTools.set('tool-1', {
            name: 'bash',
            startTime: 321,
            args: { command: 'sleep 80' },
        });
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
        const controls = {
            todos: { tasks: [{ id: 1, subject: 'Ship controls', status: 'in_progress' as const }], nextId: 2 },
            todoEnabled: true,
            todoToggleDisabled: true,
            planModeEnabled: false,
            planModeToggleDisabled: true,
            subagents: {
                enabled: true, toggleDisabled: true, activeCount: 0, queuedCount: 0, runs: [],
            },
            toolSelection: {
                registered: [{ name: 'read' }], disabled: [], toggleDisabled: true,
            },
        };

        const state = service.buildState(tab, {
            activeTabId: 'tab-1',
            getTabs: () => tabs,
            cacheMode: 'auto',
            getCacheEffective: () => 'long',
            getFileUndoViewEnabled: () => true,
            getControls: () => controls,
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
            controls,
            pendingTools: [{
                toolCallId: 'tool-1',
                toolName: 'bash',
                startTime: 321,
                args: { command: 'sleep 80' },
            }],
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

    it('removes a stale interrupted marker after projecting live streaming state', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        vi.spyOn(tab.session, 'serializeState').mockImplementation(() => ({
            messages: [],
            isStreaming: false,
            tools: [],
            interruptedTurn: { reason: 'incomplete_session_tail' },
        }));
        const context = {
            activeTabId: 'tab-1',
            getTabs: () => [] as TabInfo[],
            cacheMode: 'auto' as const,
            getCacheEffective: () => 'short' as const,
            getFileUndoViewEnabled: () => false,
        };

        tab.isStreamingLocal = true;
        let state = service.buildState(tab, context);
        expect(state).not.toHaveProperty('interruptedTurn');
        expect(isServerMessage({ type: 'stateSync', state })).toBe(true);

        tab.isStreamingLocal = false;
        tab.isCompacting = true;
        state = service.buildState(tab, context);
        expect(state).not.toHaveProperty('interruptedTurn');
        expect(isServerMessage({ type: 'stateSync', state })).toBe(true);

        tab.isCompacting = false;
        state = service.buildState(tab, context);
        expect(state).toHaveProperty('interruptedTurn');
        expect(isServerMessage({ type: 'stateSync', state })).toBe(true);
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
        tab.pendingTools.set('stale-tool', { name: 'bash', startTime: 2000 });

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
        expect(tab.pendingTools.size).toBe(0);
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

function createDirectPromptCallbacks(overrides: Record<string, unknown> = {}): any {
    return {
        decoratePrompt: vi.fn((text: string) => text),
        augmentPrompt: vi.fn(async (text: string) => text),
        compact: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined),
        prepareRequest: vi.fn(),
        logPrompt: vi.fn(),
        publishState: vi.fn(),
        reportDetachedFailure: vi.fn(),
        ...overrides,
    };
}

describe('portable ChatService session and file-history transactions', () => {
    it('resets session projection after clearing file state and seeds persisted user turns', () => {
        const order: string[] = [];
        const service = new ChatService({ now: () => 0 });
        const tab: any = {
            diffManager: { clearAll: vi.fn(() => order.push('clear-diffs')) },
            checkpointManager: { clearAll: vi.fn(() => order.push('clear-checkpoints')) },
            resetSessionProjection: vi.fn(() => order.push('reset-projection')),
        };
        const messages = [
            { role: 'user' },
            { role: 'assistant' },
            { role: 'custom' },
            { role: 'user' },
        ];

        service.resetSessionProjection(tab, undefined, messages);

        expect(order).toEqual(['clear-diffs', 'clear-checkpoints', 'reset-projection']);
        expect(tab.resetSessionProjection).toHaveBeenCalledWith(undefined, 2);
    });

    it('restores and redoes checkpoint state in file, diff, then message order', async () => {
        const service = new ChatService({ now: () => 0 });
        const order: string[] = [];
        const messages = [{ role: 'user' }, { role: 'assistant' }];
        const tab: any = {
            isStreamingLocal: false,
            isCompacting: false,
            suspendedMessages: [],
            checkpointManager: {
                restoreCheckpoint: vi.fn(async () => { order.push('restore-files'); return ['a']; }),
                redoCheckpoint: vi.fn(async () => { order.push('redo-files'); return ['a']; }),
            },
            diffManager: {
                suspendChangesAfter: vi.fn(() => order.push('suspend-diffs')),
                redoChanges: vi.fn(() => order.push('redo-diffs')),
            },
            session: {
                getMessages: vi.fn(() => { order.push('get-messages'); return messages; }),
                setMessages: vi.fn(() => order.push('set-messages')),
            },
        };

        await expect(service.restoreCheckpoint(tab, 0)).resolves.toEqual(['a']);
        expect(order).toEqual(['restore-files', 'suspend-diffs', 'get-messages', 'set-messages']);
        expect(tab.suspendedMessages).toEqual(messages);

        order.length = 0;
        await expect(service.redoCheckpoint(tab)).resolves.toEqual(['a']);
        expect(order).toEqual(['redo-files', 'redo-diffs', 'get-messages', 'set-messages']);
        expect(tab.suspendedMessages).toEqual([]);
    });

    it('rejects file-history transactions while the tab is busy', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab: any = {
            isStreamingLocal: true,
            isCompacting: false,
            checkpointManager: {
                restoreCheckpoint: vi.fn(),
                redoCheckpoint: vi.fn(),
            },
            diffManager: {
                suspendChangesAfter: vi.fn(),
                redoChanges: vi.fn(),
            },
            session: { getMessages: vi.fn(), setMessages: vi.fn() },
            suspendedMessages: [],
        };

        await expect(service.restoreCheckpoint(tab, 0))
            .rejects.toThrow('Wait for the agent to finish before undoing or redoing file changes.');
        await expect(service.redoCheckpoint(tab))
            .rejects.toThrow('Wait for the agent to finish before undoing or redoing file changes.');
        expect(tab.checkpointManager.restoreCheckpoint).not.toHaveBeenCalled();
        expect(tab.checkpointManager.redoCheckpoint).not.toHaveBeenCalled();
    });
});

describe('portable ChatService direct prompt lifecycle', () => {
    it('starts a direct prompt in order and returns without awaiting the model turn', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const order: string[] = [];
        const images = [{ type: 'image', data: 'abc', mimeType: 'image/png' }] as any;
        const files = [{
            type: 'file', data: 'text', mimeType: 'text/plain', name: 'notes.txt', size: 4,
        }] as any;
        let finishTurn!: () => void;
        const turn = new Promise<void>((resolve) => { finishTurn = resolve; });
        let turnSettled = false;
        void turn.then(() => { turnSettled = true; });

        tab.checkpointManager.discardSuspended.mockImplementation(() => {
            order.push('discard-checkpoint');
            tab.checkpointManager.rollbackPoint = null;
        });
        tab.diffManager.discardSuspended.mockImplementation(() => order.push('discard-diff'));
        tab.checkpointManager.startTurn.mockImplementation(() => order.push('start-checkpoint'));
        tab.diffManager.setCurrentTurn.mockImplementation(() => order.push('start-diff'));
        const callbacks = createDirectPromptCallbacks({
            decoratePrompt: vi.fn((text: string) => {
                order.push('decorate');
                return `<plan>${text}</plan>`;
            }),
            prepareRequest: vi.fn(() => order.push('prepare-cache')),
            logPrompt: vi.fn(() => order.push('log-tools')),
            augmentPrompt: vi.fn(async (text: string) => {
                order.push(`augment:${text}`);
                return `${text}\nfiles`;
            }),
            prompt: vi.fn((text: string, passedImages: any, passedFiles: any) => {
                order.push(`prompt:${text}`);
                expect(passedImages).toBe(images);
                expect(passedFiles).toBe(files);
                return turn;
            }),
        });

        const result = await service.dispatchDirectPrompt(tab, {
            text: 'task', images, files,
        }, callbacks);

        expect(result).toEqual({ kind: 'prompt_dispatched' });
        expect(order).toEqual([
            'decorate',
            'discard-checkpoint',
            'discard-diff',
            'start-checkpoint',
            'start-diff',
            'prepare-cache',
            'log-tools',
            'augment:<plan>task</plan>',
            'prompt:<plan>task</plan>\nfiles',
        ]);
        expect(tab.turnCounter).toBe(1);
        expect(tab.checkpointManager.startTurn).toHaveBeenCalledWith(1);
        expect(tab.diffManager.setCurrentTurn).toHaveBeenCalledWith(1);
        expect(turnSettled).toBe(false);
        finishTurn();
        await turn;
    });

    it('reports detached prompt failure after cancelling its notification arm', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const error = new Error('preflight failed');
        let leakedCompletion: unknown;
        const callbacks = createDirectPromptCallbacks({
            prompt: vi.fn(async () => { throw error; }),
            reportDetachedFailure: vi.fn(() => {
                tab.turnNotificationGate.onAgentStart();
                tab.turnNotificationGate.onAgentEnd({
                    tabName: tab.name,
                    outcome: 'completed',
                    durationMs: 1,
                });
                leakedCompletion = tab.turnNotificationGate.onAgentSettled();
            }),
        });

        await expect(service.dispatchDirectPrompt(tab, { text: 'task' }, callbacks)).resolves.toEqual({
            kind: 'prompt_dispatched',
        });
        await vi.waitFor(() => expect(callbacks.reportDetachedFailure).toHaveBeenCalledWith(error));
        expect(leakedCompletion).toBeUndefined();
    });

    it('preserves turn mutations when mention augmentation rejects before prompt dispatch', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const error = new Error('mention indexing failed');
        const callbacks = createDirectPromptCallbacks({
            augmentPrompt: vi.fn(async () => { throw error; }),
        });

        await expect(service.dispatchDirectPrompt(tab, { text: 'read @file' }, callbacks))
            .rejects.toThrow('mention indexing failed');

        expect(tab.turnCounter).toBe(1);
        expect(tab.checkpointManager.startTurn).toHaveBeenCalledWith(1);
        expect(tab.diffManager.setCurrentTurn).toHaveBeenCalledWith(1);
        expect(callbacks.prepareRequest).toHaveBeenCalledOnce();
        expect(callbacks.logPrompt).toHaveBeenCalledOnce();
        expect(callbacks.prompt).not.toHaveBeenCalled();
    });

    it('handles direct compact before decoration or turn mutation and publishes after rejection', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const order: string[] = [];
        const callbacks = createDirectPromptCallbacks({
            prepareRequest: vi.fn(() => order.push('prepare-cache')),
            compact: vi.fn(async () => {
                order.push('compact');
                throw new Error('session too small');
            }),
            publishState: vi.fn(() => order.push('publish')),
        });

        await expect(service.dispatchDirectPrompt(tab, {
            text: '/compact focus on tests',
        }, callbacks)).resolves.toEqual({ kind: 'compacted' });

        expect(order).toEqual(['prepare-cache', 'compact', 'publish']);
        expect(callbacks.prepareRequest).toHaveBeenCalledOnce();
        expect(callbacks.compact).toHaveBeenCalledWith('focus on tests');
        expect(callbacks.publishState).toHaveBeenCalledOnce();
        expect(callbacks.decoratePrompt).not.toHaveBeenCalled();
        expect(callbacks.augmentPrompt).not.toHaveBeenCalled();
        expect(callbacks.prompt).not.toHaveBeenCalled();
        expect(tab.turnCounter).toBe(0);
        expect(tab.checkpointManager.startTurn).not.toHaveBeenCalled();
    });
});

function createStreamingCommandCallbacks(overrides: Record<string, unknown> = {}): any {
    return {
        augmentPrompt: vi.fn(async (text: string) => text),
        prepareRequest: vi.fn(),
        logPrompt: vi.fn(),
        steer: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('portable ChatService streaming command dispatch', () => {
    it('awaits steer acceptance after preserving preparation order and attachments', async () => {
        const service = new ChatService({ now: () => 0 });
        const order: string[] = [];
        const images = [{ type: 'image', data: 'abc', mimeType: 'image/png' }] as any;
        const files = [{
            type: 'file', data: 'text', mimeType: 'text/plain', name: 'notes.txt', size: 4,
        }] as any;
        let acceptSteer!: () => void;
        const steerAcceptance = new Promise<void>((resolve) => { acceptSteer = resolve; });
        let acknowledged = false;
        const callbacks = createStreamingCommandCallbacks({
            prepareRequest: vi.fn(() => order.push('prepare-cache')),
            logPrompt: vi.fn((kind: string) => order.push(`log:${kind}`)),
            augmentPrompt: vi.fn(async (text: string) => {
                order.push(`augment:${text}`);
                return `${text}\nmentions`;
            }),
            steer: vi.fn((text: string, passedImages: any, passedFiles: any) => {
                order.push(`steer:${text}`);
                expect(passedImages).toBe(images);
                expect(passedFiles).toBe(files);
                return steerAcceptance;
            }),
        });

        const dispatch = service.dispatchStreamingCommand({
            type: 'steer', text: 'redirect', images, files,
        }, callbacks).then(() => { acknowledged = true; });

        await vi.waitFor(() => expect(callbacks.steer).toHaveBeenCalledOnce());
        expect(acknowledged).toBe(false);
        expect(order).toEqual([
            'prepare-cache',
            'log:steer',
            'augment:redirect',
            'steer:redirect\nmentions',
        ]);
        expect(callbacks.followUp).not.toHaveBeenCalled();
        expect(callbacks.abort).not.toHaveBeenCalled();

        acceptSteer();
        await dispatch;
        expect(acknowledged).toBe(true);
    });

    it('routes follow-up text and attachments without invoking steer or abort', async () => {
        const service = new ChatService({ now: () => 0 });
        const images = [{ type: 'image', data: 'abc', mimeType: 'image/png' }] as any;
        const files = [{
            type: 'file', data: 'text', mimeType: 'text/plain', name: 'next.txt', size: 4,
        }] as any;
        const callbacks = createStreamingCommandCallbacks({
            augmentPrompt: vi.fn(async () => 'expanded next'),
        });

        await service.dispatchStreamingCommand({
            type: 'followUp', text: 'next', images, files,
        }, callbacks);

        expect(callbacks.prepareRequest).toHaveBeenCalledOnce();
        expect(callbacks.logPrompt).toHaveBeenCalledWith('followUp');
        expect(callbacks.augmentPrompt).toHaveBeenCalledWith('next');
        expect(callbacks.followUp).toHaveBeenCalledWith('expanded next', images, files);
        expect(callbacks.steer).not.toHaveBeenCalled();
        expect(callbacks.abort).not.toHaveBeenCalled();
    });

    it('propagates mention augmentation failure after preparation without session dispatch', async () => {
        const service = new ChatService({ now: () => 0 });
        const error = new Error('mention indexing failed');
        const callbacks = createStreamingCommandCallbacks({
            augmentPrompt: vi.fn(async () => { throw error; }),
        });

        await expect(service.dispatchStreamingCommand({
            type: 'steer', text: 'inspect @missing',
        }, callbacks)).rejects.toThrow('mention indexing failed');

        expect(callbacks.prepareRequest).toHaveBeenCalledOnce();
        expect(callbacks.logPrompt).toHaveBeenCalledWith('steer');
        expect(callbacks.steer).not.toHaveBeenCalled();
        expect(callbacks.followUp).not.toHaveBeenCalled();
        expect(callbacks.abort).not.toHaveBeenCalled();
    });

    it('awaits abort without preparing or augmenting a text request', async () => {
        const service = new ChatService({ now: () => 0 });
        let finishAbort!: () => void;
        const abortCompletion = new Promise<void>((resolve) => { finishAbort = resolve; });
        let acknowledged = false;
        const callbacks = createStreamingCommandCallbacks({
            abort: vi.fn(() => abortCompletion),
        });

        const dispatch = service.dispatchStreamingCommand({ type: 'abort' }, callbacks)
            .then(() => { acknowledged = true; });

        await vi.waitFor(() => expect(callbacks.abort).toHaveBeenCalledOnce());
        expect(acknowledged).toBe(false);
        expect(callbacks.prepareRequest).not.toHaveBeenCalled();
        expect(callbacks.logPrompt).not.toHaveBeenCalled();
        expect(callbacks.augmentPrompt).not.toHaveBeenCalled();
        expect(callbacks.steer).not.toHaveBeenCalled();
        expect(callbacks.followUp).not.toHaveBeenCalled();

        finishAbort();
        await dispatch;
        expect(acknowledged).toBe(true);
    });
});

function createQueueCallbacks(overrides: Record<string, unknown> = {}): any {
    return {
        decoratePrompt: vi.fn((text: string) => text),
        augmentPrompt: vi.fn(async (text: string) => text),
        compact: vi.fn(async () => undefined),
        prompt: vi.fn(async (_text: string, onAgentStart: () => void) => onAgentStart()),
        isSessionStreaming: vi.fn(() => false),
        handleLocalCommand: vi.fn(() => false),
        scheduleRetry: vi.fn(),
        prepareRequest: vi.fn(),
        logQueuedPrompt: vi.fn(),
        publishState: vi.fn(),
        reportError: vi.fn(),
        ...overrides,
    };
}

describe('portable ChatService queue orchestration', () => {
    it('decorates a queued prompt before file-mention augmentation', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['queued task'];
        const callbacks = createQueueCallbacks({
            decoratePrompt: vi.fn((text: string) => `PLAN\n${text}`),
            augmentPrompt: vi.fn(async (text: string) => `FILES\n${text}`),
        });

        service.reserveQueuedDispatch(tab);
        await service.dispatchNextQueued(tab, callbacks);

        expect(callbacks.decoratePrompt).toHaveBeenCalledWith('queued task');
        expect(callbacks.augmentPrompt).toHaveBeenCalledWith('PLAN\nqueued task');
        expect(callbacks.prompt).toHaveBeenCalledWith('FILES\nPLAN\nqueued task', expect.any(Function));
    });

    it('applies validated queue controls to only the supplied tab', () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const otherTab = createTab();
        otherTab.queuedMessages = ['other'];

        expect(service.applyQueueControl(tab, {
            type: 'queueMessage',
            text: '  raw queued text  ',
        })).toEqual({ changed: true, queueLength: 1 });
        expect(tab.queuedMessages).toEqual(['  raw queued text  ']);

        expect(service.applyQueueControl(tab, {
            type: 'editQueuedMessage',
            index: 0,
            text: '  edited text  ',
        })).toEqual({ changed: true, queueLength: 1 });
        expect(tab.queuedMessages).toEqual(['edited text']);

        expect(service.applyQueueControl(tab, {
            type: 'editQueuedMessage',
            index: 0,
            text: '   ',
        })).toEqual({ changed: false, queueLength: 1 });
        expect(service.applyQueueControl(tab, {
            type: 'removeQueuedMessage',
            index: 4,
        })).toEqual({ changed: false, queueLength: 1 });
        expect(service.applyQueueControl(tab, {
            type: 'editQueuedMessage',
            index: 0.5,
            text: 'fractional',
        })).toEqual({ changed: false, queueLength: 1 });
        expect(service.applyQueueControl(tab, {
            type: 'removeQueuedMessage',
            index: 0.5,
        })).toEqual({ changed: false, queueLength: 1 });

        service.applyQueueControl(tab, { type: 'queueMessage', text: 'second' });
        expect(service.applyQueueControl(tab, {
            type: 'removeQueuedMessage',
            index: 0,
        })).toEqual({ changed: true, queueLength: 1 });
        expect(tab.queuedMessages).toEqual(['second']);

        const previousQueue = tab.queuedMessages;
        expect(service.applyQueueControl(tab, { type: 'cancelQueue' })).toEqual({
            changed: true,
            queueLength: 0,
        });
        expect(tab.queuedMessages).toEqual([]);
        expect(tab.queuedMessages).not.toBe(previousQueue);
        expect(otherTab.queuedMessages).toEqual(['other']);
    });

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

    it('leaves an empty dispatch side-effect free', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = [];
        tab.isStreamingLocal = false;
        const callbacks = createQueueCallbacks();

        await service.dispatchNextQueued(tab, callbacks);

        expect(tab.isStreamingLocal).toBe(false);
        expect(callbacks.publishState).not.toHaveBeenCalled();
        expect(callbacks.prompt).not.toHaveBeenCalled();
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

    it('schedules only one automatic retry for a head rejected before agent_start', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['retry once'];
        let scheduledRetry: (() => Promise<void>) | undefined;
        const callbacks = createQueueCallbacks({
            prompt: vi.fn(async () => { throw new Error('preflight rejected'); }),
            scheduleRetry: vi.fn((retry: () => Promise<void>) => { scheduledRetry = retry; }),
        });

        service.reserveQueuedDispatch(tab);
        await service.dispatchNextQueued(tab, callbacks);
        await vi.waitFor(() => expect(scheduledRetry).toBeDefined());
        await scheduledRetry!();
        await vi.waitFor(() => expect(callbacks.prompt).toHaveBeenCalledTimes(2));

        expect(callbacks.scheduleRetry).toHaveBeenCalledOnce();
        expect(tab.queuedMessages).toEqual(['retry once']);
        expect(tab.isStreamingLocal).toBe(false);
    });

    it('consumes an edited queued local command without contacting the model', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.queuedMessages = ['/name Edited queue'];
        const callbacks = createQueueCallbacks({
            handleLocalCommand: vi.fn(() => true),
        });

        service.reserveQueuedDispatch(tab);
        await service.dispatchNextQueued(tab, callbacks);

        expect(callbacks.handleLocalCommand).toHaveBeenCalledWith('/name Edited queue');
        expect(callbacks.augmentPrompt).not.toHaveBeenCalled();
        expect(callbacks.prompt).not.toHaveBeenCalled();
        expect(tab.queuedMessages).toEqual([]);
        expect(tab.isStreamingLocal).toBe(false);
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
        service.applyQueueControl(tab, {
            type: 'editQueuedMessage',
            index: 0,
            text: 'current head',
        });
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
