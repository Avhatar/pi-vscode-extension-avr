import { describe, expect, it, vi } from 'vitest';
import { assistantMetaKey, ChatService } from '../../../../core/chat/chat-service';
import { PLAN_MODE_INSTRUCTIONS } from '../../../../core/chat/chat-preferences';
import { TabRuntime } from '../../../../core/chat/tab-runtime';
import type { CodexTurnUsage, SerializedAgentState, TabInfo } from '../../../../shared/agent-protocol';
import { isServerMessage } from '../../../../shared/protocol-runtime';

class FakeSession {
    readonly markTurnStarted = vi.fn();
    readonly markTurnCompleted = vi.fn();
    sessionPath = '/sessions/chat.jsonl';
    session: { sessionName?: string } | undefined;
    messages: any[] = [];
    transcriptMessages: any[] = [];
    readonly setSessionName = vi.fn((name: string) => {
        this.session = { sessionName: name };
    });

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

    getFirstTranscriptUserMessage(): any | undefined {
        return this.transcriptMessages.find((message) => message.role === 'user');
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
            { role: 'assistant', timestamp: 2001, content: [{ type: 'text', text: 'answer' }] },
        ];
        tab.isStreamingLocal = false;
        tab.isCompacting = true;
        tab.suspendedMessages = [
            { role: 'assistant', timestamp: 2002, content: [{ type: 'text', text: 'suspended' }] },
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
        tab.messageMeta.set('2001', {
            thinkingDurationSec: 4,
            messageEndTime: 456,
            turnDurationMs: 700,
            totalTurnDurationMs: 900,
        });
        tab.messageMeta.set('2002', {
            thinkingDurationSec: 2,
            messageEndTime: 789,
            codexTurn: {
                capturedAt: 800,
                primary: { beforePercent: 1, afterPercent: 2, deltaPercent: 1 },
            },
            deepSeekTurn: {
                turnCost: 0.0042,
                sessionCost: 0.125,
                capturedAt: 801,
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
            _deepSeekTurnUsage: {
                turnCost: 0.0042,
                sessionCost: 0.125,
                capturedAt: 801,
            },
        });
        expect(tab.cacheEffective).toBe('long');
    });

    it('projects turn tool statistics and per-call durations onto the rendered messages', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        const toolResult = {
            role: 'toolResult',
            toolCallId: 'call-7',
            toolName: 'grep',
            content: [{ type: 'text', text: 'hit' }],
        };
        const assistant = {
            role: 'assistant',
            timestamp: 3003,
            content: [{ type: 'text', text: 'done' }],
        };
        tab.session.messages = [{ role: 'user', content: 'task' }, toolResult, assistant];
        vi.spyOn(tab.session, 'serializeState').mockImplementation(() => ({
            messages: tab.session.messages.map((message) => ({ ...message })),
            isStreaming: false,
            tools: [],
            transcript: {
                sessionId: 'session-1',
                items: tab.session.messages.map((message, index) => ({
                    id: `item-${index}`,
                    entryId: `entry-${index}`,
                    message: { ...message },
                })),
                hasMoreBefore: false,
                totalUserMessages: 1,
            },
        }));
        tab.recordToolDuration('call-7', 452_000);
        tab.messageMeta.set(assistantMetaKey(assistant)!, {
            thinkingDurationSec: 0,
            messageEndTime: 900,
            toolStats: [{ name: 'Grep', calls: 2, durationMs: 452_000 }],
        });

        const state = service.buildState(tab, {
            activeTabId: 'tab-1',
            getTabs: () => [] as TabInfo[],
            cacheMode: 'auto',
            getCacheEffective: () => 'short',
            getFileUndoViewEnabled: () => false,
        });

        expect(state.messages[1]).toMatchObject({ _toolDurationMs: 452_000 });
        expect(state.messages[2]).toMatchObject({
            _toolStats: [{ name: 'Grep', calls: 2, durationMs: 452_000 }],
        });
        expect(state.transcript?.items[1].message).toMatchObject({ _toolDurationMs: 452_000 });
        expect(state.transcript?.items[2].message).toMatchObject({
            _toolStats: [{ name: 'Grep', calls: 2, durationMs: 452_000 }],
        });
        expect(isServerMessage({ type: 'stateSync', state })).toBe(true);
    });

    it('keeps turn metadata on the closing assistant after compaction drops it from context', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        // The turn closes with this assistant still in the compact context.
        const closingAssistant = {
            role: 'assistant',
            timestamp: 1_700_000_111,
            content: [{ type: 'text', text: 'done' }],
        };
        const transcriptMessages = [
            { role: 'user', timestamp: 1_700_000_100, content: 'task' },
            closingAssistant,
        ];
        tab.session.messages = [...transcriptMessages];

        service.reduceEvent(tab, { type: 'agent_start' });
        service.reduceEvent(tab, {
            type: 'tool_execution_start', toolCallId: 'c1', toolName: 'grep',
        });
        clock = 453_000;
        service.reduceEvent(tab, {
            type: 'tool_execution_end', toolCallId: 'c1', toolName: 'grep',
        });
        service.reduceEvent(tab, { type: 'message_end', message: closingAssistant });
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        // Auto-compaction rewrites the compact context: the assistant that
        // closed the turn is gone from it, while the transcript keeps the
        // full branch.
        tab.session.messages = [
            { role: 'compactionSummary', timestamp: 1_700_000_200, summary: 'earlier work' },
        ];
        vi.spyOn(tab.session, 'serializeState').mockImplementation(() => ({
            messages: tab.session.messages.map((message) => ({ ...message })),
            isStreaming: false,
            tools: [],
            transcript: {
                sessionId: 'session-1',
                items: transcriptMessages.map((message, index) => ({
                    id: `item-${index}`,
                    entryId: `entry-${index}`,
                    message: { ...message },
                })),
                hasMoreBefore: false,
                totalUserMessages: 1,
            },
        }));

        const state = service.buildState(tab, {
            activeTabId: 'tab-1',
            getTabs: () => [] as TabInfo[],
            cacheMode: 'auto',
            getCacheEffective: () => 'short',
            getFileUndoViewEnabled: () => false,
        });

        expect(state.transcript?.items[1].message).toMatchObject({
            _turnDurationMs: 452_000,
            _messageEndTime: 453_000,
            _toolStats: [{ name: 'Grep', calls: 1, durationMs: 452_000 }],
        });
    });

    it('does not hand one assistant the metadata of an unrelated older turn', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        const firstTurnAssistant = {
            role: 'assistant',
            timestamp: 1_700_000_111,
            content: [{ type: 'text', text: 'first' }],
        };
        const survivingAssistant = {
            role: 'assistant',
            timestamp: 1_700_000_999,
            content: [{ type: 'text', text: 'second' }],
        };
        // Only the first turn ever recorded metadata.
        tab.messageMeta.set(assistantMetaKey(firstTurnAssistant)!, {
            thinkingDurationSec: 0,
            messageEndTime: 900,
            turnDurationMs: 700,
            toolStats: [{ name: 'Grep', calls: 2, durationMs: 452_000 }],
        });
        // Compaction left a different, later assistant at ordinal 0.
        tab.session.messages = [survivingAssistant];
        vi.spyOn(tab.session, 'serializeState').mockImplementation(() => ({
            messages: tab.session.messages.map((message) => ({ ...message })),
            isStreaming: false,
            tools: [],
        }));

        const state = service.buildState(tab, {
            activeTabId: 'tab-1',
            getTabs: () => [] as TabInfo[],
            cacheMode: 'auto',
            getCacheEffective: () => 'short',
            getFileUndoViewEnabled: () => false,
        });

        expect(state.messages[0]).not.toHaveProperty('_toolStats');
        expect(state.messages[0]).not.toHaveProperty('_turnDurationMs');
    });

    it('snapshots per-tool turn totals onto the closing assistant message', () => {
        let clock = 0;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{ role: 'assistant', timestamp: 4001, content: [{ type: 'text', text: 'done' }] }];

        clock = 1000;
        service.reduceEvent(tab, { type: 'agent_start' });
        const calls: Array<{
            toolCallId: string;
            toolName: string;
            durationMs: number;
            args?: Record<string, unknown>;
        }> = [
            { toolCallId: 'a', toolName: 'grep', durationMs: 300_000 },
            { toolCallId: 'b', toolName: 'grep', durationMs: 152_000 },
            {
                toolCallId: 'c',
                toolName: 'mcp',
                durationMs: 30_000,
                args: { server: 'unity', tool: 'read_log' },
            },
        ];
        for (const spec of calls) {
            service.reduceEvent(tab, {
                type: 'tool_execution_start',
                toolCallId: spec.toolCallId,
                toolName: spec.toolName,
                ...(spec.args ? { args: spec.args } : {}),
            });
            clock += spec.durationMs;
            service.reduceEvent(tab, {
                type: 'tool_execution_end',
                toolCallId: spec.toolCallId,
                toolName: spec.toolName,
            });
        }

        const projection = service.beginAgentEnd(tab, 'completed');
        service.completeAgentEnd(tab, projection);

        expect(tab.messageMeta.get('4001')?.toolStats).toEqual([
            { name: 'Grep', calls: 2, durationMs: 452_000 },
            { name: 'MCP unity.read_log', calls: 1, durationMs: 30_000 },
        ]);
        expect(tab.turnToolStats.size).toBe(0);
        expect(tab.toolDurations.get('c')).toBe(30_000);
    });

    it('measures non-tool turn time as a union of intervals, not a sum', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4008, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        // Two overlapping tool calls, as a single assistant message runs them:
        // busy from 3000 to 9000 is 6s of wall clock, while the two 4s
        // durations sum to 8s. Subtracting the sum would understate the wait.
        clock = 3000;
        service.reduceEvent(tab, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash' });
        clock = 5000;
        service.reduceEvent(tab, { type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash' });
        clock = 7000;
        service.reduceEvent(tab, { type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash' });
        clock = 9000;
        service.reduceEvent(tab, { type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash' });

        clock = 21_000;
        const projection = service.beginAgentEnd(tab, 'completed');
        service.completeAgentEnd(tab, projection);

        expect(projection.turnDurationMs).toBe(20_000);
        expect(tab.messageMeta.get('4008')?.toolStats)
            .toEqual([{ name: 'Bash', calls: 2, durationMs: 8000 }]);
        // 20s turn − 6s busy, not 20s − 8s.
        expect(tab.messageMeta.get('4008')?.modelWaitMs).toBe(14_000);
    });

    it('closes an abandoned tool interval at the turn boundary', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4009, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        clock = 5000;
        service.reduceEvent(tab, { type: 'tool_execution_start', toolCallId: 'stuck', toolName: 'bash' });
        // No matching end — the SDK abandoned the call.
        clock = 15_000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'stopped'));

        // Busy 5000→15000 is 10s of the 14s turn, so 4s of model wait remains
        // instead of the whole turn being credited to waiting.
        expect(tab.messageMeta.get('4009')?.modelWaitMs).toBe(4000);
    });

    it('persists a closed turn and restates it when a background child settles', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        const written: any[] = [];
        (tab.session as any).recordTurnMetrics = (metrics: any) => written.push(metrics);
        tab.session.messages = [{
            role: 'assistant', timestamp: 7001, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        service.reduceEvent(tab, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'grep' });
        clock = 3000;
        service.reduceEvent(tab, { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'grep' });
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'running', startedAt: 1000 },
        ]);
        clock = 9000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
            key: '7001',
            turnDurationMs: 8000,
            toolStats: [{ name: 'Grep', calls: 1, durationMs: 2000 }],
            toolDurations: { c1: 2000 },
        });
        expect(written[0].subagentStats[0]).toMatchObject({ status: 'active' });

        // The child settles long after the turn closed.
        clock = 30_000;
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'completed', startedAt: 1000, finishedAt: 21_000 },
        ]);

        expect(written).toHaveLength(2);
        expect(written[1]).toMatchObject({ key: '7001' });
        expect(written[1].subagentStats[0]).toMatchObject({
            status: 'completed',
            durationMs: 20_000,
        });
        // The first write must not have been mutated into the second.
        expect(written[0].subagentStats[0].status).toBe('active');
    });

    it('restores persisted turn metrics, including the running turn total', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        (tab.session as any).getPersistedTurnMetrics = () => [
            {
                key: '7001',
                turnDurationMs: 4000,
                totalTurnDurationMs: 4000,
                toolStats: [{ name: 'Grep', calls: 1, durationMs: 2000 }],
                toolDurations: { c1: 2000 },
            },
            {
                key: '7002',
                turnDurationMs: 6000,
                totalTurnDurationMs: 10_000,
                modelWaitMs: 5000,
                compactionMs: 900,
            },
        ];

        service.restoreTurnMetrics(tab);

        expect(tab.messageMeta.get('7001')).toMatchObject({
            turnDurationMs: 4000,
            toolStats: [{ name: 'Grep', calls: 1, durationMs: 2000 }],
        });
        expect(tab.messageMeta.get('7002')).toMatchObject({
            modelWaitMs: 5000,
            compactionMs: 900,
        });
        expect(tab.toolDurations.get('c1')).toBe(2000);
        // Otherwise the next turn would report a "turns total" below its own turn.
        expect(tab.totalTurnDurationMs).toBe(10_000);
    });

    it('survives a session without persistence support', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 7003, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        expect(() => service.restoreTurnMetrics(tab)).not.toThrow();
        expect(() => service.completeAgentEnd(
            tab,
            service.beginAgentEnd(tab, 'completed'),
        )).not.toThrow();
    });

    it('annotates a history page requested on demand, not only the shipped one', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();
        const assistant = {
            role: 'assistant', timestamp: 6001, content: [{ type: 'text', text: 'older' }],
        };
        tab.messageMeta.set('6001', {
            thinkingDurationSec: 0,
            messageEndTime: 900,
            turnDurationMs: 4000,
            toolStats: [{ name: 'Grep', calls: 2, durationMs: 452_000 }],
        });
        tab.recordToolDuration('call-9', 3000);

        const page = service.annotateTranscriptPage(tab, {
            sessionId: 'session-1',
            items: [
                { id: 'i0', entryId: 'e0', message: { ...assistant } },
                {
                    id: 'i1',
                    entryId: 'e1',
                    message: { role: 'toolResult', toolCallId: 'call-9', toolName: 'grep' },
                },
            ],
            hasMoreBefore: true,
            totalUserMessages: 5,
        });

        expect(page.items[0].message).toMatchObject({
            _turnDurationMs: 4000,
            _toolStats: [{ name: 'Grep', calls: 2, durationMs: 452_000 }],
        });
        expect(page.items[1].message).toMatchObject({ _toolDurationMs: 3000 });
    });

    it('tolerates a page shape it cannot annotate', () => {
        const service = new ChatService({ now: () => 1000 });
        const tab = createTab();

        expect(service.annotateTranscriptPage(tab, undefined)).toBeUndefined();
        expect(service.annotateTranscriptPage(tab, { items: 'nope' }))
            .toEqual({ items: 'nope' });
    });

    it('keeps a finished turn breakdown once the next prompt starts a new turn', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        const firstAssistant = {
            role: 'assistant', timestamp: 5001, content: [{ type: 'text', text: 'first' }],
        };
        tab.session.messages = [
            { role: 'user', timestamp: 5000, content: 'task' },
            firstAssistant,
        ];
        const transcript = () => ({
            sessionId: 'session-1',
            items: tab.session.messages.map((message, index) => ({
                id: `item-${index}`,
                entryId: `entry-${index}`,
                message: { ...message },
            })),
            hasMoreBefore: false,
            totalUserMessages: 1,
        });
        vi.spyOn(tab.session, 'serializeState').mockImplementation(() => ({
            messages: tab.session.messages.map((message) => ({ ...message })),
            isStreaming: false,
            tools: [],
            transcript: transcript(),
        }));
        const context = {
            activeTabId: 'tab-1',
            getTabs: () => [] as TabInfo[],
            cacheMode: 'auto' as const,
            getCacheEffective: () => 'short' as const,
            getFileUndoViewEnabled: () => false,
        };

        // Turn one runs a tool and closes.
        service.reduceEvent(tab, { type: 'agent_start' });
        service.reduceEvent(tab, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'grep' });
        clock = 3000;
        service.reduceEvent(tab, { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'grep' });
        service.reduceEvent(tab, { type: 'message_end', message: firstAssistant });
        clock = 9000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        const afterTurnOne = service.buildState(tab, context);
        expect(afterTurnOne.transcript?.items[1].message).toMatchObject({
            _toolStats: [{ name: 'Grep', calls: 1, durationMs: 2000 }],
        });

        // The user sends the next message and a second turn begins.
        tab.session.messages = [
            ...tab.session.messages,
            { role: 'user', timestamp: 9500, content: 'next task' },
        ];
        clock = 10_000;
        service.reduceEvent(tab, { type: 'agent_start' });
        const duringTurnTwo = service.buildState(tab, context);

        // The first turn's breakdown must survive the new turn.
        expect(duringTurnTwo.transcript?.items[1].message).toMatchObject({
            _toolStats: [{ name: 'Grep', calls: 1, durationMs: 2000 }],
            _turnDurationMs: 8000,
        });
    });

    it('takes in-turn compaction out of the model residual', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4010, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        clock = 5000;
        service.reduceEvent(tab, { type: 'compaction_start' });
        clock = 25_000;
        service.reduceEvent(tab, { type: 'compaction_end' });
        clock = 41_000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        const meta = tab.messageMeta.get('4010');
        expect(meta?.compactionMs).toBe(20_000);
        // 40s turn − 20s compaction, so compaction is reported once, not twice.
        expect(meta?.modelWaitMs).toBe(20_000);
    });

    it('charges pre-prompt compaction to the next turn without shrinking its residual', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4011, content: [{ type: 'text', text: 'done' }],
        }];

        // The overflow check runs before the prompt is sent, so no turn is open.
        service.reduceEvent(tab, { type: 'compaction_start' });
        clock = 9000;
        service.reduceEvent(tab, { type: 'compaction_end' });
        expect(tab.pendingCompactionMs).toBe(8000);

        clock = 10_000;
        service.reduceEvent(tab, { type: 'agent_start' });
        clock = 20_000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        const meta = tab.messageMeta.get('4011');
        expect(meta?.compactionMs).toBe(8000);
        // The whole 10s turn is still residual: the compaction happened before it.
        expect(meta?.modelWaitMs).toBe(10_000);
        expect(tab.pendingCompactionMs).toBe(0);
    });

    it('reports the time delegated runs waited for a concurrency slot', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4012, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        clock = 30_000;
        service.syncSubagentRuns(tab, [
            {
                agentId: 'a1', name: 'Explorer', status: 'completed',
                queuedAt: 1000, startedAt: 1000, finishedAt: 11_000, queueWaitMs: 0,
            },
            // Waited for the first to release its slot; queueWaitMs is authoritative.
            {
                agentId: 'a2', name: 'Explorer', status: 'completed',
                queuedAt: 1000, startedAt: 11_000, finishedAt: 20_000, queueWaitMs: 10_000,
            },
            // No explicit metric — derived from the queued/started pair.
            {
                agentId: 'a3', name: 'Auditor', status: 'failed',
                queuedAt: 1000, startedAt: 4000, finishedAt: 5000,
            },
        ]);
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        expect(tab.messageMeta.get('4012')?.subagentStats?.map((entry) => ({
            agentId: entry.agentId,
            durationMs: entry.durationMs,
            queueWaitMs: entry.queueWaitMs,
        }))).toEqual([
            { agentId: 'a1', durationMs: 10_000, queueWaitMs: 0 },
            { agentId: 'a2', durationMs: 9000, queueWaitMs: 10_000 },
            { agentId: 'a3', durationMs: 1000, queueWaitMs: 3000 },
        ]);
    });

    it('folds child tool time into a combined breakdown without the delegation wrapper', () => {
        let clock = 0;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4006, content: [{ type: 'text', text: 'done' }],
        }];

        clock = 1000;
        service.reduceEvent(tab, { type: 'agent_start' });

        // The parent greps once, then delegates; the child greps twice.
        service.reduceEvent(tab, {
            type: 'tool_execution_start', toolCallId: 'p1', toolName: 'grep',
        });
        clock = 3000;
        service.reduceEvent(tab, {
            type: 'tool_execution_end', toolCallId: 'p1', toolName: 'grep',
        });
        service.reduceEvent(tab, {
            type: 'tool_execution_start', toolCallId: 'p2', toolName: 'subagent',
        });
        for (const [callId, endClock] of [['a:c1', 8000], ['a:c2', 20_000]] as const) {
            service.recordSubagentToolEvent(tab, {
                type: 'tool_execution_start', agentId: 'a', toolCallId: callId, toolName: 'grep',
            });
            clock = endClock;
            service.recordSubagentToolEvent(tab, {
                type: 'tool_execution_end', agentId: 'a', toolCallId: callId, toolName: 'grep',
            });
        }
        clock = 31_000;
        service.reduceEvent(tab, {
            type: 'tool_execution_end', toolCallId: 'p2', toolName: 'subagent',
        });
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        const meta = tab.messageMeta.get('4006');
        // Only orchestrator tools time — own calls, delegation wrapper included.
        expect(meta?.toolStats).toEqual([
            { name: 'Subagent', calls: 1, durationMs: 28_000 },
            { name: 'Grep', calls: 1, durationMs: 2000 },
        ]);
        // Only subagents tools time — the children's calls on their own.
        expect(meta?.childToolStats).toEqual([
            { name: 'Grep', calls: 2, durationMs: 17_000 },
        ]);
        // Total — the child greps merge into the parent's Grep row, and the 28s
        // wrapper is gone so its seconds are not counted twice.
        expect(meta?.combinedToolStats).toEqual([
            { name: 'Grep', calls: 3, durationMs: 19_000 },
        ]);
    });

    it('omits the child and combined breakdowns when no child tool ran', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4007, content: [{ type: 'text', text: 'done' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        service.reduceEvent(tab, {
            type: 'tool_execution_start', toolCallId: 'p1', toolName: 'grep',
        });
        clock = 3000;
        service.reduceEvent(tab, {
            type: 'tool_execution_end', toolCallId: 'p1', toolName: 'grep',
        });
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        const meta = tab.messageMeta.get('4007');
        expect(meta?.toolStats).toEqual([{ name: 'Grep', calls: 1, durationMs: 2000 }]);
        expect(meta?.childToolStats).toBeUndefined();
        expect(meta?.combinedToolStats).toBeUndefined();
    });

    it('accounts delegated runs against the spawning turn, failures included', () => {
        let clock = 0;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{ role: 'assistant', timestamp: 4002, content: [{ type: 'text', text: 'done' }] }];

        clock = 1000;
        service.reduceEvent(tab, { type: 'agent_start' });
        service.syncSubagentRuns(tab, [
            { agentId: 'a1', name: 'Explorer', status: 'running', queuedAt: 1000, startedAt: 1000 },
            { agentId: 'a2', name: 'Implementer', status: 'queued', queuedAt: 1000 },
        ]);

        service.recordSubagentToolEvent(tab, {
            type: 'tool_execution_start', agentId: 'a1', toolCallId: 'a1:c1', toolName: 'grep',
        });
        clock = 6000;
        service.recordSubagentToolEvent(tab, {
            type: 'tool_execution_end', agentId: 'a1', toolCallId: 'a1:c1', toolName: 'grep',
        });

        clock = 30_000;
        service.syncSubagentRuns(tab, [
            { agentId: 'a1', name: 'Explorer', status: 'completed', startedAt: 1000, finishedAt: 21_000 },
            { agentId: 'a2', name: 'Implementer', status: 'failed', startedAt: 1200, finishedAt: 4200 },
        ]);

        const projection = service.beginAgentEnd(tab, 'completed');
        service.completeAgentEnd(tab, projection);

        expect(tab.messageMeta.get('4002')?.subagentStats).toEqual([
            {
                agentId: 'a1',
                name: 'Explorer',
                status: 'completed',
                durationMs: 20_000,
                queueWaitMs: 0,
                toolDurationMs: 5000,
                toolCalls: 1,
            },
            {
                agentId: 'a2',
                name: 'Implementer',
                status: 'failed',
                durationMs: 3000,
                queueWaitMs: 0,
                toolDurationMs: 0,
                toolCalls: 0,
            },
        ]);
    });

    it('keeps a background run charged to its spawning turn and settles it in place', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{ role: 'assistant', timestamp: 4003, content: [{ type: 'text', text: 'spawned' }] }];

        service.reduceEvent(tab, { type: 'agent_start' });
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'running', startedAt: 1000 },
        ]);
        // An unfinished run reports elapsed time as of the last manager update.
        clock = 5000;
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'running', startedAt: 1000 },
        ]);
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        const firstTurn = tab.messageMeta.get('4003')?.subagentStats;
        expect(firstTurn).toMatchObject([{ status: 'active', durationMs: 4000 }]);

        // A later turn must not re-charge the same run...
        clock = 9000;
        service.reduceEvent(tab, { type: 'agent_start' });
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'running', startedAt: 1000 },
        ]);
        expect(tab.turnSubagentIds.size).toBe(0);

        // ...and the settled numbers reach the turn that spawned it.
        clock = 20_000;
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'completed', startedAt: 1000, finishedAt: 15_000 },
        ]);
        expect(firstTurn).toMatchObject([{ status: 'completed', durationMs: 14_000 }]);
    });

    it('does not charge restored delegated runs to an idle tab', () => {
        const service = new ChatService({ now: () => 5000 });
        const tab = createTab();

        service.syncSubagentRuns(tab, [
            { agentId: 'restored', name: 'Explorer', status: 'completed', startedAt: 0, finishedAt: 1000 },
        ]);

        expect(tab.subagentStats.get('restored')).toMatchObject({ durationMs: 1000 });
        expect(tab.turnSubagentIds.size).toBe(0);
    });

    it('does not charge restored delegated runs to a turn that re-sights them', () => {
        let clock = 500_000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4013, content: [{ type: 'text', text: 'done' }],
        }];
        // Session load clears the rows a restored history had already created.
        service.syncSubagentRuns(tab, [
            { agentId: 'old', name: 'Explorer', status: 'completed', queuedAt: 1000, finishedAt: 400_000 },
        ]);
        tab.subagentStats.clear();

        service.reduceEvent(tab, { type: 'agent_start' });
        // The manager re-announces its retained history mid-turn: a terminal
        // run's retention timer expiring is enough to emit a fresh snapshot.
        clock = 510_000;
        service.syncSubagentRuns(tab, [
            { agentId: 'old', name: 'Explorer', status: 'completed', queuedAt: 1000, finishedAt: 400_000 },
        ]);
        clock = 520_000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        expect(tab.turnSubagentIds.size).toBe(0);
        expect(tab.messageMeta.get('4013')?.subagentStats).toBeUndefined();
    });

    it('leaves a running earlier child out of the open turn breakdown', () => {
        let clock = 1000;
        const service = new ChatService({ now: () => clock });
        const tab = createTab();
        tab.session.messages = [{
            role: 'assistant', timestamp: 4014, content: [{ type: 'text', text: 'spawned' }],
        }];

        service.reduceEvent(tab, { type: 'agent_start' });
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'running', queuedAt: 1000, startedAt: 1000 },
        ]);
        clock = 4000;
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        // Next turn: the background child is still grepping, but its seconds
        // belong to the turn that delegated it, not to this one.
        clock = 5000;
        tab.session.messages = [{
            role: 'assistant', timestamp: 4015, content: [{ type: 'text', text: 'done' }],
        }];
        service.reduceEvent(tab, { type: 'agent_start' });
        service.recordSubagentToolEvent(tab, {
            type: 'tool_execution_start', agentId: 'bg', toolCallId: 'bg:c1', toolName: 'grep',
        });
        clock = 9000;
        service.recordSubagentToolEvent(tab, {
            type: 'tool_execution_end', agentId: 'bg', toolCallId: 'bg:c1', toolName: 'grep',
        });
        service.completeAgentEnd(tab, service.beginAgentEnd(tab, 'completed'));

        expect(tab.messageMeta.get('4015')?.childToolStats).toBeUndefined();
        expect(tab.messageMeta.get('4015')?.subagentStats).toBeUndefined();
        // The run's own row still absorbed the call.
        expect(tab.subagentStats.get('bg')).toMatchObject({ toolDurationMs: 4000, toolCalls: 1 });
    });

    it('rehydrates delegated rows so a restored turn keeps tracking its runs', () => {
        const service = new ChatService({ now: () => 60_000 });
        const tab = createTab();
        (tab.session as any).getPersistedTurnMetrics = () => [{
            key: '7003',
            subagentStats: [{
                agentId: 'bg',
                name: 'Explorer',
                status: 'active',
                durationMs: 4000,
                queueWaitMs: 0,
                toolDurationMs: 0,
                toolCalls: 0,
            }],
        }];
        const written: any[] = [];
        (tab.session as any).recordTurnMetrics = (metrics: any) => written.push(metrics);

        service.restoreTurnMetrics(tab);
        expect(tab.subagentStats.get('bg')).toBeDefined();

        // The child settles after the reload; the turn that owns it is restated
        // rather than a duplicate row appearing on whatever turn comes next.
        service.syncSubagentRuns(tab, [
            { agentId: 'bg', name: 'Explorer', status: 'completed', queuedAt: 1000, finishedAt: 31_000 },
        ]);

        expect(tab.subagentStats.size).toBe(1);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({ key: '7003' });
        expect(written[0].subagentStats[0]).toMatchObject({
            status: 'completed', durationMs: 30_000,
        });
        expect(tab.messageMeta.get('7003')?.subagentStats?.[0]).toMatchObject({
            status: 'completed',
        });
    });

    it('ignores a child tool end without a recorded start', () => {
        const service = new ChatService({ now: () => 5000 });
        const tab = createTab();

        service.recordSubagentToolEvent(tab, {
            type: 'tool_execution_end', agentId: 'a1', toolCallId: 'a1:c1', toolName: 'grep',
        });

        expect(tab.subagentStats.size).toBe(0);
    });

    it('ignores a tool end without a recorded start', () => {
        const service = new ChatService({ now: () => 5000 });
        const tab = createTab();

        service.reduceEvent(tab, {
            type: 'tool_execution_end', toolCallId: 'orphan', toolName: 'read',
        });

        expect(tab.toolDurations.size).toBe(0);
        expect(tab.turnToolStats.size).toBe(0);
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
            .mockReturnValueOnce(2400)
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
        service.reduceEvent(tab, {
            type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read',
        });
        expect(tab.pendingTools.size).toBe(0);
        expect(tab.toolDurations.get('call-1')).toBe(400);
        expect([...tab.turnToolStats.values()]).toEqual([
            { name: 'Read', calls: 1, durationMs: 400 },
        ]);

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

        tab.session.messages = [{ role: 'assistant', timestamp: 4004, content: [] }];
        service.reduceEvent(tab, {
            type: 'message_end',
            message: { role: 'assistant', timestamp: 4004 },
        });
        expect(tab.messageMeta.get('4004')).toMatchObject({
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
        tab.session.messages = [{ role: 'assistant', timestamp: 4005, content: [{ type: 'text', text: 'done' }] }];
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
        service.completeAgentEnd(tab, end, { codexTurn });

        expect(end).toEqual({ turnEndAt: 7000, turnDurationMs: 6000 });
        expect(tab.messageMeta.get('4005')).toMatchObject({
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
        tab.session.messages = [{ role: 'user', content: 'recent compacted request' }];
        tab.session.transcriptMessages = [{ role: 'user', content: 'first user request' }];

        expect(service.updateTabName(tab)).toEqual({ changed: true, name: 'first user request' });
        expect(tab.session.setSessionName).toHaveBeenCalledOnce();
        expect(service.updateTabName(tab)).toEqual({ changed: false, name: 'first user request' });
        expect(tab.session.setSessionName).toHaveBeenCalledOnce();

        tab.session.session = { sessionName: 'Persisted name' };
        expect(service.updateTabName(tab)).toEqual({ changed: true, name: 'Persisted name' });
    });

    it('does not use Plan Mode instructions when deriving a chat name', () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        tab.session.transcriptMessages = [{
            role: 'user',
            content: `${PLAN_MODE_INSTRUCTIONS}\n\nRefactor the launcher tabs`,
        }];

        expect(service.updateTabName(tab)).toEqual({
            changed: true,
            name: 'Refactor the launcher tabs',
        });
    });
});

function createDirectPromptCallbacks(overrides: Record<string, unknown> = {}): any {
    return {
        decoratePrompt: vi.fn((text: string) => text),
        augmentPrompt: vi.fn(async (text: string) => text),
        compact: vi.fn(async () => undefined),
        prompt: vi.fn(async () => undefined),
        isSessionBusy: vi.fn(() => false),
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
        service.resetSessionProjection(tab, undefined, 2);

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

    it('acknowledges direct compact without waiting for SDK compaction to finish', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const order: string[] = [];
        let finishCompact!: () => void;
        let acknowledged = false;
        const callbacks = createDirectPromptCallbacks({
            prepareRequest: vi.fn(() => order.push('prepare-cache')),
            compact: vi.fn(() => new Promise<void>((resolve) => {
                order.push('compact');
                finishCompact = resolve;
            })),
            publishState: vi.fn(() => order.push('publish')),
        });

        const dispatch = service.dispatchDirectPrompt(tab, {
            text: '/compact focus on tests',
        }, callbacks).then((result) => {
            acknowledged = true;
            return result;
        });

        await Promise.resolve();
        expect(acknowledged).toBe(true);
        await expect(dispatch).resolves.toEqual({ kind: 'compacted' });
        finishCompact();

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

    it('queues a direct prompt while the session is still busy instead of losing it', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const callbacks = createDirectPromptCallbacks({
            isSessionBusy: vi.fn(() => true),
        });

        await expect(service.dispatchDirectPrompt(tab, { text: 'next task' }, callbacks))
            .resolves.toEqual({ kind: 'queued', queueLength: 1 });

        expect(tab.queuedMessages).toEqual(['next task']);
        expect(callbacks.prompt).not.toHaveBeenCalled();
        expect(callbacks.prepareRequest).not.toHaveBeenCalled();
        expect(callbacks.publishState).toHaveBeenCalledOnce();
        expect(tab.turnCounter).toBe(0);
        expect(tab.checkpointManager.startTurn).not.toHaveBeenCalled();
    });

    it('runs a direct compact even while the session is busy', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const callbacks = createDirectPromptCallbacks({
            isSessionBusy: vi.fn(() => true),
        });

        await expect(service.dispatchDirectPrompt(tab, { text: '/compact' }, callbacks))
            .resolves.toEqual({ kind: 'compacted' });

        expect(callbacks.compact).toHaveBeenCalledWith(undefined);
        expect(tab.queuedMessages).toEqual([]);
    });

    it('refuses attachments while busy rather than queueing text without them', async () => {
        const service = new ChatService({ now: () => 0 });
        const tab = createTab();
        const callbacks = createDirectPromptCallbacks({
            isSessionBusy: vi.fn(() => true),
        });
        const images = [{ type: 'image', data: 'abc', mimeType: 'image/png' }] as any;

        await expect(service.dispatchDirectPrompt(tab, { text: 'look', images }, callbacks))
            .rejects.toThrow('Attachments cannot be queued while the agent is busy.');

        expect(tab.queuedMessages).toEqual([]);
        expect(callbacks.prompt).not.toHaveBeenCalled();
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
