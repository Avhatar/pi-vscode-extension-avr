import type {
    AgentClientMessage,
    AgentTabControls,
    CacheEffective,
    CacheMode,
    CodexTurnUsage,
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

export interface TabNameUpdate {
    readonly changed: boolean;
    readonly name: string;
}

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
        }

        if (event.type === 'tool_execution_start' && event.toolCallId) {
            tab.pendingTools.set(String(event.toolCallId), {
                name: String(event.toolName ?? '?'),
                startTime: this._now(),
                ...(event.args === undefined ? {} : { args: safeSerialize(event.args) }),
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
        tab.pendingTools.clear();
        tab.lastTurnEndAt = projection.turnEndAt;
    }

    settleAgent(tab: ChatServiceTab): TurnCompletionInfo | undefined {
        return tab.turnNotificationGate.onAgentSettled();
    }

    resetSessionProjection(
        tab: SessionProjectionResetTarget,
        projectToolDefault: ProjectToolSelectionDefault | undefined,
        messages: readonly unknown[] = [],
    ): void {
        tab.diffManager.clearAll();
        tab.checkpointManager.clearAll();
        tab.resetSessionProjection(projectToolDefault, countUserTurns(messages));
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
                await callbacks.compact(compactInstructions);
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

function findMessageCutoff(messages: readonly any[], rollbackPoint: number): number {
    let userMessageCount = 0;
    for (let index = 0; index < messages.length; index++) {
        if (messages[index]?.role !== 'user') continue;
        userMessageCount++;
        if (userMessageCount > rollbackPoint) return index;
    }
    return -1;
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
