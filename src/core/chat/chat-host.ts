import type {
    AgentClientMessage,
    CacheMode,
    SerializedAgentState,
} from '../../shared/agent-protocol';
import type { TurnCompletionInfo } from '../../shared/turn-notification';
import { safeSerialize } from '../../shared/safe-serialize';
import type { ProjectToolSelectionDefault } from '../../shared/project-tool-default';
import { ChatApplication, type ApplicationTab, type RegisterTabOptions } from './chat-application';
import {
    ChatCommandService,
    type ChatCommandCallbacks,
    type ChatCommandIntent,
    type ChatCommandSession,
} from './chat-command-service';
import {
    ChatService,
    type ChatServiceDiff,
    type ChatServiceCheckpoint,
    type ChatServiceSession,
    type ChatStateContext,
    type AgentEndAccounting,
    type FileHistoryTarget,
    type SessionProjectionResetTarget,
} from './chat-service';
import { TabRegistry } from './tab-registry';
import {
    classifyAssistantTurnIssue,
    findLastAssistantMessage,
    shouldDispatchQueueAfterTerminal,
    shouldSyncStateForEvent,
    turnCompletionOutcome,
} from './chat-event-policy';

export type ChatHostSession = ChatServiceSession & ChatCommandSession & {
    newSession(): Promise<void>;
    loadSession(sessionPath: string): Promise<void>;
    getTranscriptUserTurnCount(): number;
    setMessages(messages: any[]): void;
};

export type ChatHostTab = ApplicationTab & SessionProjectionResetTarget & FileHistoryTarget & {
    readonly session: ChatHostSession;
    readonly diffManager: ChatServiceDiff & FileHistoryTarget['diffManager'] & { clearAll(): void };
    readonly checkpointManager: ChatServiceCheckpoint
        & FileHistoryTarget['checkpointManager']
        & { clearAll(): void };
    projectToolDefault?: ProjectToolSelectionDefault;
};

export type ChatHostTabRequest =
    | { readonly kind: 'new' }
    | { readonly kind: 'sessionPath'; readonly sessionPath: string; readonly name?: string };

export interface PersistedChatHostTabs {
    readonly tabs: readonly { readonly name: string; readonly sessionPath: string }[];
    readonly activeIndex: number;
}

export type ChatHostDispatchResult =
    | { readonly ok: true; readonly result?: unknown }
    | { readonly ok: false; readonly code: 'tab_not_found' | 'command_failed'; readonly message: string };

export interface ChatHostPreferencePort<TTab extends ChatHostTab> {
    getCacheMode(): CacheMode;
    setCacheMode(mode: CacheMode): Promise<void>;
    getFavorites(): readonly string[];
    setFavorites(favorites: readonly string[]): Promise<void>;
    getProjectToolDefault(): ProjectToolSelectionDefault | undefined;
    applyPersistedToolSelection(tab: TTab): void;
    refreshCacheEffective(tab: TTab): void;
    getDisabledTools(tab: TTab): readonly string[];
    setDisabledTools(tab: TTab, disabled: readonly string[]): Promise<void>;
    setTodoEnabled(tab: TTab, enabled: boolean): Promise<void>;
    setSubagentsEnabled(tab: TTab, enabled: boolean): Promise<boolean>;
    setPlanModeEnabled(tab: TTab, enabled: boolean): Promise<void>;
    setFileUndoViewEnabled(tab: TTab, enabled: boolean): Promise<void>;
}

export interface ChatHostEffects<TTab extends ChatHostTab> {
    bindTab(tab: TTab): void;
    persistTabs(): void;
    tabsChanged(): void;
    publishState(tabId: string): void;
    openTab(tabId: string): void;
    activeTabChanged(tab: TTab): void;
    tabRenamed(tabId: string, name: string): void;
    modelsChanged(): void;
    reportCommandFailure(messageType: string, tabId: string, error: unknown): void;
    restoreFailed(
        entry: { readonly name: string; readonly sessionPath: string },
        error: unknown,
    ): void;
}

export interface ChatHostEventEffects<TTab extends ChatHostTab> {
    agentStarted?(tab: TTab): void;
    streamingContextChanged?(isStreaming: boolean): void;
    reportAgentError?(tab: TTab, raw: string | undefined, assistantMessage?: any): void;
    reportAgentNotice?(
        tab: TTab,
        message: string,
        severity: 'warning' | 'info',
        assistantMessage?: any,
    ): void;
    showAutoRetry?(event: any): void;
    logTurnEnd?(tab: TTab, assistantMessage: any | undefined): void;
    sweepPendingTools?(tab: TTab, assistantMessage: any | undefined): void;
    completeAgentEndAccounting?(tab: TTab): Promise<AgentEndAccounting | undefined>;
    notifyTurnCompletion?(tab: TTab, completion: TurnCompletionInfo): void;
    emitAgentEvent(tabId: string, event: unknown): void;
    dispatchNextQueued(tab: TTab): Promise<void>;
}

export interface ChatHostOptions<TTab extends ChatHostTab> {
    readonly tabs: TabRegistry<TTab>;
    readonly chat: ChatService;
    readonly commands?: ChatCommandService;
    readonly factory: (request: ChatHostTabRequest) => Promise<TTab>;
    readonly commandCallbacks: (
        tab: TTab,
    ) => Omit<ChatCommandCallbacks, 'getFavorites'>;
    readonly stateContext: (
        tab: TTab,
    ) => Omit<ChatStateContext, 'activeTabId' | 'getTabs'>;
    readonly preferences: ChatHostPreferencePort<TTab>;
    readonly effects: ChatHostEffects<TTab>;
    readonly eventEffects: ChatHostEventEffects<TTab>;
}

/** Shared headless orchestration boundary for chat tabs and semantic commands. */
export class ChatHost<TTab extends ChatHostTab> {
    readonly application: ChatApplication<TTab>;
    readonly chat: ChatService;
    readonly commands: ChatCommandService;

    constructor(private readonly _options: ChatHostOptions<TTab>) {
        this.application = new ChatApplication(_options.tabs);
        this.chat = _options.chat;
        this.commands = _options.commands ?? new ChatCommandService(_options.chat);
    }

    get tabs(): TabRegistry<TTab> {
        return this.application.tabs;
    }

    get activeTabId(): string {
        return this.tabs.activeId;
    }

    get activeTab(): TTab | undefined {
        return this.tabs.active;
    }

    register(tab: TTab, options: RegisterTabOptions = {}): void {
        this.application.register(tab, options);
    }

    async createTab(): Promise<string> {
        const previousActiveId = this.activeTabId;
        const tab = await this._options.factory({ kind: 'new' });
        try {
            this.application.register(tab, { activate: true });
            this._options.effects.bindTab(tab);
        } catch (error) {
            await this._disposeFailedTab(tab);
            if (previousActiveId) this.application.activate(previousActiveId);
            throw error;
        }
        this._options.effects.persistTabs();
        this._options.effects.tabsChanged();
        this._options.effects.openTab(tab.id);
        this._options.effects.publishState(tab.id);
        return tab.id;
    }

    async createTabFromSessionPath(sessionPath: string): Promise<string> {
        const tab = await this._options.factory({ kind: 'sessionPath', sessionPath });
        try {
            this.refreshTabName(tab);
            this.application.register(tab);
            this._options.effects.bindTab(tab);
        } catch (error) {
            await this._disposeFailedTab(tab);
            throw error;
        }
        this._options.effects.persistTabs();
        return tab.id;
    }

    async restoreTabs(
        persisted: PersistedChatHostTabs,
        bootstrapTabId?: string,
    ): Promise<string[]> {
        const restoredIds: string[] = [];
        for (const entry of persisted.tabs) {
            let tab: TTab | undefined;
            try {
                tab = await this._options.factory({
                    kind: 'sessionPath',
                    sessionPath: entry.sessionPath,
                    name: entry.name,
                });
                tab.name = entry.name;
                this.refreshTabName(tab);
                this.application.register(tab);
                this._options.effects.bindTab(tab);
                restoredIds.push(tab.id);
            } catch (error) {
                if (tab) await this._disposeFailedTab(tab);
                this._options.effects.restoreFailed(entry, error);
            }
        }

        if (restoredIds.length === 0) return restoredIds;
        if (bootstrapTabId && this.tabs.has(bootstrapTabId)) {
            await this.application.remove(bootstrapTabId);
        }
        const activeIndex = Math.min(
            Math.max(0, Math.trunc(persisted.activeIndex ?? 0)),
            restoredIds.length - 1,
        );
        this.application.activate(restoredIds[activeIndex]);
        this._options.effects.publishState(this.activeTabId);
        return restoredIds;
    }

    async dropTab(tabId: string): Promise<boolean> {
        if (!this.tabs.has(tabId)) return false;
        await this.application.remove(tabId);
        this._options.effects.persistTabs();
        this._options.effects.tabsChanged();
        return true;
    }

    async closeTab(tabId: string): Promise<boolean> {
        if (this.tabs.size <= 1 || !this.tabs.has(tabId)) return false;
        await this.application.remove(tabId);
        this._options.effects.persistTabs();
        this._options.effects.tabsChanged();
        if (this.activeTabId) this._options.effects.publishState(this.activeTabId);
        return true;
    }

    activateTab(tabId: string): boolean {
        if (!this.application.activate(tabId)) return false;
        const tab = this.activeTab;
        if (!tab) return false;
        this._options.effects.activeTabChanged(tab);
        return true;
    }

    async detachTab(tabId: string): Promise<boolean> {
        if (!this.tabs.has(tabId)) return false;
        await this.application.remove(tabId);
        return true;
    }

    switchTab(tabId: string): boolean {
        if (!this.application.activate(tabId, { clearNotification: true })) return false;
        const tab = this.activeTab;
        if (!tab) return false;
        this._options.effects.activeTabChanged(tab);
        this._options.effects.persistTabs();
        this._options.effects.tabsChanged();
        this._options.effects.publishState(tab.id);
        return true;
    }

    async setActiveTodoEnabled(enabled: boolean): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        await this._options.preferences.setTodoEnabled(tab, enabled);
        this._options.preferences.applyPersistedToolSelection(tab);
        this._options.effects.tabsChanged();
        return true;
    }

    async setActiveSubagentsEnabled(enabled: boolean): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        const changed = await this._options.preferences.setSubagentsEnabled(tab, enabled);
        if (!changed) return false;
        this._options.preferences.applyPersistedToolSelection(tab);
        this._options.effects.tabsChanged();
        return true;
    }

    async setActivePlanModeEnabled(enabled: boolean): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        await this._options.preferences.setPlanModeEnabled(tab, enabled);
        this._options.effects.tabsChanged();
        return true;
    }

    async setActiveFileUndoViewEnabled(enabled: boolean): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        await this._options.preferences.setFileUndoViewEnabled(tab, enabled);
        this._options.effects.publishState(tab.id);
        this._options.effects.tabsChanged();
        return true;
    }

    async setActiveToolDisabled(toolName: string, disabled: boolean): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        if (toolName === 'todo') return this.setActiveTodoEnabled(!disabled);
        if (toolName === 'subagent') return this.setActiveSubagentsEnabled(!disabled);

        const current = new Set(this._options.preferences.getDisabledTools(tab));
        if (disabled) current.add(toolName);
        else current.delete(toolName);
        await this._options.preferences.setDisabledTools(tab, [...current]);
        this._options.preferences.applyPersistedToolSelection(tab);
        this._options.effects.tabsChanged();
        return true;
    }

    async setActiveToolsBulk(disabled: readonly string[]): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        const filtered = [...new Set(
            disabled.filter((tool) => typeof tool === 'string' && tool.length > 0),
        )];
        await this._options.preferences.setTodoEnabled(tab, !filtered.includes('todo'));
        await this._options.preferences.setSubagentsEnabled(tab, !filtered.includes('subagent'));
        await this._options.preferences.setDisabledTools(
            tab,
            filtered.filter((tool) => tool !== 'todo' && tool !== 'subagent'),
        );
        this._options.preferences.applyPersistedToolSelection(tab);
        this._options.effects.tabsChanged();
        return true;
    }

    async applyActiveToolSelection(input: {
        readonly todoEnabled: boolean;
        readonly subagentsEnabled: boolean;
        readonly disabled: readonly string[];
    }): Promise<boolean> {
        const tab = this._idleActiveTab();
        if (!tab) return false;
        const disabled = [...new Set(input.disabled.filter((tool) => (
            typeof tool === 'string'
            && tool.length > 0
            && tool !== 'todo'
            && tool !== 'subagent'
        )))];
        await this._options.preferences.setTodoEnabled(tab, input.todoEnabled);
        await this._options.preferences.setSubagentsEnabled(tab, input.subagentsEnabled);
        await this._options.preferences.setDisabledTools(tab, disabled);
        this._options.preferences.applyPersistedToolSelection(tab);
        this._options.effects.tabsChanged();
        return true;
    }

    getState(tabId?: string): SerializedAgentState | undefined {
        const targetId = tabId ?? this.activeTabId;
        const tab = this.tabs.get(targetId);
        if (!tab) return undefined;
        return this.chat.buildState(tab as any, {
            ...this._options.stateContext(tab),
            activeTabId: this.activeTabId,
            getTabs: () => this.application.getTabInfos(),
        });
    }

    async dispatch(
        message: AgentClientMessage,
        sourceTabId?: string,
    ): Promise<ChatHostDispatchResult> {
        const targetId = sourceTabId ?? this.activeTabId;
        const tab = this.tabs.get(targetId);
        if (!tab) {
            return {
                ok: false,
                code: 'tab_not_found',
                message: `Chat tab not found: ${targetId}`,
            };
        }

        try {
            const callbacks = this._options.commandCallbacks(tab);
            const outcome = await this.commands.dispatch(tab as any, message, {
                ...callbacks,
                getFavorites: () => [...this._options.preferences.getFavorites()],
            });
            if (outcome.intent) await this._executeIntent(tab, outcome.intent);
            return outcome.result === undefined
                ? { ok: true }
                : { ok: true, result: outcome.result };
        } catch (error) {
            this._options.effects.reportCommandFailure(message.type, targetId, error);
            return {
                ok: false,
                code: 'command_failed',
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async handleEvent(tab: TTab, event: any): Promise<void> {
        const runtime = tab as any;
        const eventEffects = this._options.eventEffects;
        let dispatchQueuedAfterEvent = false;
        let queuedDispatchReserved = false;

        if (event.type === 'agent_start') runtime.session.markTurnStarted?.();
        this.chat.reduceEvent(runtime, event);

        if (event.type === 'agent_start') {
            eventEffects?.agentStarted?.(tab);
            if (tab.id === this.activeTabId) {
                eventEffects?.streamingContextChanged?.(true);
            }
            this._options.effects.tabsChanged();
        }

        if (event.type === 'message_update'
            && event.assistantMessageEvent?.type === 'error'
            && event.assistantMessageEvent.reason === 'error') {
            eventEffects?.reportAgentError?.(
                tab,
                event.assistantMessageEvent.error?.errorMessage,
            );
        }

        if (event.type === 'auto_retry_start') eventEffects?.showAutoRetry?.(event);

        if (event.type === 'compaction_start') {
            if (tab.id === this.activeTabId) {
                eventEffects?.streamingContextChanged?.(true);
            }
            this._options.effects.tabsChanged();
        }

        if (event.type === 'compaction_end') {
            if (tab.id === this.activeTabId && !runtime.isStreamingLocal) {
                eventEffects?.streamingContextChanged?.(false);
            }
            this._options.effects.tabsChanged();
        }

        if (event.type === 'agent_end') {
            runtime.session.markTurnCompleted?.();
            const lastAssistant = findLastAssistantMessage(runtime.session.getMessages());
            if (!runtime.errorReportedThisRun && lastAssistant) {
                const issue = classifyAssistantTurnIssue(lastAssistant);
                if (issue?.kind === 'provider-error') {
                    eventEffects?.reportAgentError?.(
                        tab,
                        issue.message,
                        lastAssistant,
                    );
                } else if (issue?.kind === 'notice' && issue.message && issue.severity) {
                    eventEffects?.reportAgentNotice?.(
                        tab,
                        issue.message,
                        issue.severity,
                        lastAssistant,
                    );
                }
            }
            eventEffects?.logTurnEnd?.(tab, lastAssistant);
            eventEffects?.sweepPendingTools?.(tab, lastAssistant);
            const projection = this.chat.beginAgentEnd(
                runtime,
                turnCompletionOutcome(lastAssistant),
            );
            const accounting = await eventEffects?.completeAgentEndAccounting?.(tab);
            this.chat.completeAgentEnd(runtime, projection, accounting);
            if (tab.id === this.activeTabId) {
                eventEffects?.streamingContextChanged?.(false);
            }
            this._options.effects.persistTabs();
            this._options.effects.tabsChanged();
            dispatchQueuedAfterEvent = shouldDispatchQueueAfterTerminal(event.type, {
                isStreamingLocal: runtime.isStreamingLocal,
                isSessionStreaming: runtime.session.serializeState().isStreaming,
            });
        }

        if (event.type === 'agent_settled') {
            const completion = this.chat.settleAgent(runtime);
            if (completion) {
                eventEffects?.notifyTurnCompletion?.(tab, completion);
                if (tab.id !== this.activeTabId) {
                    runtime.hasNotification = true;
                    this._options.effects.persistTabs();
                    this._options.effects.tabsChanged();
                }
            }
            dispatchQueuedAfterEvent = shouldDispatchQueueAfterTerminal(event.type, {
                isStreamingLocal: runtime.isStreamingLocal,
                isSessionStreaming: runtime.session.isStreaming,
            });
        }

        if (event.type === 'message_end') {
            // The SDK finalizes the message into the session branch only after
            // its listeners have been invoked (`appendMessage` runs right after
            // `_emit` in `_handleAgentEvent`). Reading the branch here
            // (transcript projection and first-user-message title derivation)
            // would see the message one step late, so the user's own prompt
            // would not appear in the chat until the next sync. Deferring by
            // one microtask lets the synchronous append land first.
            queueMicrotask(() => {
                this.refreshTabName(tab);
                this._options.effects.publishState(tab.id);
            });
        } else {
            this.refreshTabName(tab);
        }

        if (dispatchQueuedAfterEvent && this.chat.reserveQueuedDispatch(runtime)) {
            queuedDispatchReserved = true;
            if (event.type === 'agent_settled') {
                this._options.effects.publishState(tab.id);
            }
        }

        eventEffects.emitAgentEvent(tab.id, safeSerialize(event));

        if (shouldSyncStateForEvent(event.type)) {
            if (event.type !== 'message_end') {
                this._options.effects.publishState(tab.id);
                if (tab.id !== this.activeTabId
                    && (event.type === 'agent_start' || event.type === 'agent_end')) {
                    this._options.effects.publishState(this.activeTabId);
                }
            }
        }

        if (event.type === 'compaction_end' && event.errorMessage) {
            const callbacks = this._options.commandCallbacks(tab);
            callbacks.emit({ type: 'error', message: event.errorMessage });
        }

        if (dispatchQueuedAfterEvent && queuedDispatchReserved) {
            await eventEffects.dispatchNextQueued(tab);
        }
    }

    private async _disposeFailedTab(tab: TTab): Promise<void> {
        if (this.tabs.has(tab.id)) {
            try {
                await tab.disposeResources();
            } catch {
                // TabRuntime attempts every owned disposer before rejecting.
            } finally {
                this.tabs.remove(tab.id);
            }
            return;
        }
        try {
            await tab.disposeResources();
        } catch {
            // Cleanup is best-effort here; the original construction error wins.
        }
    }

    private _idleActiveTab(): TTab | undefined {
        const tab = this.activeTab;
        return tab && !this.application.isBusy(tab) ? tab : undefined;
    }

    refreshTabName(tab: TTab): void {
        const update = this.chat.updateTabName(tab as any);
        if (!update.changed) return;
        this._options.effects.persistTabs();
        this._options.effects.tabRenamed(tab.id, update.name);
        this._options.effects.tabsChanged();
    }

    private async _executeIntent(tab: TTab, intent: ChatCommandIntent): Promise<void> {
        switch (intent.type) {
            case 'setCacheMode':
                await this._options.preferences.setCacheMode(intent.mode);
                for (const candidate of this.tabs.values()) {
                    this._options.preferences.refreshCacheEffective(candidate);
                    this._options.effects.publishState(candidate.id);
                }
                return;
            case 'setModel':
                await this._applyIdleSessionControl(tab, async () => {
                    await tab.session.setModel(intent.provider, intent.modelId);
                    this._options.effects.modelsChanged();
                });
                return;
            case 'setThinkingLevel':
                await this._applyIdleSessionControl(tab, () => {
                    tab.session.setThinkingLevel(intent.level);
                });
                return;
            case 'setTodoEnabled':
                await this._applyActiveControl(
                    tab,
                    () => this.setActiveTodoEnabled(intent.enabled),
                );
                return;
            case 'setSubagentsEnabled':
                await this._applyActiveControl(
                    tab,
                    () => this.setActiveSubagentsEnabled(intent.enabled),
                );
                return;
            case 'setPlanModeEnabled':
                await this._applyActiveControl(
                    tab,
                    () => this.setActivePlanModeEnabled(intent.enabled),
                );
                return;
            case 'setFileUndoViewEnabled':
                await this._applyActiveControl(
                    tab,
                    () => this.setActiveFileUndoViewEnabled(intent.enabled),
                    false,
                );
                return;
            case 'setToolDisabled':
                await this._applyActiveControl(
                    tab,
                    () => this.setActiveToolDisabled(intent.toolName, intent.disabled),
                );
                return;
            case 'setToolsBulk':
                await this._applyActiveControl(
                    tab,
                    () => this.setActiveToolsBulk(intent.disabled),
                );
                return;
            case 'toggleFavorite': {
                const key = `${intent.provider}:${intent.modelId}`;
                const favorites = new Set(this._options.preferences.getFavorites());
                if (favorites.has(key)) favorites.delete(key);
                else favorites.add(key);
                await this._options.preferences.setFavorites([...favorites]);
                this._options.effects.modelsChanged();
                return;
            }
            case 'newSession': {
                await tab.session.newSession();
                const projectToolDefault = this._options.preferences.getProjectToolDefault();
                tab.projectToolDefault = projectToolDefault;
                this._options.preferences.applyPersistedToolSelection(tab);
                this.chat.resetSessionProjection(
                    tab,
                    projectToolDefault,
                    tab.session.getTranscriptUserTurnCount(),
                );
                this._options.effects.persistTabs();
                this._options.effects.tabsChanged();
                this._options.effects.tabRenamed(tab.id, tab.name);
                this._options.effects.publishState(tab.id);
                return;
            }
            case 'loadSession':
                await tab.session.loadSession(intent.sessionPath);
                tab.projectToolDefault = undefined;
                this._options.preferences.applyPersistedToolSelection(tab);
                this.chat.resetSessionProjection(
                    tab,
                    undefined,
                    tab.session.getTranscriptUserTurnCount(),
                );
                this.refreshTabName(tab);
                this._options.effects.persistTabs();
                this._options.effects.publishState(tab.id);
                return;
            case 'createTab':
                await this.createTab();
                return;
            case 'closeTab':
                await this.closeTab(intent.tabId);
                return;
            case 'switchTab':
                this.switchTab(intent.tabId);
                return;
        }
    }

    private async _applyIdleSessionControl(
        sourceTab: TTab,
        update: () => void | Promise<void>,
    ): Promise<void> {
        if (sourceTab.id !== this.activeTabId || this._idleActiveTab() !== sourceTab) {
            throw new Error('The active chat is busy or unavailable.');
        }
        await update();
        this._options.effects.publishState(sourceTab.id);
    }

    private async _applyActiveControl(
        sourceTab: TTab,
        update: () => Promise<boolean>,
        publish = true,
    ): Promise<void> {
        if (sourceTab.id !== this.activeTabId || !await update()) {
            throw new Error('The active chat is busy or unavailable.');
        }
        if (publish) this._options.effects.publishState(sourceTab.id);
    }
}
