import type {
    AgentClientMessage,
    AgentTabControls,
    CacheEffective,
    CacheMode,
    CodexTurnUsage,
    DeepSeekTurnUsage,
    FileAttachment,
    FileChangeInfo,
    ImageAttachment,
    SerializedAgentState,
    TabInfo,
} from '../../shared/agent-protocol';
import type { ProjectToolSelectionDefault } from '../../shared/project-tool-default';
import type { TurnCompletionInfo, TurnCompletionOutcome } from '../../shared/turn-notification';
import { safeSerialize } from '../../shared/safe-serialize';
import {
    accumulateToolStat,
    subagentStatStatus,
    toolStatDisplayName,
    toolStatEntries,
    type SubagentStatEntry,
} from '../../shared/tool-timing';
import {
    TabRuntime,
    type TabDisposableResource,
    type TabMessageMeta,
    type TabSessionResource,
} from './tab-runtime';

export interface ChatServiceSession extends TabSessionResource {
    readonly sessionPath?: string;
    readonly session?: { readonly sessionName?: string };
    serializeState(): SerializedAgentState;
    getMessages(): any[];
    getFirstTranscriptUserMessage(): any | undefined;
    setSessionName(name: string): void;
}

export interface ChatServiceDiff extends TabDisposableResource {
    readonly fileChanges: FileChangeInfo[];
    setCurrentTurn(turnIndex: number): void;
    discardSuspended(): void;
}

export interface ChatServiceCheckpoint extends TabDisposableResource {
    readonly rollbackPoint: number | null;
    startTurn(turnIndex: number): void;
    discardSuspended(): void;
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
    readonly getControls?: () => AgentTabControls | undefined;
}

export interface AgentEndProjection {
    readonly turnEndAt: number;
    readonly turnDurationMs: number;
}

export interface AgentEndAccounting {
    readonly codexTurn?: CodexTurnUsage;
    readonly deepSeekTurn?: DeepSeekTurnUsage;
}

export interface TabNameUpdate {
    readonly changed: boolean;
    readonly name: string;
}

/**
 * Structural view of one child tool event forwarded by the subagent manager.
 * Child sessions never reach `reduceEvent`, so their timing arrives here.
 */
export interface SubagentToolEvent {
    readonly type: 'tool_execution_start' | 'tool_execution_end';
    readonly agentId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args?: unknown;
}

/** Structural view of the delegated-run lifecycle fields turn accounting reads. */
export interface SubagentRunTiming {
    readonly agentId: string;
    readonly name: string;
    readonly status: string;
    readonly queuedAt?: number;
    readonly startedAt?: number;
    readonly finishedAt?: number;
}

const FILE_BLOCK_TITLE_RE = /\[File:\s*(.+?)\]\s*(?:\(binary file\))?[\s\S]*?\[\/File\]\s*\n?/g;
const PLAN_MODE_TITLE_BLOCK_RE = /^<plan-mode-instructions>[\s\S]*?<\/plan-mode-instructions>\s*/;
const ATTACHMENT_INSTRUCTIONS_TITLE_BLOCK_RE = /<pi-code-attachment-instructions>[\s\S]*?<\/pi-code-attachment-instructions>\s*\n?/g;
const REFERENCED_WORKSPACE_FILES_TITLE_RE = /\n\nReferenced workspace files to inspect if needed:\n[\s\S]*$/;

export type QueueControlCommand = Extract<
    AgentClientMessage,
    { type: 'queueMessage' | 'editQueuedMessage' | 'removeQueuedMessage' | 'cancelQueue' }
>;

export interface QueueControlResult {
    readonly changed: boolean;
    readonly queueLength: number;
}

export interface DirectPromptRequest {
    readonly text: string;
    readonly images?: ImageAttachment[];
    readonly files?: FileAttachment[];
}

export interface DirectPromptCallbacks {
    decoratePrompt(text: string): string;
    augmentPrompt(text: string): Promise<string>;
    compact(instructions?: string): Promise<void>;
    prompt(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void>;
    prepareRequest(): void;
    logPrompt(): void;
    publishState(): void;
    reportDetachedFailure(error: unknown): void;
}

export type DirectPromptDispatchResult =
    | { readonly kind: 'prompt_dispatched' }
    | { readonly kind: 'compacted' };

export type StreamingCommand = Extract<
    AgentClientMessage,
    { type: 'steer' | 'followUp' | 'abort' }
>;

export interface StreamingCommandCallbacks {
    augmentPrompt(text: string): Promise<string>;
    prepareRequest(): void;
    logPrompt(kind: 'steer' | 'followUp'): void;
    steer(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void>;
    followUp(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void>;
    abort(): Promise<void>;
}

export interface SessionProjectionResetTarget {
    readonly diffManager: { clearAll(): void };
    readonly checkpointManager: { clearAll(): void };
    resetSessionProjection(
        projectToolDefault?: ProjectToolSelectionDefault,
        initialTurnCounter?: number,
    ): void;
}

export interface FileHistoryTarget {
    readonly isStreamingLocal: boolean;
    readonly isCompacting: boolean;
    suspendedMessages: any[];
    readonly session: {
        getMessages(): any[];
        setMessages(messages: any[]): void;
    };
    readonly diffManager: {
        undoFileChange(filePath: string, toolCallId: string): Promise<void>;
        suspendChangesAfter(messageIndex: number): void;
        redoChanges(): void;
    };
    readonly checkpointManager: {
        restoreCheckpoint(messageIndex: number): Promise<string[]>;
        redoCheckpoint(): Promise<string[]>;
    };
}

export interface QueuedDispatchCallbacks {
    decoratePrompt(text: string): string;
    augmentPrompt(text: string): Promise<string>;
    compact(instructions?: string): Promise<void>;
    prompt(text: string, onAgentStart: () => void): Promise<void>;
    isSessionStreaming(): boolean;
    handleLocalCommand(text: string): boolean;
    scheduleRetry(retry: () => Promise<void>): void;
    prepareRequest(): void;
    logQueuedPrompt(): void;
    publishState(): void;
    reportError(error: unknown): void;
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
            tab.turnToolStats.clear();
            tab.turnSubagentIds.clear();
        }

        if (event.type === 'tool_execution_start' && event.toolCallId) {
            tab.pendingTools.set(String(event.toolCallId), {
                name: String(event.toolName ?? '?'),
                startTime: this._now(),
                ...(event.args === undefined ? {} : { args: safeSerialize(event.args) }),
            });
        }

        if (event.type === 'tool_execution_end' && event.toolCallId) {
            const toolCallId = String(event.toolCallId);
            const pending = tab.pendingTools.get(toolCallId);
            tab.pendingTools.delete(toolCallId);
            // Without a matching start there is no reliable origin to measure
            // from, so the call is left out rather than reported as instant.
            if (pending) {
                const durationMs = Math.max(0, this._now() - pending.startTime);
                tab.recordToolDuration(toolCallId, durationMs);
                accumulateToolStat(tab.turnToolStats, {
                    name: toolStatDisplayName(event.toolName ?? pending.name, pending.args),
                    durationMs,
                });
            }
        }

        if (event.type === 'compaction_start') tab.isCompacting = true;
        if (event.type === 'compaction_end') tab.isCompacting = false;

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            // The event carries the finalized message, so its identity is exact
            // and does not depend on the compact context's current shape.
            const key = assistantMetaKey(event.message)
                ?? assistantMetaKey(lastAssistantMessage(tab.session.getMessages()));
            if (key !== undefined) {
                const meta = tab.messageMeta.get(key)
                    ?? { thinkingDurationSec: 0, messageEndTime: 0 };
                meta.thinkingDurationSec = tab.streamingThinkingDuration;
                meta.messageEndTime = this._now();
                tab.recordMessageMeta(key, meta);
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

    /**
     * Fold one child tool call into the delegating run's accounting. The parent
     * also books its own `subagent` tool call, so this time is reported as a
     * separate section rather than merged into the parent tool breakdown.
     */
    recordSubagentToolEvent(tab: ChatServiceTab, event: SubagentToolEvent): void {
        const agentId = String(event.agentId ?? '');
        const toolCallId = String(event.toolCallId ?? '');
        if (!agentId || !toolCallId) return;

        if (event.type === 'tool_execution_start') {
            tab.subagentStat(agentId);
            tab.pendingSubagentTools.set(toolCallId, this._now());
            return;
        }

        const startTime = tab.pendingSubagentTools.get(toolCallId);
        tab.pendingSubagentTools.delete(toolCallId);
        if (startTime === undefined) return;
        const entry = tab.subagentStat(agentId);
        entry.toolDurationMs += Math.max(0, this._now() - startTime);
        entry.toolCalls += 1;
    }

    /**
     * Reconcile the manager's run list into per-turn accounting. Runs that
     * disappear from the snapshot (terminal retention expiry) keep the numbers
     * they last reported.
     */
    syncSubagentRuns(tab: ChatServiceTab, runs: readonly SubagentRunTiming[]): void {
        const now = this._now();
        for (const run of runs) {
            const agentId = String(run.agentId ?? '');
            if (!agentId) continue;
            const entry = tab.subagentStat(agentId, run.name);
            if (run.name) entry.name = run.name;
            entry.status = subagentStatStatus(run.status);
            const start = run.startedAt ?? run.queuedAt;
            entry.durationMs = start === undefined
                ? 0
                : Math.max(0, (run.finishedAt ?? now) - start);
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
        accounting?: AgentEndAccounting,
    ): void {
        const key = assistantMetaKey(lastAssistantMessage(tab.session.getMessages()));
        const turnToolStats = toolStatEntries(tab.turnToolStats);
        tab.turnToolStats.clear();
        // Live rows on purpose: a background child keeps running past this
        // point and the turn summary has to reflect where it lands.
        const turnSubagentStats = [...tab.turnSubagentIds]
            .map((agentId) => tab.subagentStats.get(agentId))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        if (key !== undefined && (
            accounting?.codexTurn
            || accounting?.deepSeekTurn
            || projection.turnDurationMs > 0
            || turnToolStats.length > 0
            || turnSubagentStats.length > 0
        )) {
            const meta = tab.messageMeta.get(key)
                ?? { thinkingDurationSec: 0, messageEndTime: 0 };
            if (accounting?.codexTurn) meta.codexTurn = accounting.codexTurn;
            if (accounting?.deepSeekTurn) meta.deepSeekTurn = accounting.deepSeekTurn;
            if (projection.turnDurationMs > 0) {
                meta.turnDurationMs = projection.turnDurationMs;
                meta.totalTurnDurationMs = tab.totalTurnDurationMs;
            }
            if (turnToolStats.length > 0) meta.toolStats = turnToolStats;
            if (turnSubagentStats.length > 0) meta.subagentStats = turnSubagentStats;
            tab.recordMessageMeta(key, meta);
        }

        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        tab.agentStartTime = 0;
        tab.isStreamingLocal = false;
        tab.pendingTools.clear();
        tab.lastTurnEndAt = projection.turnEndAt;
    }

    settleAgent(tab: ChatServiceTab): TurnCompletionInfo | undefined {
        return tab.turnNotificationGate.onAgentSettled();
    }

    resetSessionProjection(
        tab: SessionProjectionResetTarget,
        projectToolDefault: ProjectToolSelectionDefault | undefined,
        initialTurnCounter = 0,
    ): void {
        tab.diffManager.clearAll();
        tab.checkpointManager.clearAll();
        tab.resetSessionProjection(projectToolDefault, initialTurnCounter);
    }

    async undoFileChange(
        tab: FileHistoryTarget,
        filePath: string,
        toolCallId: string,
    ): Promise<void> {
        this.assertFileHistoryIdle(tab);
        await tab.diffManager.undoFileChange(filePath, toolCallId);
    }

    async restoreCheckpoint(
        tab: FileHistoryTarget,
        messageIndex: number,
    ): Promise<string[]> {
        this.assertFileHistoryIdle(tab);
        const restored = await tab.checkpointManager.restoreCheckpoint(messageIndex);
        tab.diffManager.suspendChangesAfter(messageIndex);
        const messages = tab.session.getMessages();
        const cutoff = findMessageCutoff(messages, messageIndex);
        if (cutoff >= 0 && cutoff < messages.length) {
            tab.suspendedMessages = messages.slice(cutoff);
            tab.session.setMessages(messages.slice(0, cutoff));
        }
        return restored;
    }

    async redoCheckpoint(tab: FileHistoryTarget): Promise<string[]> {
        this.assertFileHistoryIdle(tab);
        const redone = await tab.checkpointManager.redoCheckpoint();
        tab.diffManager.redoChanges();
        if (tab.suspendedMessages.length > 0) {
            const messages = tab.session.getMessages();
            tab.session.setMessages([...messages, ...tab.suspendedMessages]);
            tab.suspendedMessages = [];
        }
        return redone;
    }

    assertFileHistoryIdle(tab: Pick<FileHistoryTarget, 'isStreamingLocal' | 'isCompacting'>): void {
        if (tab.isStreamingLocal || tab.isCompacting) {
            throw new Error('Wait for the agent to finish before undoing or redoing file changes.');
        }
    }

    async dispatchDirectPrompt(
        tab: ChatServiceTab,
        request: DirectPromptRequest,
        callbacks: DirectPromptCallbacks,
    ): Promise<DirectPromptDispatchResult> {
        const compactInstructions = parseCompactCommand(request.text);
        if (compactInstructions !== null) {
            callbacks.prepareRequest();
            try {
                void callbacks.compact(compactInstructions).catch(() => {
                    // The concrete session reports compaction failures through its event stream.
                });
            } catch {
                // The concrete session reports compaction failures through its event stream.
            }
            callbacks.publishState();
            return { kind: 'compacted' };
        }

        const promptText = callbacks.decoratePrompt(request.text);
        if (tab.checkpointManager.rollbackPoint !== null) {
            tab.checkpointManager.discardSuspended();
            tab.diffManager.discardSuspended();
            tab.suspendedMessages = [];
        }
        tab.turnCounter++;
        const turnIndex = tab.turnCounter;
        tab.checkpointManager.startTurn(turnIndex);
        tab.diffManager.setCurrentTurn(turnIndex);
        callbacks.prepareRequest();
        callbacks.logPrompt();
        const augmentedPrompt = await callbacks.augmentPrompt(promptText);
        void this._runUserPrompt(
            tab,
            () => callbacks.prompt(augmentedPrompt, request.images, request.files),
        ).catch((error) => callbacks.reportDetachedFailure(error));
        return { kind: 'prompt_dispatched' };
    }

    async dispatchStreamingCommand(
        command: StreamingCommand,
        callbacks: StreamingCommandCallbacks,
    ): Promise<void> {
        if (command.type === 'abort') {
            await callbacks.abort();
            return;
        }

        callbacks.prepareRequest();
        callbacks.logPrompt(command.type);
        const text = await callbacks.augmentPrompt(command.text);
        if (command.type === 'steer') {
            await callbacks.steer(text, command.images, command.files);
            return;
        }
        await callbacks.followUp(text, command.images, command.files);
    }

    applyQueueControl(
        tab: ChatServiceTab,
        command: QueueControlCommand,
    ): QueueControlResult {
        let changed = false;
        switch (command.type) {
            case 'queueMessage':
                tab.queuedMessages.push(command.text);
                changed = true;
                break;
            case 'editQueuedMessage': {
                const trimmed = command.text.trim();
                if (Number.isInteger(command.index)
                    && command.index >= 0
                    && command.index < tab.queuedMessages.length
                    && trimmed) {
                    tab.queuedMessages[command.index] = trimmed;
                    changed = true;
                }
                break;
            }
            case 'removeQueuedMessage':
                if (Number.isInteger(command.index)
                    && command.index >= 0
                    && command.index < tab.queuedMessages.length) {
                    tab.queuedMessages.splice(command.index, 1);
                    changed = true;
                }
                break;
            case 'cancelQueue':
                changed = tab.queuedMessages.length > 0;
                tab.queuedMessages = [];
                break;
        }
        if (changed && tab.queuedRetryHead !== tab.queuedMessages[0]) {
            tab.queuedRetryHead = undefined;
            tab.queuedRetryAttempts = 0;
        }
        return { changed, queueLength: tab.queuedMessages.length };
    }

    reserveQueuedDispatch(tab: ChatServiceTab): boolean {
        if (tab.queuedMessages.length === 0) return false;
        tab.isStreamingLocal = true;
        return true;
    }

    async dispatchNextQueued(
        tab: ChatServiceTab,
        callbacks: QueuedDispatchCallbacks,
    ): Promise<void> {
        const text = tab.queuedMessages[0];
        if (text === undefined) return;
        if (tab.queuedRetryHead !== text) {
            tab.queuedRetryHead = text;
            tab.queuedRetryAttempts = 0;
        }

        let handledLocally: boolean;
        try {
            handledLocally = callbacks.handleLocalCommand(text);
        } catch (error) {
            tab.isStreamingLocal = false;
            callbacks.reportError(error);
            callbacks.publishState();
            return;
        }
        if (handledLocally) {
            tab.queuedMessages.shift();
            this._clearQueuedRetry(tab);
            tab.isStreamingLocal = false;
            callbacks.publishState();
            await this._dispatchFollowingQueuedHead(tab, callbacks);
            return;
        }

        const compactInstructions = parseCompactCommand(text);
        if (compactInstructions !== null) {
            tab.queuedMessages.shift();
            this._clearQueuedRetry(tab);
            callbacks.prepareRequest();
            try {
                await callbacks.compact(compactInstructions);
            } catch {
                // The concrete session reports compaction failures through its event stream.
            } finally {
                tab.isStreamingLocal = false;
                callbacks.publishState();
            }
            await this._dispatchFollowingQueuedHead(tab, callbacks);
            return;
        }

        let queuedPrompt: string;
        try {
            queuedPrompt = await callbacks.augmentPrompt(callbacks.decoratePrompt(text));
        } catch (error) {
            tab.isStreamingLocal = false;
            callbacks.reportError(error);
            callbacks.publishState();
            return;
        }

        // Queue controls remain available during asynchronous preparation.
        // Never dispatch an expansion prepared for a head that has changed.
        if (tab.queuedMessages[0] !== text) {
            await this.dispatchNextQueued(tab, callbacks);
            return;
        }

        tab.queuedMessages.shift();
        if (tab.checkpointManager.rollbackPoint !== null) {
            tab.checkpointManager.discardSuspended();
            tab.diffManager.discardSuspended();
            tab.suspendedMessages = [];
        }
        tab.turnCounter++;
        const turnIndex = tab.turnCounter;
        tab.checkpointManager.startTurn(turnIndex);
        tab.diffManager.setCurrentTurn(turnIndex);
        callbacks.prepareRequest();
        callbacks.logQueuedPrompt();
        callbacks.publishState();

        let agentStarted = false;
        void this._runUserPrompt(
            tab,
            () => callbacks.prompt(queuedPrompt, () => {
                agentStarted = true;
                this._clearQueuedRetry(tab);
            }),
        ).catch((error) => {
            if (!agentStarted) tab.queuedMessages.unshift(text);
            callbacks.reportError(error);
        }).finally(() => {
            if (!agentStarted && !callbacks.isSessionStreaming()) {
                tab.isStreamingLocal = false;
                callbacks.publishState();
                if (tab.queuedMessages[0] === text && tab.queuedRetryAttempts < 1) {
                    tab.queuedRetryAttempts++;
                    callbacks.scheduleRetry(async () => {
                        if (tab.queuedMessages[0] !== text || callbacks.isSessionStreaming()) return;
                        if (!this.reserveQueuedDispatch(tab)) return;
                        callbacks.publishState();
                        await this.dispatchNextQueued(tab, callbacks);
                    });
                }
            }
        });
    }

    private async _dispatchFollowingQueuedHead(
        tab: ChatServiceTab,
        callbacks: QueuedDispatchCallbacks,
    ): Promise<void> {
        if (tab.queuedMessages.length === 0 || callbacks.isSessionStreaming()) return;
        this.reserveQueuedDispatch(tab);
        callbacks.publishState();
        await this.dispatchNextQueued(tab, callbacks);
    }

    private _clearQueuedRetry(tab: ChatServiceTab): void {
        tab.queuedRetryHead = undefined;
        tab.queuedRetryAttempts = 0;
    }

    private async _runUserPrompt(
        tab: ChatServiceTab,
        prompt: () => Promise<void>,
    ): Promise<void> {
        const armToken = tab.turnNotificationGate.arm();
        try {
            await prompt();
        } finally {
            tab.turnNotificationGate.cancelArm(armToken);
        }
    }

    updateTabName(tab: ChatServiceTab): TabNameUpdate {
        const sessionName = tab.session.session?.sessionName;
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
            return { changed: true, name: tab.name };
        }

        if (!sessionName) {
            const firstUser = tab.session.getFirstTranscriptUserMessage();
            if (firstUser) {
                const derivedName = deriveTabNameFromUserContent(firstUser.content);
                if (derivedName) {
                    tab.session.setSessionName(derivedName);
                    if (tab.name !== derivedName) {
                        tab.name = derivedName;
                        return { changed: true, name: tab.name };
                    }
                }
            }
        }

        return { changed: false, name: tab.name };
    }

    buildState(tab: ChatServiceTab, context: ChatStateContext): SerializedAgentState {
        const state = tab.session.serializeState();
        state.isStreaming = tab.isStreamingLocal;
        state.isCompacting = tab.isCompacting;
        if (state.isStreaming || state.isCompacting) delete state.interruptedTurn;
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
        const controls = context.getControls?.();
        if (controls) state.controls = controls;
        state.pendingTools = [...tab.pendingTools.entries()].map(([toolCallId, tool]) => ({
            toolCallId,
            toolName: tool.name,
            startTime: tool.startTime,
            ...(tool.args === undefined ? {} : { args: safeSerialize(tool.args) }),
        }));

        // Both projections of a message share its identity, so the compact
        // context and the rendered transcript are annotated the same way. There
        // is deliberately no positional alignment step: compaction rewrites the
        // compact context, and matching by position there mismatched turns.
        const transcriptMessages = state.transcript?.items.map((item) => item.message) ?? [];
        annotateAssistantMeta(state.messages, tab.messageMeta);
        annotateAssistantMeta(transcriptMessages, tab.messageMeta);

        // Tool results carry a stable call id, so per-action durations can be
        // matched exactly instead of being aligned positionally.
        annotateToolDurations(state.messages, tab.toolDurations);
        annotateToolDurations(transcriptMessages, tab.toolDurations);
        return state;
    }
}

function annotateAssistantMeta(
    messages: readonly any[],
    metaByMessage: ReadonlyMap<string, TabMessageMeta>,
): void {
    if (metaByMessage.size === 0) return;
    for (const message of messages) {
        const key = assistantMetaKey(message);
        if (key === undefined) continue;
        const meta = metaByMessage.get(key);
        if (!meta) continue;
        message._thinkingDurationSec = meta.thinkingDurationSec;
        message._messageEndTime = meta.messageEndTime;
        if (meta.turnDurationMs !== undefined) {
            message._turnDurationMs = meta.turnDurationMs;
        }
        if (meta.totalTurnDurationMs !== undefined) {
            message._totalTurnDurationMs = meta.totalTurnDurationMs;
        }
        if (meta.codexTurn) message._codexTurnUsage = meta.codexTurn;
        if (meta.deepSeekTurn) message._deepSeekTurnUsage = meta.deepSeekTurn;
        if (meta.toolStats && meta.toolStats.length > 0) {
            message._toolStats = meta.toolStats;
        }
        if (meta.subagentStats && meta.subagentStats.length > 0) {
            message._subagentStats = meta.subagentStats.map(
                (entry: SubagentStatEntry) => ({ ...entry }),
            );
        }
    }
}

function annotateToolDurations(
    messages: readonly any[],
    durations: ReadonlyMap<string, number>,
): void {
    if (durations.size === 0) return;
    for (const message of messages) {
        if (!message || (message.role !== 'toolResult' && message.role !== 'tool')) continue;
        const toolCallId = message.toolCallId;
        if (typeof toolCallId !== 'string') continue;
        const durationMs = durations.get(toolCallId);
        if (durationMs !== undefined) message._toolDurationMs = durationMs;
    }
}

export function parseCompactCommand(text: string): string | undefined | null {
    const trimmed = text.trim();
    if (trimmed === '/compact') return undefined;
    if (trimmed.startsWith('/compact ')) {
        const instructions = trimmed.slice('/compact '.length).trim();
        return instructions || undefined;
    }
    return null;
}

export function countUserTurns(messages: readonly unknown[]): number {
    let count = 0;
    for (const message of messages) {
        if (message && typeof message === 'object'
            && (message as { role?: unknown }).role === 'user') {
            count++;
        }
    }
    return count;
}

function deriveTabNameFromUserContent(content: unknown): string {
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? String(content.find((part: any) => part?.type === 'text')?.text ?? '')
            : '';
    return text
        .replace(FILE_BLOCK_TITLE_RE, '')
        .replace(PLAN_MODE_TITLE_BLOCK_RE, '')
        .replace(ATTACHMENT_INSTRUCTIONS_TITLE_BLOCK_RE, '')
        .replace(REFERENCED_WORKSPACE_FILES_TITLE_RE, '')
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, 60);
}

function findMessageCutoff(messages: readonly any[], rollbackPoint: number): number {
    let userMessageCount = 0;
    for (let index = 0; index < messages.length; index++) {
        if (messages[index]?.role !== 'user') continue;
        userMessageCount++;
        if (userMessageCount > rollbackPoint) return index;
    }
    return -1;
}

/**
 * Stable identity for one assistant message's turn metadata.
 *
 * Position is unusable as a key: compaction rewrites the compact context, so an
 * ordinal recorded at turn end either stops existing or comes to name a
 * different message — losing the turn footer, or worse, showing an unrelated
 * older turn's numbers. The SDK requires `timestamp` on every message and both
 * the compact-context and full-transcript projections of a message carry the
 * same value, so it survives compaction, reload, and branch changes.
 */
export function assistantMetaKey(message: any): string | undefined {
    if (!message || message.role !== 'assistant') return undefined;
    const timestamp = message.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
    return String(timestamp);
}

function lastAssistantMessage(messages: readonly any[]): any | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'assistant') return messages[index];
    }
    return undefined;
}
