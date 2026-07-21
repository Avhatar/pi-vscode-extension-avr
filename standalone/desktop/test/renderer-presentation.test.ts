import { describe, expect, it } from 'vitest';
import type { SerializedAgentState } from '../../../src/shared/agent-protocol';
import {
    applyAgentEvent,
    applyStateSnapshot,
    createLivePresentation,
    getTodoProgress,
    getVisibleTools,
    projectFeedItems,
    resolveComposerAction,
    resolveNewWindowControl,
    THINKING_LEVELS,
} from '../renderer/presentation';

function snapshot(overrides: Partial<SerializedAgentState> = {}): SerializedAgentState {
    return {
        messages: [],
        isStreaming: false,
        tools: [],
        tabs: [
            { id: 'tab-a', name: 'Alpha', isActive: true, isStreaming: false, hasNotification: false },
            { id: 'tab-b', name: 'Beta', isActive: false, isStreaming: false, hasNotification: false },
        ],
        activeTabId: 'tab-a',
        ...overrides,
    };
}

describe('desktop renderer presentation', () => {
    it('keeps a background tab snapshot from replacing the active transcript', () => {
        const active = snapshot({ messages: [{ role: 'user', content: 'active prompt' }] });
        const initial = applyStateSnapshot(undefined, undefined, active);

        const background = snapshot({
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'background answer' }] }],
            tabs: [
                { id: 'tab-a', name: 'Alpha', isActive: true, isStreaming: false, hasNotification: false },
                { id: 'tab-b', name: 'Beta', isActive: false, isStreaming: false, hasNotification: true },
            ],
        });
        const next = applyStateSnapshot(initial, 'tab-b', background);

        expect(next.activeTabId).toBe('tab-a');
        expect(next.visibleState?.messages).toEqual(active.messages);
        expect(next.snapshots['tab-b']?.messages).toEqual(background.messages);
        expect(next.tabs[1].hasNotification).toBe(true);
    });

    it('adopts a requested active tab snapshot and preserves its ownership', () => {
        const initial = applyStateSnapshot(undefined, undefined, snapshot());
        const beta = snapshot({
            activeTabId: 'tab-b',
            messages: [{ role: 'user', content: 'beta prompt' }],
            tabs: [
                { id: 'tab-a', name: 'Alpha', isActive: false, isStreaming: false, hasNotification: false },
                { id: 'tab-b', name: 'Beta', isActive: true, isStreaming: false, hasNotification: false },
            ],
        });

        const next = applyStateSnapshot(initial, 'tab-b', beta);

        expect(next.activeTabId).toBe('tab-b');
        expect(next.visibleState).toBe(beta);
        expect(next.snapshots['tab-b']).toBe(beta);
    });

    it('projects user, assistant, tool, error, and compaction messages as plain feed data', () => {
        const items = projectFeedItems(snapshot({
            messages: [
                { role: 'user', content: [{ type: 'text', text: '<b>literal prompt</b>' }], timestamp: 10 },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'inspect first' },
                        { type: 'text', text: 'safe answer' },
                        { type: 'toolCall', name: 'read', arguments: { path: 'src/main.ts' } },
                    ],
                    timestamp: 20,
                },
                { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'file body' }], timestamp: 30 },
                { role: 'error', content: 'provider failed', timestamp: 40 },
                { role: 'compactionSummary', summary: 'earlier context', tokensBefore: 100, tokensAfter: 40, timestamp: 50 },
            ],
        }));

        expect(items).toMatchObject([
            { kind: 'user', text: '<b>literal prompt</b>', timestamp: 10 },
            { kind: 'assistant', text: 'safe answer', thinking: 'inspect first', timestamp: 20 },
            { kind: 'tool', title: 'Read src/main.ts', text: 'file body', timestamp: 30 },
            { kind: 'error', text: 'provider failed', timestamp: 40 },
            { kind: 'compaction', text: 'earlier context', meta: '100 → 40 tokens', timestamp: 50 },
        ]);
        expect(items[0].text).not.toContain('&lt;');
    });

    it('reduces streaming and tool events without mutating the previous state', () => {
        const initial = createLivePresentation(snapshot({
            isStreaming: true,
            streamingThinking: 'seed',
            streamingText: 'draft',
            pendingTools: [{ toolCallId: 'existing', toolName: 'grep', startTime: 5 }],
        }));
        const thinking = applyAgentEvent(initial, {
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_delta', delta: ' more' },
        }, 100);
        const started = applyAgentEvent(thinking, {
            type: 'tool_execution_start',
            toolCallId: 'call-1',
            toolName: 'read',
            args: { path: 'README.md' },
        }, 200);
        const updated = applyAgentEvent(started, {
            type: 'tool_execution_update',
            toolCallId: 'call-1',
            partialResult: { content: [{ type: 'text', text: 'partial output' }] },
        }, 300);
        const ended = applyAgentEvent(updated, {
            type: 'tool_execution_end',
            toolCallId: 'call-1',
            toolName: 'read',
            result: { content: [{ type: 'text', text: 'complete output' }] },
            isError: false,
        }, 400);

        expect(initial.streamingThinking).toBe('seed');
        expect(thinking.streamingThinking).toBe('seed more');
        expect(started.tools['call-1']).toMatchObject({
            name: 'read',
            label: 'Read README.md',
            status: 'running',
            startedAt: 200,
        });
        expect(updated.tools['call-1'].output).toBe('partial output');
        expect(ended.tools['call-1']).toMatchObject({ status: 'done', output: 'complete output' });
        expect(ended.tools.existing.name).toBe('grep');
    });

    it('projects V2 todo progress and tool filtering from authoritative controls', () => {
        expect(getTodoProgress({
            tasks: [
                { id: 1, subject: 'Done', status: 'completed' },
                { id: 2, subject: 'Active', status: 'in_progress' },
                { id: 3, subject: 'Deleted', status: 'deleted' },
            ],
            nextId: 4,
        })).toEqual({ completed: 1, total: 2 });
        expect(getVisibleTools({
            registered: [{ name: 'read' }, { name: 'write' }, { name: 'web_search' }],
            disabled: ['write'],
            toggleDisabled: false,
        }, 'w')).toEqual([
            { name: 'web_search', enabled: true },
            { name: 'write', enabled: false },
        ]);
    });

    it('hides New Window until the current workspace host is connected', () => {
        expect(resolveNewWindowControl({ shellPhase: 'opening', agentReady: false, launchPending: false })).toEqual({
            visible: false,
            disabled: true,
            label: 'NEW WINDOW',
        });
        expect(resolveNewWindowControl({ shellPhase: 'ready', agentReady: false, launchPending: false }).visible).toBe(false);
        expect(resolveNewWindowControl({ shellPhase: 'ready', agentReady: true, launchPending: false })).toEqual({
            visible: true,
            disabled: false,
            label: 'NEW WINDOW',
        });
        expect(resolveNewWindowControl({ shellPhase: 'ready', agentReady: true, launchPending: true })).toEqual({
            visible: true,
            disabled: true,
            label: 'OPENING…',
        });
        expect(resolveNewWindowControl({ shellPhase: 'welcome', agentReady: false, launchPending: false }).visible).toBe(true);
    });

    it('offers every supported Pi Code thinking level, including max', () => {
        expect(THINKING_LEVELS).toContain('max');
    });

    it('maps keyboard input to host-owned prompt, queue, steer, and abort commands', () => {
        expect(resolveComposerAction({ key: 'Enter', shiftKey: true, modifierKey: false, isBusy: false, hasText: true })).toBe('newline');
        expect(resolveComposerAction({ key: 'Enter', shiftKey: false, modifierKey: false, isBusy: false, hasText: true })).toBe('prompt');
        expect(resolveComposerAction({ key: 'Enter', shiftKey: false, modifierKey: false, isBusy: true, hasText: true })).toBe('queue');
        expect(resolveComposerAction({ key: 'Enter', shiftKey: false, modifierKey: true, isBusy: true, hasText: true })).toBe('steer');
        expect(resolveComposerAction({ key: 'Escape', shiftKey: false, modifierKey: false, isBusy: true, hasText: false })).toBe('abort');
        expect(resolveComposerAction({ key: 'Escape', shiftKey: false, modifierKey: false, isBusy: false, hasText: true })).toBe('none');
        expect(resolveComposerAction({ key: 'Enter', shiftKey: false, modifierKey: false, isBusy: false, hasText: false })).toBe('none');
    });
});
