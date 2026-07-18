import type {
    CacheEffective,
    CacheMode,
    CodexTurnUsage,
    FileChangeInfo,
    SerializedAgentState,
    TabInfo,
} from '../../shared/agent-protocol';
import type { TurnCompletionInfo, TurnCompletionOutcome } from '../../shared/turn-notification';
import { safeSerialize } from '../../shared/safe-serialize';
import {
    TabRuntime,
    type TabDisposableResource,
    type TabSessionResource,
} from './tab-runtime';

export interface ChatServiceSession extends TabSessionResource {
    readonly sessionPath?: string;
    readonly session?: { readonly sessionName?: string };
    serializeState(): SerializedAgentState;
    getMessages(): any[];
}

export interface ChatServiceDiff extends TabDisposableResource {
    readonly fileChanges: FileChangeInfo[];
}

export interface ChatServiceCheckpoint extends TabDisposableResource {
    readonly rollbackPoint: number | null;
}

export type ChatServiceTab = TabRuntime<
    ChatServiceSession,
    ChatServiceDiff,
    ChatServiceCheckpoint
>;

export interface ChatServiceOptions {
    now(): number;
}

export interface ChatStateContext {
    readonly activeTabId: string;
    readonly getTabs: () => TabInfo[];
    readonly cacheMode: CacheMode;
    readonly getCacheEffective: () => CacheEffective;
    readonly getFileUndoViewEnabled: () => boolean;
}

export interface AgentEndProjection {
    readonly turnEndAt: number;
    readonly turnDurationMs: number;
}

export interface TabNameUpdate {
    readonly changed: boolean;
    readonly name: string;
}

/**
 * Portable chat event/state subservice.
 *
 * Tab registry, transport delivery, host UI effects, provider accounting, and
 * command routing remain composition concerns. This service mutates only the
 * existing per-tab runtime so there is never a second copy of chat state.
 */
export class ChatService {
    private readonly _now: () => number;

    constructor(options: ChatServiceOptions) {
        this._now = options.now;
    }

    reduceEvent(tab: ChatServiceTab, event: any): void {
        if (event.type === 'agent_start') {
            tab.turnNotificationGate.onAgentStart();
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = this._now();
            tab.isStreamingLocal = true;
            tab.errorReportedThisRun = false;
            tab.pendingTools.clear();
        }

        if (event.type === 'tool_execution_start' && event.toolCallId) {
            tab.pendingTools.set(String(event.toolCallId), {
                name: String(event.toolName ?? '?'),
                startTime: this._now(),
            });
        }

        if (event.type === 'tool_execution_end' && event.toolCallId) {
            tab.pendingTools.delete(String(event.toolCallId));
        }

        if (event.type === 'compaction_start') tab.isCompacting = true;
        if (event.type === 'compaction_end') tab.isCompacting = false;

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const lastOrdinal = lastAssistantOrdinal(tab.session.getMessages());
            if (lastOrdinal >= 0) {
                const meta = tab.messageMeta.get(lastOrdinal)
                    ?? { thinkingDurationSec: 0, messageEndTime: 0 };
                meta.thinkingDurationSec = tab.streamingThinkingDuration;
                meta.messageEndTime = this._now();
                tab.messageMeta.set(lastOrdinal, meta);
            }
            // A turn may contain more than one assistant message. The next
            // streaming draft must not inherit finalized text or thinking.
            tab.streamingThinkingDuration = 0;
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
        }

        if (event.type === 'message_update' && event.assistantMessageEvent) {
            const assistantEvent = event.assistantMessageEvent;
            switch (assistantEvent.type) {
                case 'thinking_start':
                    tab.isThinking = true;
                    tab.streamingThinking = '';
                    tab.thinkingStartTime = this._now();
                    tab.streamingThinkingDuration = 0;
                    break;
                case 'thinking_delta':
                    tab.streamingThinking += assistantEvent.delta ?? '';
                    break;
                case 'thinking_end':
                    tab.isThinking = false;
                    if (tab.thinkingStartTime > 0) {
                        tab.streamingThinkingDuration = Math.round(
                            (this._now() - tab.thinkingStartTime) / 1000,
                        );
                    }
                    break;
                case 'text_delta':
                    tab.streamingText += assistantEvent.delta ?? '';
                    break;
            }
        }
    }

    beginAgentEnd(
        tab: ChatServiceTab,
        outcome: TurnCompletionOutcome,
    ): AgentEndProjection {
        const turnEndAt = this._now();
        const turnDurationMs = tab.agentStartTime > 0
            ? Math.max(0, turnEndAt - tab.agentStartTime)
            : 0;
        if (turnDurationMs > 0) tab.totalTurnDurationMs += turnDurationMs;
        tab.turnNotificationGate.onAgentEnd({
            tabName: tab.name,
            outcome,
            durationMs: turnDurationMs,
        });
        return { turnEndAt, turnDurationMs };
    }

    completeAgentEnd(
        tab: ChatServiceTab,
        projection: AgentEndProjection,
        codexTurn?: CodexTurnUsage,
    ): void {
        const lastOrdinal = lastAssistantOrdinal(tab.session.getMessages());
        if (lastOrdinal >= 0 && (codexTurn || projection.turnDurationMs > 0)) {
            const meta = tab.messageMeta.get(lastOrdinal)
                ?? { thinkingDurationSec: 0, messageEndTime: 0 };
            if (codexTurn) meta.codexTurn = codexTurn;
            if (projection.turnDurationMs > 0) {
                meta.turnDurationMs = projection.turnDurationMs;
                meta.totalTurnDurationMs = tab.totalTurnDurationMs;
            }
            tab.messageMeta.set(lastOrdinal, meta);
        }

        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        tab.agentStartTime = 0;
        tab.isStreamingLocal = false;
        tab.lastTurnEndAt = projection.turnEndAt;
    }

    settleAgent(tab: ChatServiceTab): TurnCompletionInfo | undefined {
        return tab.turnNotificationGate.onAgentSettled();
    }

    updateTabName(tab: ChatServiceTab): TabNameUpdate {
        const sessionName = tab.session.session?.sessionName;
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
            return { changed: true, name: tab.name };
        }

        if (tab.name === 'New Agent') {
            const firstUser = tab.session.getMessages().find((message: any) => message.role === 'user');
            if (firstUser) {
                const content = firstUser.content;
                const text: string = typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                        ? (content.find((part: any) => part.type === 'text')?.text ?? '')
                        : '';
                const trimmed = text.replace(/\n/g, ' ').trim().slice(0, 60);
                if (trimmed) {
                    tab.name = trimmed;
                    return { changed: true, name: tab.name };
                }
            }
        }

        return { changed: false, name: tab.name };
    }

    buildState(tab: ChatServiceTab, context: ChatStateContext): SerializedAgentState {
        const state = tab.session.serializeState();
        state.isStreaming = tab.isStreamingLocal;
        state.isCompacting = tab.isCompacting;
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((message) => safeSerialize(message)),
            ];
        }
        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = context.getTabs();
        state.activeTabId = context.activeTabId;
        state.sessionPath = tab.session.sessionPath ?? undefined;
        state.streamingText = tab.streamingText;
        state.streamingThinking = tab.streamingThinking;
        state.isThinking = tab.isThinking;
        state.thinkingStartTime = tab.thinkingStartTime;
        state.streamingThinkingDuration = tab.streamingThinkingDuration;
        if (tab.queuedMessages.length > 0) state.queuedMessages = tab.queuedMessages;
        state.cacheMode = context.cacheMode;
        const cacheEffective = context.getCacheEffective();
        state.cacheEffective = cacheEffective;
        tab.cacheEffective = cacheEffective;
        state.fileUndoViewEnabled = context.getFileUndoViewEnabled();

        let assistantOrdinal = 0;
        for (const message of state.messages) {
            if (message.role !== 'assistant') continue;
            const meta = tab.messageMeta.get(assistantOrdinal);
            if (meta) {
                message._thinkingDurationSec = meta.thinkingDurationSec;
                message._messageEndTime = meta.messageEndTime;
                if (meta.turnDurationMs !== undefined) {
                    message._turnDurationMs = meta.turnDurationMs;
                }
                if (meta.totalTurnDurationMs !== undefined) {
                    message._totalTurnDurationMs = meta.totalTurnDurationMs;
                }
                if (meta.codexTurn) message._codexTurnUsage = meta.codexTurn;
            }
            assistantOrdinal++;
        }
        return state;
    }
}

function lastAssistantOrdinal(messages: any[]): number {
    let ordinal = -1;
    let counter = 0;
    for (const message of messages) {
        if (message?.role === 'assistant') {
            ordinal = counter;
            counter++;
        }
    }
    return ordinal;
}
