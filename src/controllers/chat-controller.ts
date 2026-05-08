import * as vscode from 'vscode';
import { unlink } from 'fs/promises';
import { PiSessionManager } from '../pi/session';
import type {
    ClientMessage, ServerMessage, TabInfo,
    LauncherState, LauncherTabInfo, LauncherSessionInfo,
} from '../shared/protocol';
import { DiffManager } from '../providers/diff';
import { CheckpointManager } from '../providers/checkpoint';
import { onAuthChanged } from '../pi/auth';
import { getCodexUsageStore } from '../pi/codex-usage-store';
import { WorkspaceFileMentions } from '../workspace/file-mentions';
import type { CodexTurnUsage, CodexTurnWindowDelta, CodexUsageSnapshot, CodexUsageWindow } from '../shared/protocol';

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
    codexTurn?: CodexTurnUsage;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

interface TabState {
    id: string;
    name: string;
    session: PiSessionManager;
    diffManager: DiffManager;
    checkpointManager: CheckpointManager;
    turnCounter: number;
    suspendedMessages: any[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    messageMeta: Map<number, MessageMeta>;
    hasNotification: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    queuedMessages: string[];
    /** Locally tracked streaming flag – the SDK's isStreaming lags behind agent_end. */
    isStreamingLocal: boolean;
    /** Codex usage snapshot captured at agent_start; used to compute per-turn delta on agent_end. */
    codexTurnBaseline?: CodexUsageSnapshot | null;
}

interface PersistedTabsState {
    tabs: Array<{ name: string; sessionPath: string }>;
    activeIndex: number;
}

/**
 * A view that displays chat state. The controller routes messages to sinks
 * whose `tabFilter` matches the message's tab.
 *
 * - `tabFilter: 'active'` — receives messages for whichever tab is currently
 *   active (used by the sidebar, which always shows the active tab).
 * - `tabFilter: <tabId>` — receives messages only for that specific tab
 *   (used by editor panels, each bound to one tab).
 */
export interface ChatViewSink {
    readonly tabFilter: string | 'active';
    post(message: ServerMessage): void;
}

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

function makeTabState(
    id: string,
    session: PiSessionManager,
    diffManager: DiffManager,
    checkpointManager: CheckpointManager,
): TabState {
    return {
        id,
        name: 'New Agent',
        session,
        diffManager,
        checkpointManager,
        turnCounter: 0,
        suspendedMessages: [],
        streamingText: '',
        streamingThinking: '',
        isThinking: false,
        thinkingStartTime: 0,
        streamingThinkingDuration: 0,
        agentStartTime: 0,
        messageMeta: new Map(),
        hasNotification: false,
        pendingApprovals: new Map(),
        queuedMessages: [],
        isStreamingLocal: false,
    };
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { type: obj?.type, _serializationFailed: true };
    }
}

/**
 * Owns all chat tab state and routes messages from views to the appropriate
 * tab. View layers (sidebar, editor panels) attach themselves as a
 * {@link ChatViewSink} via {@link addSink} and forward webview messages via
 * {@link handleMessage} (passing their bound `tabId` if any).
 */
export class ChatController implements vscode.Disposable {
    private _outputChannel: vscode.OutputChannel;
    private _context: vscode.ExtensionContext;

    private _tabs = new Map<string, TabState>();
    private _activeTabId = '';
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _authChangedSubscription?: vscode.Disposable;
    private _codexUsageUnsubscribe?: () => void;
    private _fileMentions: WorkspaceFileMentions;

    private _sinks = new Set<ChatViewSink>();

    private _onTabRenamed = new vscode.EventEmitter<{ tabId: string; name: string }>();
    /** Fires when a tab's display name changes — editor panels listen to update their title. */
    readonly onTabRenamed = this._onTabRenamed.event;

    private _onLauncherStateChanged = new vscode.EventEmitter<void>();
    /** Fires when the launcher's view of the world (open tabs, streaming, etc.) changes. */
    readonly onLauncherStateChanged = this._onLauncherStateChanged.event;

    /** Tracks which `tabId`s currently have a visible editor panel. */
    private _openPanels = new Map<string, { reveal(viewColumn?: vscode.ViewColumn): void }>();

    /** Wired by the host (extension.ts) to construct a `ChatPanel` for a tab. */
    private _panelOpener?: (tabId: string) => void;

    constructor(
        context: vscode.ExtensionContext,
        initialSession: PiSessionManager,
        initialDiffManager: DiffManager,
        initialCheckpointManager: CheckpointManager,
        outputChannel: vscode.OutputChannel,
    ) {
        this._context = context;
        this._outputChannel = outputChannel;
        this._fileMentions = new WorkspaceFileMentions(outputChannel);
        this._fileMentions.warmup();

        const id = nextTabId();
        const tab = makeTabState(id, initialSession, initialDiffManager, initialCheckpointManager);
        this._tabs.set(id, tab);
        this._activeTabId = id;
        this._subscribeTab(tab);

        this._authChangedSubscription = onAuthChanged(() => {
            this._broadcastModels();
        });

        this._codexUsageUnsubscribe = getCodexUsageStore().onChange((snapshot) => {
            this._postBroadcast({ type: 'codexUsage', usage: snapshot });
        });
    }

    addSink(sink: ChatViewSink): void {
        this._sinks.add(sink);
        // Replay the latest known Codex usage so a freshly opened webview can
        // render the indicator immediately, without waiting for the next turn.
        const usage = getCodexUsageStore().getCurrent();
        if (usage) {
            sink.post({ type: 'codexUsage', usage });
        }
    }

    removeSink(sink: ChatViewSink): void {
        this._sinks.delete(sink);
    }

    /**
     * Register the factory that creates an editor `ChatPanel` for a given
     * tab. Called once during activation by `extension.ts`.
     */
    setPanelOpener(opener: (tabId: string) => void): void {
        this._panelOpener = opener;
    }

    /** Called by `ChatPanel` when its constructor finishes. */
    registerPanel(tabId: string, panel: { reveal(viewColumn?: vscode.ViewColumn): void }): void {
        this._openPanels.set(tabId, panel);
        this._activeTabId = tabId;
        this._persistTabs();
        this._onLauncherStateChanged.fire();
    }

    /** Called by `ChatPanel.dispose`. */
    unregisterPanel(tabId: string, panel?: { reveal(viewColumn?: vscode.ViewColumn): void }): void {
        const current = this._openPanels.get(tabId);
        if (!current || (panel && current !== panel)) {
            return;
        }
        this._openPanels.delete(tabId);
        this._onLauncherStateChanged.fire();
    }

    /**
     * Reveal the panel for `tabId` if one exists, otherwise create a new one
     * via the registered `_panelOpener`.
     */
    openOrFocusPanel(tabId: string): void {
        const existing = this._openPanels.get(tabId);
        if (existing) {
            existing.reveal();
            return;
        }
        this._panelOpener?.(tabId);
    }

    /**
     * Drop the in-memory `TabState` for `tabId` (also disposing any open panel).
     * The underlying session file on disk is left intact so the user can
     * reopen the chat from "recent sessions".
     */
    async dropTab(tabId: string): Promise<void> {
        const panel = this._openPanels.get(tabId);
        if (panel && 'dispose' in panel && typeof (panel as any).dispose === 'function') {
            try { (panel as any).dispose(); } catch { /* ignore */ }
        }

        const tab = this._tabs.get(tabId);
        if (!tab) {
            this._onLauncherStateChanged.fire();
            return;
        }

        this._unsubscribeTab(tabId);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        await tab.session.dispose();
        this._tabs.delete(tabId);

        if (tabId === this._activeTabId) {
            const next = this._tabs.keys().next().value;
            this._activeTabId = next ?? '';
        }

        this._persistTabs();
        this._onLauncherStateChanged.fire();
    }

    /** Build a snapshot of launcher state (open tabs + recent closed sessions). */
    async computeLauncherState(): Promise<LauncherState> {
        // "Open chats" only includes tabs with a visible editor panel. A
        // bare TabState without a panel is an internal placeholder (e.g. the
        // initial empty tab), not something the user thinks of as open.
        const tabs: LauncherTabInfo[] = [...this._tabs.values()]
            .filter(tab => this._openPanels.has(tab.id))
            .map(tab => ({
                id: tab.id,
                name: tab.name,
                isStreaming: tab.isStreamingLocal,
                hasNotification: tab.hasNotification,
                isOpen: true,
                modelLabel: tab.session.getCurrentModel()?.id,
            }));

        // Mark sessions whose path matches a panel-attached tab so the
        // History section doesn't duplicate them.
        const openPaths = new Set(
            [...this._tabs.values()]
                .filter(t => this._openPanels.has(t.id))
                .map(t => t.session.sessionPath)
                .filter((p): p is string => !!p),
        );
        let recentSessions: LauncherSessionInfo[] = [];
        const anySession = this._tabs.values().next().value?.session;
        if (anySession) {
            try {
                const sessions = await anySession.getSessions();
                recentSessions = sessions.map((s: any) => ({
                    path: s.path,
                    name: s.name,
                    firstMessage: s.firstMessage,
                    lastModified: s.lastModified,
                    isOpen: openPaths.has(s.path),
                }));
            } catch {
                recentSessions = [];
            }
        }

        return { tabs, recentSessions };
    }

    /** Expose the active tab's session for global commands (palette, keybindings). */
    get activeSession(): PiSessionManager | undefined {
        return this._tabs.get(this._activeTabId)?.session;
    }

    get activeTabId(): string {
        return this._activeTabId;
    }

    /** Lookup an existing tab whose session was loaded from `sessionPath`. */
    findTabIdBySessionPath(sessionPath: string): string | undefined {
        if (!sessionPath) return undefined;
        for (const [id, tab] of this._tabs) {
            if (tab.session.sessionPath === sessionPath) return id;
        }
        return undefined;
    }

    /** Display name of `tabId`, used by panels to set their editor-tab title. */
    getTabName(tabId: string): string | undefined {
        return this._tabs.get(tabId)?.name;
    }

    /** Delete a closed session file from history. Open chat panels must be closed first. */
    async deleteHistorySession(sessionPath: string): Promise<void> {
        if (!sessionPath) {
            throw new Error('Session path is missing.');
        }

        const openTab = [...this._tabs.values()].find(tab => (
            this._openPanels.has(tab.id) && tab.session.sessionPath === sessionPath
        ));
        if (openTab) {
            throw new Error('Close the chat before deleting it from history.');
        }

        const anySession = this._tabs.values().next().value?.session;
        const sessions = anySession ? await anySession.getSessions() : [];
        if (!sessions.some((session: any) => session.path === sessionPath)) {
            throw new Error('Session was not found in history.');
        }

        const loadedTabId = this.findTabIdBySessionPath(sessionPath);
        if (loadedTabId) {
            const tab = this._tabs.get(loadedTabId);
            if (tab) {
                this._unsubscribeTab(loadedTabId);
                tab.diffManager.dispose();
                tab.checkpointManager.dispose();
                await tab.session.dispose();
                this._tabs.delete(loadedTabId);
                if (loadedTabId === this._activeTabId) {
                    this._activeTabId = this._tabs.keys().next().value ?? '';
                }
            }
        }

        await unlink(sessionPath);
        this._persistTabs();
        this._onLauncherStateChanged.fire();
        if (this._activeTabId) this.sendStateSync(this._activeTabId);
    }

    /**
     * Load a session from disk into a brand-new tab and return its id.
     * Used by the panel serializer when restoring a panel whose session
     * is not currently represented by any tab.
     */
    async createTabFromSessionPath(sessionPath: string): Promise<string> {
        const session = new PiSessionManager(this._outputChannel, this._context.secrets);
        await session.initializeFromPath(sessionPath);

        const checkpoint = new CheckpointManager();
        const diff = new DiffManager(session, checkpoint);

        const id = nextTabId();
        const tab = makeTabState(id, session, diff, checkpoint);
        this._updateTabName(tab);

        this._tabs.set(id, tab);
        this._subscribeTab(tab);
        this._persistTabs();
        return id;
    }

    /** Public: create a new agent tab. */
    async createTab(): Promise<string> {
        return this._createTab();
    }

    /** Public: tell the active sidebar view to show the session history list. */
    showSessions(): void {
        this.handleMessage({ type: 'getSessions' });
    }

    private get _activeTab(): TabState | undefined {
        return this._tabs.get(this._activeTabId);
    }

    /** Send a message to every sink whose filter matches `tabId`. */
    private _postForTab(tabId: string, message: ServerMessage): void {
        for (const sink of this._sinks) {
            if (sink.tabFilter === tabId
                || (sink.tabFilter === 'active' && tabId === this._activeTabId)) {
                sink.post(message);
            }
        }
    }

    /** Send a message to every sink, regardless of filter. Used for tab-agnostic events. */
    private _postBroadcast(message: ServerMessage): void {
        for (const sink of this._sinks) sink.post(message);
    }

    private _broadcastModels(): void {
        const tab = this._activeTab;
        if (!tab) return;
        const models = tab.session.getModels();
        const current = tab.session.getCurrentModel();
        const thinkingLevel = tab.session.getThinkingLevel();
        this._postForTab(this._activeTabId, { type: 'models', models, current, thinkingLevel });
    }

    private _subscribeTab(tab: TabState): void {
        const unsubs: (() => void)[] = [];

        unsubs.push(
            tab.session.events.onAll((event) => {
                void this._handleTabEvent(tab, event);
            }),
        );

        unsubs.push(
            tab.diffManager.onFileChange((change) => {
                this._postForTab(tab.id, { type: 'fileChange', change });
            }),
        );

        tab.session.setToolApprovalHandler(async (toolCallId, toolName, args) => {
            return this._requestToolApproval(tab, toolCallId, toolName, args);
        });

        this._tabSubscriptions.set(tab.id, unsubs);
    }

    private _unsubscribeTab(tabId: string): void {
        const unsubs = this._tabSubscriptions.get(tabId);
        if (unsubs) {
            for (const unsub of unsubs) unsub();
            this._tabSubscriptions.delete(tabId);
        }
    }

    private async _handleTabEvent(tab: TabState, event: any): Promise<void> {
        if (event.type === 'agent_start') {
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = Date.now();
            tab.isStreamingLocal = true;
            tab.codexTurnBaseline = getCodexUsageStore().getCurrent();
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', true);
            }
            this._onLauncherStateChanged.fire();
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const msgs = tab.session.getMessages();
            let assistantOrdinal = 0;
            let lastOrdinal = -1;
            for (let i = 0; i < msgs.length; i++) {
                if (msgs[i].role === 'assistant') {
                    lastOrdinal = assistantOrdinal;
                    assistantOrdinal++;
                }
            }
            if (lastOrdinal >= 0) {
                tab.messageMeta.set(lastOrdinal, {
                    thinkingDurationSec: tab.streamingThinkingDuration,
                    messageEndTime: Date.now(),
                });
            }
            tab.streamingThinkingDuration = 0;
        }

        if (event.type === 'agent_end') {
            const baseline = tab.codexTurnBaseline;
            tab.codexTurnBaseline = undefined;
            const after = getCodexUsageStore().getCurrent();
            const turn = computeCodexTurnUsage(baseline ?? null, after);
            if (turn) {
                const lastOrdinal = lastAssistantOrdinal(tab.session.getMessages());
                if (lastOrdinal >= 0) {
                    const meta = tab.messageMeta.get(lastOrdinal) ?? { thinkingDurationSec: 0, messageEndTime: 0 };
                    meta.codexTurn = turn;
                    tab.messageMeta.set(lastOrdinal, meta);
                }
            }
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = 0;
            tab.isStreamingLocal = false;
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', false);
            } else {
                tab.hasNotification = true;
            }
            this._persistTabs();
            this._onLauncherStateChanged.fire();

            if (tab.queuedMessages.length > 0) {
                const text = tab.queuedMessages.shift()!;
                if (tab.checkpointManager.rollbackPoint !== null) {
                    tab.checkpointManager.discardSuspended();
                    tab.diffManager.discardSuspended();
                    tab.suspendedMessages = [];
                }
                tab.turnCounter++;
                const turnIdx = tab.turnCounter;
                tab.checkpointManager.startTurn(turnIdx);
                tab.diffManager.setCurrentTurn(turnIdx);
                tab.session.prompt(await this._fileMentions.augmentPromptIfNeeded(text));
            }
        }

        if (event.type === 'message_update' && event.assistantMessageEvent) {
            const ae = event.assistantMessageEvent;
            switch (ae.type) {
                case 'thinking_start':
                    tab.isThinking = true;
                    tab.streamingThinking = '';
                    tab.thinkingStartTime = Date.now();
                    tab.streamingThinkingDuration = 0;
                    break;
                case 'thinking_delta':
                    tab.streamingThinking += ae.delta ?? '';
                    break;
                case 'thinking_end':
                    tab.isThinking = false;
                    if (tab.thinkingStartTime > 0) {
                        tab.streamingThinkingDuration = Math.round(
                            (Date.now() - tab.thinkingStartTime) / 1000
                        );
                    }
                    break;
                case 'text_delta':
                    tab.streamingText += ae.delta ?? '';
                    break;
            }
        }

        this._updateTabName(tab);

        // Stream raw events to whoever is watching this tab (the sidebar if active, panels for this tab).
        this._postForTab(tab.id, { type: 'agentEvent', event: safeSerialize(event) });

        const stateSyncEvents = ['agent_start', 'agent_end', 'message_end', 'turn_end'];
        if (stateSyncEvents.includes(event.type)) {
            this.sendStateSync(tab.id);
            // When activity happens on a non-active tab, also refresh the sidebar
            // so its tab indicators (streaming spinner / unread dot) update.
            if (tab.id !== this._activeTabId
                && (event.type === 'agent_start' || event.type === 'agent_end')) {
                this.sendStateSync(this._activeTabId);
            }
        }
    }

    private _updateTabName(tab: TabState): void {
        const sessionName = tab.session.session?.sessionName;
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
            this._persistTabs();
            this._onTabRenamed.fire({ tabId: tab.id, name: tab.name });
            this._onLauncherStateChanged.fire();
            return;
        }
        // Derive tab name from first user message if still default
        if (tab.name === 'New Agent') {
            const msgs = tab.session.getMessages();
            const firstUser = msgs.find((m: any) => m.role === 'user');
            if (firstUser) {
                const content = firstUser.content;
                const text: string = typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                        ? (content.find((c: any) => c.type === 'text')?.text ?? '')
                        : '';
                const trimmed = text.replace(/\n/g, ' ').trim().slice(0, 60);
                if (trimmed) {
                    tab.name = trimmed;
                    this._persistTabs();
                    this._onTabRenamed.fire({ tabId: tab.id, name: tab.name });
                    this._onLauncherStateChanged.fire();
                }
            }
        }
    }

    /**
     * Build the SerializedAgentState for `tabId` and post it to every sink
     * watching that tab. If `tabId` is omitted, the active tab is used.
     */
    sendStateSync(tabId?: string): void {
        const targetId = tabId ?? this._activeTabId;
        const tab = this._tabs.get(targetId);
        if (!tab) return;

        const state = tab.session.serializeState();
        // Override isStreaming with our locally tracked flag because the SDK
        // sets session.isStreaming = false only AFTER the agent_end listener
        // returns (in finishRun), so reading it here during agent_end would
        // still see `true` and the webview would think the agent is still working.
        state.isStreaming = tab.isStreamingLocal;
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((m: any) => safeSerialize(m)),
            ];
        }
        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = this._getTabInfos();
        state.activeTabId = this._activeTabId;
        state.sessionPath = tab.session.sessionPath ?? undefined;
        state.streamingText = tab.streamingText;
        state.streamingThinking = tab.streamingThinking;
        state.isThinking = tab.isThinking;
        state.thinkingStartTime = tab.thinkingStartTime;
        state.streamingThinkingDuration = tab.streamingThinkingDuration;
        if (tab.queuedMessages.length > 0) {
            state.queuedMessages = tab.queuedMessages;
        }
        let assistantOrdinal = 0;
        for (let i = 0; i < state.messages.length; i++) {
            if (state.messages[i].role === 'assistant') {
                const meta = tab.messageMeta.get(assistantOrdinal);
                if (meta) {
                    state.messages[i]._thinkingDurationSec = meta.thinkingDurationSec;
                    state.messages[i]._messageEndTime = meta.messageEndTime;
                    if (meta.codexTurn) {
                        state.messages[i]._codexTurnUsage = meta.codexTurn;
                    }
                }
                assistantOrdinal++;
            }
        }
        this._postForTab(targetId, { type: 'stateSync', state });
    }

    private _getTabInfos(): TabInfo[] {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            id,
            name: tab.name,
            isActive: id === this._activeTabId,
            isStreaming: tab.isStreamingLocal,
            hasNotification: tab.hasNotification,
        }));
    }

    /**
     * Process a webview message. `sourceTabId` identifies the panel that
     * sent the message; if omitted, the message is routed to the active tab
     * (matches the sidebar's behaviour of always operating on the active tab).
     */
    async handleMessage(msg: ClientMessage, sourceTabId?: string): Promise<void> {
        try {
            const targetId = sourceTabId ?? this._activeTabId;
            const tab = this._tabs.get(targetId);
            if (!tab) return;

            switch (msg.type) {
                case 'prompt': {
                    if (tab.checkpointManager.rollbackPoint !== null) {
                        tab.checkpointManager.discardSuspended();
                        tab.diffManager.discardSuspended();
                        tab.suspendedMessages = [];
                    }
                    tab.turnCounter++;
                    const turnIdx = tab.turnCounter;
                    tab.checkpointManager.startTurn(turnIdx);
                    tab.diffManager.setCurrentTurn(turnIdx);
                    await tab.session.prompt(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images);
                    break;
                }
                case 'steer':
                    await tab.session.steer(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images);
                    break;
                case 'queueMessage':
                    tab.queuedMessages.push(msg.text);
                    this.sendStateSync(tab.id);
                    break;
                case 'editQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length && msg.text.trim()) {
                        tab.queuedMessages[msg.index] = msg.text.trim();
                    }
                    this.sendStateSync(tab.id);
                    break;
                case 'removeQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                        tab.queuedMessages.splice(msg.index, 1);
                    }
                    this.sendStateSync(tab.id);
                    break;
                case 'cancelQueue':
                    tab.queuedMessages = [];
                    this.sendStateSync(tab.id);
                    break;
                case 'followUp':
                    await tab.session.followUp(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images);
                    break;
                case 'abort':
                    await tab.session.abort();
                    break;
                case 'getModels': {
                    const models = tab.session.getModels();
                    const current = tab.session.getCurrentModel();
                    const thinkingLevel = tab.session.getThinkingLevel();
                    this._postForTab(tab.id, { type: 'models', models, current, thinkingLevel });
                    break;
                }
                case 'setModel':
                    await tab.session.setModel(msg.provider, msg.modelId);
                    this.sendStateSync(tab.id);
                    break;
                case 'setThinkingLevel':
                    tab.session.setThinkingLevel(msg.level);
                    this.sendStateSync(tab.id);
                    break;
                case 'newSession':
                    await tab.session.newSession();
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.name = 'New Agent';
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.isStreamingLocal = false;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    this._onTabRenamed.fire({ tabId: tab.id, name: tab.name });
                    this.sendStateSync(tab.id);
                    break;
                case 'loadSession':
                    await tab.session.loadSession(msg.sessionPath);
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.isStreamingLocal = false;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    tab.name = 'New Agent'; // reset so _updateTabName re-derives from first message
                    this._updateTabName(tab);
                    this._persistTabs();
                    this.sendStateSync(tab.id);
                    break;
                case 'getSessions': {
                    const sessions = await tab.session.getSessions();
                    const currentId = tab.session.session?.sessionId;
                    this._postForTab(tab.id, { type: 'sessions', sessions, currentSessionId: currentId });
                    break;
                }
                case 'getState':
                    this.sendStateSync(tab.id);
                    break;
                case 'getSkills': {
                    const skills = tab.session.getSkills();
                    this._postForTab(tab.id, { type: 'skills', skills });
                    break;
                }
                case 'searchWorkspaceFiles': {
                    if (!this._fileMentions.isReady) {
                        const indexing = this._fileMentions.ensureIndexed();
                        this._postForTab(tab.id, {
                            type: 'workspaceFileSuggestions',
                            requestId: msg.requestId,
                            query: msg.query,
                            isIndexing: true,
                            items: [],
                        });
                        await indexing;
                    }
                    const items = await this._fileMentions.search(msg.query);
                    this._postForTab(tab.id, {
                        type: 'workspaceFileSuggestions',
                        requestId: msg.requestId,
                        query: msg.query,
                        items,
                    });
                    break;
                }
                case 'approveToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, true);
                    break;
                case 'rejectToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, false);
                    break;
                case 'openFile': {
                    const fileUri = vscode.Uri.file(msg.filePath);
                    try {
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(doc, { preview: true });
                    } catch { /* file may not exist */ }
                    break;
                }
                case 'openDiff':
                    await tab.diffManager.openDiff(msg.filePath, msg.toolCallId);
                    break;
                case 'undoFileChange':
                    await tab.diffManager.undoFileChange(msg.filePath, msg.toolCallId);
                    this.sendStateSync(tab.id);
                    break;
                case 'restoreCheckpoint': {
                    const restored = await tab.checkpointManager.restoreCheckpoint(msg.messageIndex);
                    tab.diffManager.suspendChangesAfter(msg.messageIndex);

                    const allMsgs = tab.session.getMessages();
                    const cutoff = this._findCutoffIndex(allMsgs, msg.messageIndex);
                    if (cutoff >= 0 && cutoff < allMsgs.length) {
                        tab.suspendedMessages = allMsgs.slice(cutoff);
                        tab.session.setMessages(allMsgs.slice(0, cutoff));
                    }

                    if (restored.length > 0) {
                        vscode.window.showInformationMessage(
                            `Restored ${restored.length} file(s) to checkpoint.`
                        );
                    }
                    this.sendStateSync(tab.id);
                    break;
                }
                case 'redoCheckpoint': {
                    const redone = await tab.checkpointManager.redoCheckpoint();
                    tab.diffManager.redoChanges();

                    if (tab.suspendedMessages.length > 0) {
                        const current = tab.session.getMessages();
                        tab.session.setMessages([...current, ...tab.suspendedMessages]);
                        tab.suspendedMessages = [];
                    }

                    if (redone.length > 0) {
                        vscode.window.showInformationMessage(
                            `Re-applied ${redone.length} file(s).`
                        );
                    }
                    this.sendStateSync(tab.id);
                    break;
                }
                case 'confirmAction': {
                    const answer = await vscode.window.showWarningMessage(
                        msg.message,
                        { modal: true },
                        'Yes',
                    );
                    this._postForTab(tab.id, {
                        type: 'confirmResult',
                        action: msg.action,
                        confirmed: answer === 'Yes',
                        payload: msg.payload,
                    });
                    break;
                }
                case 'createTab':
                    await this._createTab();
                    break;
                case 'closeTab':
                    await this._closeTab(msg.tabId);
                    break;
                case 'switchTab':
                    this._switchTab(msg.tabId);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('pi-code.openSettings');
                    break;
            }
        } catch (err: any) {
            // Errors from a panel-bound message route back to that panel; for sidebar
            // (no sourceTabId) they go to whoever currently shows the active tab.
            const targetId = sourceTabId ?? this._activeTabId;
            this._postForTab(targetId, { type: 'error', message: err.message ?? String(err) });
        }
    }

    private _requestToolApproval(tab: TabState, toolCallId: string, toolName: string, args: any): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            tab.pendingApprovals.set(toolCallId, { resolve });
            this._postForTab(tab.id, {
                type: 'toolCallPending',
                pending: { toolCallId, toolName, args: safeSerialize(args) },
            });
        });
    }

    private _resolveToolApproval(tab: TabState, toolCallId: string, approved: boolean): void {
        const pending = tab.pendingApprovals.get(toolCallId);
        if (pending) {
            tab.pendingApprovals.delete(toolCallId);
            pending.resolve(approved);
            this._postForTab(tab.id, { type: 'toolCallResolved', toolCallId });
        }
    }

    private async _createTab(): Promise<string> {
        const newSession = new PiSessionManager(this._outputChannel, this._context.secrets);
        await newSession.initialize();

        const newCheckpoint = new CheckpointManager();
        const newDiff = new DiffManager(newSession, newCheckpoint);

        const id = nextTabId();
        const tab = makeTabState(id, newSession, newDiff, newCheckpoint);
        this._tabs.set(id, tab);
        this._subscribeTab(tab);

        this._activeTabId = id;
        this._persistTabs();
        this._onLauncherStateChanged.fire();
        // Auto-open an editor panel for the new tab. After Phase 3 the
        // sidebar is a launcher, so without this the user would create a
        // tab and have nowhere to type into it.
        this._panelOpener?.(id);
        this.sendStateSync(id);
        return id;
    }

    private async _closeTab(tabId: string): Promise<void> {
        if (this._tabs.size <= 1) return;

        const tab = this._tabs.get(tabId);
        if (!tab) return;

        const wasActive = tabId === this._activeTabId;

        this._unsubscribeTab(tabId);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        await tab.session.dispose();
        this._tabs.delete(tabId);

        if (wasActive) {
            this._activeTabId = this._tabs.keys().next().value ?? '';
        }

        this._persistTabs();
        this._onLauncherStateChanged.fire();
        if (this._activeTabId) this.sendStateSync(this._activeTabId);
    }

    private _switchTab(tabId: string): void {
        if (!this._tabs.has(tabId) || tabId === this._activeTabId) return;

        this._activeTabId = tabId;

        const tab = this._activeTab;
        if (!tab) return;
        tab.hasNotification = false;
        if (tab.isStreamingLocal) {
            vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', true);
        } else {
            vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', false);
        }

        this._persistTabs();
        this._onLauncherStateChanged.fire();
        this.sendStateSync(this._activeTabId);
    }

    private _persistTabs(): void {
        const tabList = [...this._tabs.values()];
        const activeTab = this._tabs.get(this._activeTabId);
        const activeIndex = activeTab ? tabList.indexOf(activeTab) : 0;

        const tabs = tabList
            .map(tab => ({
                name: tab.name,
                sessionPath: tab.session.sessionPath ?? '',
            }))
            .filter(t => t.sessionPath !== '');

        this._context.workspaceState.update('pi-code.tabs', {
            tabs,
            activeIndex: Math.max(0, activeIndex),
        } satisfies PersistedTabsState);
    }

    async restorePersistedTabs(): Promise<void> {
        const persisted = this._context.workspaceState.get<PersistedTabsState>('pi-code.tabs');
        if (!persisted || persisted.tabs.length === 0) { return; }

        // Remember the initial empty tab to dispose after successful restore
        const initialTabId = this._activeTabId;
        const initialTab = this._tabs.get(initialTabId);

        const restoredIds: string[] = [];

        for (const { name, sessionPath } of persisted.tabs) {
            try {
                const session = new PiSessionManager(this._outputChannel, this._context.secrets);
                await session.initializeFromPath(sessionPath);

                const checkpoint = new CheckpointManager();
                const diff = new DiffManager(session, checkpoint);

                const id = nextTabId();
                const tab = makeTabState(id, session, diff, checkpoint);
                tab.name = name;
                this._updateTabName(tab); // re-derive name from first message if needed

                this._tabs.set(id, tab);
                this._subscribeTab(tab);
                restoredIds.push(id);
            } catch (err: any) {
                this._outputChannel.appendLine(`Failed to restore tab "${name}": ${err.message}`);
            }
        }

        if (restoredIds.length === 0) { return; }

        // Dispose the initial empty tab
        if (initialTab) {
            this._unsubscribeTab(initialTabId);
            initialTab.diffManager.dispose();
            initialTab.checkpointManager.dispose();
            await initialTab.session.dispose();
            this._tabs.delete(initialTabId);
        }

        // Restore active tab
        const activeIdx = Math.min(persisted.activeIndex ?? 0, restoredIds.length - 1);
        this._activeTabId = restoredIds[activeIdx];

        this._outputChannel.appendLine(`Restored ${restoredIds.length} tab(s).`);
        this.sendStateSync(this._activeTabId);
    }

    private _findCutoffIndex(messages: any[], rollbackPoint: number): number {
        let userMsgCount = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') {
                userMsgCount++;
                if (userMsgCount > rollbackPoint) {
                    return i;
                }
            }
        }
        return -1;
    }

    dispose(): void {
        for (const [, unsubs] of this._tabSubscriptions) {
            for (const unsub of unsubs) unsub();
        }
        this._tabSubscriptions.clear();
        this._authChangedSubscription?.dispose();
        this._authChangedSubscription = undefined;
        this._codexUsageUnsubscribe?.();
        this._codexUsageUnsubscribe = undefined;
        this._fileMentions.dispose();
        this._sinks.clear();
        this._openPanels.clear();
        this._panelOpener = undefined;
        this._onTabRenamed.dispose();
        this._onLauncherStateChanged.dispose();
    }
}

function lastAssistantOrdinal(messages: any[]): number {
    let ordinal = -1;
    let counter = 0;
    for (const m of messages) {
        if (m && m.role === 'assistant') {
            ordinal = counter;
            counter++;
        }
    }
    return ordinal;
}

function computeCodexTurnUsage(
    baseline: CodexUsageSnapshot | null,
    after: CodexUsageSnapshot | null,
): CodexTurnUsage | undefined {
    if (!after) return undefined;
    if (baseline && after.capturedAt <= baseline.capturedAt) return undefined;

    const primary = computeWindowDelta(baseline?.primary, after.primary);
    const secondary = computeWindowDelta(baseline?.secondary, after.secondary);
    if (!primary && !secondary) return undefined;

    return {
        primary,
        secondary,
        capturedAt: after.capturedAt,
    };
}

function computeWindowDelta(
    before: CodexUsageWindow | undefined,
    after: CodexUsageWindow | undefined,
): CodexTurnWindowDelta | undefined {
    if (!after) return undefined;
    // If the window reset between snapshots (or there was no baseline), the
    // "before" point is effectively 0% — the entire current usage came from
    // this turn (give or take other clients sharing the account).
    const beforePercent = before && before.resetAt === after.resetAt ? before.percentUsed : 0;
    const deltaPercent = Math.max(0, after.percentUsed - beforePercent);
    return {
        windowMinutes: after.windowMinutes,
        beforePercent,
        afterPercent: after.percentUsed,
        deltaPercent,
    };
}
