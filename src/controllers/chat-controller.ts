import * as vscode from 'vscode';
import { unlink } from 'fs/promises';
import { PiSessionManager } from '../pi/session';
import type { Logger } from '../core/ports/logger';
import { NOOP_PERF_LOGGER, type PerfLogger } from '../core/ports/perf-logger';
import type { SecretStore, SessionRuntimePorts } from '../core/ports/session-platform';
import type { ChatPlatformPorts, FileMentionsPort, StateStore } from '../core/ports/chat-platform';
import type { FileChangePlatformPorts } from '../core/ports/file-state';
import type { RawStoragePort } from '../core/ports/raw-storage';
import type { RawRecorderRegistry } from '../core/raw/raw-recorder';
import { DiffManager } from '../core/files/diff-manager';
import { CheckpointManager } from '../core/files/checkpoint-manager';
import { ChatService, countUserTurns } from '../core/chat/chat-service';
import { parseNameCommand } from '../core/chat/chat-command-service';
import {
    ChatHost,
    type ChatHostTabRequest,
} from '../core/chat/chat-host';
import { collectOrphanedTools } from '../core/chat/chat-event-policy';
import {
    projectLauncherState,
    type ActiveLauncherProjection,
    type LauncherProjectionSession,
} from '../core/chat/launcher-projection';
import { TabRegistry } from '../core/chat/tab-registry';
import { TabRuntime } from '../core/chat/tab-runtime';
import type {
    ClientMessage, ServerMessage, TabInfo,
    LauncherState,
    CacheMode, CacheEffective, LauncherSubagentSnapshot,
    TurnNotificationSettings,
} from '../shared/protocol';
import type {
    AgentServerMessage,
    FileAttachment,
    ImageAttachment,
} from '../shared/agent-protocol';
import {
    createProjectToolSelectionDefault,
    parseProjectToolSelectionDefault,
    type ProjectToolSelectionDefault,
} from '../shared/project-tool-default';
import {
    FILE_UNDO_VIEW_KEY_PREFIX,
    PLAN_MODE_KEY_PREFIX,
    PROJECT_TOOL_DEFAULT_KEY,
    TODO_ENABLED_KEY_PREFIX,
    composeEffectiveDisabledTools,
    computeEffectiveCache,
    decorateDirectPrompt,
    prepareCacheForRequest,
    readDisabledTools,
    readSessionBoolean,
    writeDisabledTools,
    writeSessionBoolean,
} from '../core/chat/chat-preferences';
import { onAuthChanged } from '../pi/auth';
import { getCodexUsageStore } from '../pi/codex-usage-store';
import { computeCodexTurnUsage, isCodexUsageStale } from '../shared/codex-usage';
import type { SubagentCoordinator } from '../pi/subagents/coordinator';
import { SubagentCapabilityGate } from '../pi/subagents/gating';
import { projectSubagentLauncherSnapshot } from '../pi/subagents/launcher-state';
import type { SubagentRunStore } from '../pi/subagents/persistence';
import type { WriteIsolationManager } from '../pi/subagents/write-isolation';
import type { ChildToolFactoryRegistry } from '../pi/subagents/child-tools';
import { routeSubagentMutation } from '../pi/subagents/mutations';
import { TurnNotifier } from '../notifications/turn-notifier';

type TabState = TabRuntime<PiSessionManager, DiffManager, CheckpointManager>;

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

export type ChatCommandDispatchResult =
    | { ok: true; result?: unknown }
    | { ok: false; code: 'tab_not_found' | 'command_failed'; message: string };

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

const PROVIDER_ERROR_MAX = 1200;

/**
 * Format a provider error (Gemini quota, OpenAI auth, Anthropic 5xx, raw fetch
 * failures, ...) into something readable in the chat banner. We extract a JSON
 * `error.message` if the body looks like a Google/OpenAI error envelope, then
 * cap length so a multi-KB stack/JSON dump doesn't blow up the UI.
 */
function formatProviderError(raw: string | undefined): string {
    const fallback = 'The AI provider returned an error.';
    if (!raw) { return fallback; }
    const cleaned = extractErrorMessage(raw).trim();
    if (!cleaned) { return fallback; }
    return cleaned.length > PROVIDER_ERROR_MAX
        ? `${cleaned.slice(0, PROVIDER_ERROR_MAX)}…`
        : cleaned;
}

function extractErrorMessage(raw: string): string {
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
        const candidate = raw.slice(jsonStart);
        try {
            const parsed = JSON.parse(candidate);
            const msg = parsed?.error?.message ?? parsed?.message;
            if (typeof msg === 'string' && msg.length > 0) {
                const status = parsed?.error?.status ? ` (${parsed.error.status})` : '';
                return `${msg}${status}`;
            }
        } catch { /* fall through to raw */ }
    }
    return raw;
}

function trimErrorForStatus(raw: string | undefined): string {
    if (!raw) { return 'provider error'; }
    const msg = extractErrorMessage(raw).replace(/\s+/g, ' ').trim();
    return msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
}

/**
 * Owns all chat tab state and routes messages from views to the appropriate
 * tab. View layers (sidebar, editor panels) attach themselves as a
 * {@link ChatViewSink} via {@link addSink} and forward webview messages via
 * {@link handleMessage} (passing their bound `tabId` if any).
 */
export class ChatController implements vscode.Disposable {
    private _outputChannel: vscode.OutputChannel;
    private readonly _sessionLogger: Logger;
    private readonly _sessionSecrets: SecretStore | undefined;
    private readonly _sessionPorts: SessionRuntimePorts;
    private readonly _rawStorage: RawStoragePort | undefined;
    private readonly _rawRecorderRegistry: RawRecorderRegistry | undefined;
    private readonly _perf: PerfLogger;
    private _tabPerfCounter = 0;
    private readonly _workspaceState: StateStore;
    private readonly _globalState: StateStore;
    private readonly _fileChangePorts: FileChangePlatformPorts;
    private readonly _chatService: ChatService;
    private _hostInstance?: ChatHost<TabState>;
    private _context: vscode.ExtensionContext;

    private _cacheMode: CacheMode = 'auto';
    private _favoriteModels: Set<string> = new Set();
    private static readonly FAVORITES_KEY = 'pi-code.favoriteModels';
    private static readonly NOTIFICATION_SHOW_POPUP_KEY = 'pi-code.notifications.showPopup';
    private static readonly NOTIFICATION_PLAY_SOUND_KEY = 'pi-code.notifications.playSound';

    private readonly _tabs = new TabRegistry<TabState>();

    private get _host(): ChatHost<TabState> {
        if (!this._hostInstance
            || this._hostInstance.tabs !== this._tabs
            || this._hostInstance.chat !== this._chatService) {
            this._hostInstance = this._createChatHost();
        }
        return this._hostInstance;
    }

    private get _app() {
        return this._host.application;
    }

    private get _activeTabId(): string {
        return this._tabs.activeId;
    }
    private _authChangedSubscription?: vscode.Disposable;
    private _codexUsageUnsubscribe?: () => void;
    private readonly _fileMentions: FileMentionsPort;
    private readonly _turnNotifier: TurnNotifier;

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
    private readonly _subagentCoordinator: SubagentCoordinator;
    private readonly _subagentGate: SubagentCapabilityGate;
    private _subagentSmokeSnapshot?: LauncherSubagentSnapshot;
    private _subagentSmokeTranscripts = new Map<string, string>();

    constructor(
        context: vscode.ExtensionContext,
        initialSession: PiSessionManager,
        initialDiffManager: DiffManager,
        initialCheckpointManager: CheckpointManager,
        outputChannel: vscode.OutputChannel,
        subagentCoordinator: SubagentCoordinator,
        private readonly _subagentStore: SubagentRunStore,
        private readonly _writeIsolation: WriteIsolationManager,
        private readonly _childToolFactories: ChildToolFactoryRegistry,
        chatPorts: ChatPlatformPorts,
        perf: PerfLogger = NOOP_PERF_LOGGER,
    ) {
        this._context = context;
        this._outputChannel = outputChannel;
        this._sessionLogger = initialSession.logger;
        this._sessionSecrets = initialSession.secrets;
        this._sessionPorts = initialSession.ports;
        this._rawStorage = initialSession.rawStorage;
        this._rawRecorderRegistry = initialSession.rawRecorderRegistry;
        this._perf = perf;
        this._workspaceState = chatPorts.state.workspace;
        this._globalState = chatPorts.state.global;
        this._fileMentions = chatPorts.fileMentions;
        this._fileChangePorts = chatPorts.fileChanges;
        this._chatService = new ChatService({ now: () => Date.now() });
        this._turnNotifier = new TurnNotifier(outputChannel);
        this._subagentCoordinator = subagentCoordinator;
        this._subagentGate = new SubagentCapabilityGate(
            this._workspaceState,
            () => vscode.workspace.getConfiguration('pi-code').get<boolean>('subagents.defaultEnabled', false),
        );
        const storedMode = this._globalState.get<CacheMode>('pi-code.cacheMode');
        if (storedMode === 'short' || storedMode === 'long' || storedMode === 'auto') {
            this._cacheMode = storedMode;
        }
        const storedFavorites = this._globalState.get<string[]>(
            ChatController.FAVORITES_KEY,
        );
        if (Array.isArray(storedFavorites)) {
            this._favoriteModels = new Set(storedFavorites);
        }

        const id = nextTabId();
        const tab = new TabRuntime({
            id,
            session: initialSession,
            diffManager: initialDiffManager,
            checkpointManager: initialCheckpointManager,
            projectToolDefault: this._getProjectToolSelectionDefault(),
            initialTurnCounter: countUserTurns(initialSession.getMessages()),
        });
        this._host.register(tab, { activate: true });
        this._subscribeTab(tab);

        this._authChangedSubscription = onAuthChanged((providerId) => {
            this._broadcastModels();
            for (const tab of this._tabs.values()) {
                if (tab.session.refreshCurrentModelMetadata()) this.sendStateSync(tab.id);
            }
            if (providerId === 'openai-codex') {
                const tab = this._activeTab;
                if (tab) void this._refreshCodexUsageForTab(tab, 'Codex authentication changed');
            }
        });

        this._codexUsageUnsubscribe = getCodexUsageStore().onChange((snapshot) => {
            this._postBroadcast({ type: 'codexUsage', usage: snapshot });
        });
    }

    addSink(sink: ChatViewSink): void {
        this._sinks.add(sink);
        // Replay a recent snapshot immediately, then refresh once for an opened
        // Codex chat. Restored panels share the store's in-flight request.
        const usage = getCodexUsageStore().getCurrent();
        if (usage) {
            sink.post({ type: 'codexUsage', usage });
        }
        const tab = sink.tabFilter === 'active'
            ? this._activeTab
            : this._tabs.get(sink.tabFilter);
        if (tab) void this._refreshCodexUsageForTab(tab, 'chat opened');
    }

    private async _refreshCodexUsageForTab(tab: TabState, reason: string): Promise<void> {
        if (tab.session.getCurrentModel()?.provider !== 'openai-codex') return;
        try {
            const usage = await getCodexUsageStore().refresh();
            if (!usage) {
                this._postForTab(tab.id, {
                    type: 'codexUsageError',
                    message: 'Sign in with ChatGPT to view subscription usage.',
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._outputChannel.appendLine(`Codex usage refresh failed (${reason}): ${message}`);
            this._postForTab(tab.id, {
                type: 'codexUsageError',
                message: 'Unable to load subscription usage. Open the Pi Code output for details.',
            });
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
        if (!this._tabs.has(tabId)) {
            throw new Error(`Cannot register a panel for unknown tab: ${tabId}`);
        }
        this._openPanels.set(tabId, panel);
        this._host.activateTab(tabId);
        this._persistTabs();
        this._onLauncherStateChanged.fire();
    }

    /**
     * Called by `ChatPanel` whenever its underlying `WebviewPanel`
     * becomes the active editor (focus changes between existing
     * panels do NOT go through `registerPanel`). This is the only
     * authoritative source of "user is currently looking at tab X"
     * once panels have been created.
     */
    markActiveTab(tabId: string): void {
        if (!this._host.activateTab(tabId)) return;
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

        if (!await this._host.dropTab(tabId)) {
            this._onLauncherStateChanged.fire();
        }
    }

    /** Build a snapshot of launcher state (panel tabs + recent sessions). */
    async computeLauncherState(): Promise<Omit<LauncherState, 'historyCollapsed' | 'notificationsCollapsed' | 'todoCollapsed' | 'subagentsCollapsed' | 'toolsCollapsed'>> {
        let recentSessions: LauncherProjectionSession[] = [];
        const anySession = this._tabs.values().next().value?.session;
        if (anySession) {
            try {
                recentSessions = await anySession.getSessions();
            } catch {
                recentSessions = [];
            }
        }

        const activeTab = this._tabs.get(this._activeTabId);
        let active: ActiveLauncherProjection | undefined;
        if (activeTab && this._openPanels.has(activeTab.id)) {
            const todoState = activeTab.session.todoStore.getState();
            const subagents = projectSubagentLauncherSnapshot(
                activeTab.session.getSubagentSnapshot(),
                {
                    enabled: this._isSubagentsEnabledFor(activeTab),
                    toggleDisabled: false,
                },
            );
            active = {
                todos: { tasks: todoState.tasks, nextId: todoState.nextId },
                todoEnabled: this._isTodoEnabledFor(activeTab),
                planModeEnabled: this._isPlanModeEnabledFor(activeTab),
                fileUndoViewEnabled: this._isFileUndoViewEnabledFor(activeTab),
                subagents,
                toolSelection: {
                    registered: activeTab.session.getRegisteredToolsInfo(),
                    disabled: this._effectiveDisabledTools(activeTab),
                },
            };
        }

        const projected = projectLauncherState({
            tabs: [...this._tabs.values()].map((tab) => ({
                id: tab.id,
                name: tab.name,
                isStreamingLocal: tab.isStreamingLocal,
                isCompacting: tab.isCompacting,
                hasNotification: tab.hasNotification,
                sessionPath: tab.session.sessionPath,
                modelLabel: tab.session.getCurrentModel()?.id,
            })),
            visibleTabIds: new Set(this._openPanels.keys()),
            recentSessions,
            activeTabId: this._activeTabId,
            notificationSettings: this.getTurnNotificationSettings(),
            active,
        });
        return this._subagentSmokeSnapshot
            ? { ...projected, subagents: this._subagentSmokeSnapshot }
            : projected;
    }

    /** Expose the active tab's session for global commands (palette, keybindings). */
    get activeSession(): PiSessionManager | undefined {
        return this._tabs.get(this._activeTabId)?.session;
    }

    get activeTabId(): string {
        return this._activeTabId;
    }

    /** Session file backing the active chat panel, if any. Used by RawMode commands. */
    getActiveSessionPath(): string | undefined {
        return this._tabs.get(this._activeTabId)?.session.sessionPath;
    }

    /** Best-effort human-readable label for a session file. Returns tab name when open. */
    getSessionDisplayTitle(sessionPath: string): string | undefined {
        for (const tab of this._tabs.values()) {
            if (tab.session.sessionPath === sessionPath) return tab.name;
        }
        return undefined;
    }

    /** Lookup an existing tab whose session was loaded from `sessionPath`. */
    findTabIdBySessionPath(sessionPath: string): string | undefined {
        if (!sessionPath) return undefined;
        for (const [id, tab] of this._tabs.entries()) {
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

        const loadedTabId = this.findTabIdBySessionPath(sessionPath);
        if (loadedTabId) await this._host.detachTab(loadedTabId);

        await this._subagentStore.deleteByParentSessionPath(sessionPath);
        // Close any live RawMode recorder for this path before nuking the
        // JSONL file, otherwise a straggling append would race the delete
        // and resurrect an empty file on disk.
        await this._rawRecorderRegistry?.dispose(sessionPath);
        await this._rawStorage?.deleteSession(sessionPath);
        // Panels bound to this session watch the registry's `onDataCleared`
        // hook and close themselves.
        this._rawRecorderRegistry?.notifyDataCleared(sessionPath);
        try {
            await unlink(sessionPath);
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                throw new Error('Session was not found in history.');
            }
            throw err;
        }
        this._persistTabs();
        this._onLauncherStateChanged.fire();
        if (this._activeTabId) this.sendStateSync(this._activeTabId);
    }

    private _createSessionManager(perf: PerfLogger = this._perf): PiSessionManager {
        return new PiSessionManager(
            this._sessionLogger,
            this._sessionSecrets,
            this._subagentCoordinator,
            this._subagentStore,
            this._writeIsolation,
            this._childToolFactories,
            this._sessionPorts,
            this._rawStorage,
            this._rawRecorderRegistry,
            perf,
        );
    }

    private _createFileChangeManagers(session: PiSessionManager): {
        checkpoint: CheckpointManager;
        diff: DiffManager;
    } {
        const checkpoint = new CheckpointManager(this._fileChangePorts.fileState);
        const diff = new DiffManager(session, checkpoint, this._fileChangePorts.fileState);
        return { checkpoint, diff };
    }

    private _createChatHost(): ChatHost<TabState> {
        return new ChatHost({
            tabs: this._tabs,
            chat: this._chatService,
            factory: (request) => this._createTabState(request),
            commandCallbacks: (tab) => this._createCommandCallbacks(tab),
            stateContext: (tab) => ({
                cacheMode: this._cacheMode,
                getCacheEffective: () => this._computeEffectiveCache(tab),
                getFileUndoViewEnabled: () => this._isFileUndoViewEnabledFor(tab),
            }),
            preferences: {
                getCacheMode: () => this._cacheMode,
                setCacheMode: async (mode) => {
                    this._cacheMode = mode;
                    await this._globalState.update('pi-code.cacheMode', mode);
                },
                getFavorites: () => [...this._favoriteModels],
                setFavorites: async (favorites) => {
                    this._favoriteModels = new Set(favorites);
                    await this._globalState.update(
                        ChatController.FAVORITES_KEY,
                        [...this._favoriteModels],
                    );
                },
                getProjectToolDefault: () => this._getProjectToolSelectionDefault(),
                applyPersistedToolSelection: (tab) => this._applyPersistedToolSelection(tab),
                refreshCacheEffective: (tab) => {
                    tab.cacheEffective = this._computeEffectiveCache(tab);
                },
                getDisabledTools: (tab) => this._getDisabledToolsFor(tab),
                setDisabledTools: (tab, disabled) => this._setDisabledToolsFor(tab, [...disabled]),
                setTodoEnabled: (tab, enabled) => writeSessionBoolean(
                    this._workspaceState,
                    TODO_ENABLED_KEY_PREFIX,
                    tab.session.sessionPath,
                    enabled,
                ),
                setSubagentsEnabled: (tab, enabled) => this._subagentGate.setEnabled(
                    tab.session.sessionPath,
                    enabled,
                    false,
                ),
                setPlanModeEnabled: (tab, enabled) => writeSessionBoolean(
                    this._workspaceState,
                    PLAN_MODE_KEY_PREFIX,
                    tab.session.sessionPath,
                    enabled,
                ),
                setFileUndoViewEnabled: (tab, enabled) => writeSessionBoolean(
                    this._workspaceState,
                    FILE_UNDO_VIEW_KEY_PREFIX,
                    tab.session.sessionPath,
                    enabled,
                ),
            },
            effects: {
                bindTab: (tab) => this._subscribeTab(tab),
                persistTabs: () => this._persistTabs(),
                tabsChanged: () => this._onLauncherStateChanged.fire(),
                publishState: (tabId) => this.sendStateSync(tabId),
                openTab: (tabId) => this._panelOpener?.(tabId),
                activeTabChanged: (tab) => {
                    void vscode.commands.executeCommand(
                        'setContext',
                        'pi-code.isStreaming',
                        tab.isStreamingLocal,
                    );
                },
                tabRenamed: (tabId, name) => this._onTabRenamed.fire({ tabId, name }),
                modelsChanged: () => this._broadcastModels(),
                reportCommandFailure: (messageType, tabId, error) => {
                    this._reportCommandFailure(messageType, tabId, error);
                },
                restoreFailed: (entry, error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    this._outputChannel.appendLine(
                        `Failed to restore tab "${entry.name}": ${message}`,
                    );
                },
            },
            eventEffects: {
                agentStarted: (tab) => {
                    const currentModel = tab.session.getCurrentModel();
                    const currentUsage = getCodexUsageStore().getCurrent();
                    tab.codexTurnModelId = currentModel?.provider === 'openai-codex'
                        ? currentModel.id
                        : undefined;
                    tab.codexTurnBaseline = tab.codexTurnModelId
                        && currentUsage
                        && !isCodexUsageStale(currentUsage)
                        ? currentUsage
                        : null;
                },
                streamingContextChanged: (isStreaming) => {
                    void vscode.commands.executeCommand(
                        'setContext',
                        'pi-code.isStreaming',
                        isStreaming,
                    );
                },
                reportAgentError: (tab, raw, assistantMessage) => {
                    this._postAgentError(tab, raw, assistantMessage);
                },
                reportAgentNotice: (tab, message, severity, assistantMessage) => {
                    this._postAgentNotice(tab, message, severity, assistantMessage);
                },
                showAutoRetry: (event) => {
                    const delaySec = Math.max(1, Math.round((event.delayMs ?? 0) / 1000));
                    const reason = trimErrorForStatus(event.errorMessage);
                    const text = `Pi: rate limited, retry ${event.attempt}/${event.maxAttempts} in ${delaySec}s — ${reason}`;
                    vscode.window.setStatusBarMessage(text, (delaySec + 2) * 1000);
                },
                logTurnEnd: (tab, assistantMessage) => this._logTurnEnd(tab, assistantMessage),
                sweepPendingTools: (tab, assistantMessage) => {
                    this._sweepPendingTools(tab, assistantMessage);
                },
                completeAgentEndAccounting: async (tab) => {
                    const baseline = tab.codexTurnBaseline;
                    const codexModelId = tab.codexTurnModelId;
                    tab.codexTurnBaseline = undefined;
                    tab.codexTurnModelId = undefined;
                    if (codexModelId) await this._refreshCodexUsageForTab(tab, 'turn ended');
                    return computeCodexTurnUsage(
                        baseline ?? null,
                        getCodexUsageStore().getCurrent(),
                        codexModelId,
                    );
                },
                notifyTurnCompletion: (_tab, completion) => {
                    this._turnNotifier.notify(completion, this.getTurnNotificationSettings());
                },
                emitAgentEvent: (tabId, event) => {
                    this._postForTab(tabId, { type: 'agentEvent', event });
                },
                dispatchNextQueued: (tab) => this._dispatchNextQueuedMessage(tab),
            },
        });
    }

    private async _createTabState(request: ChatHostTabRequest): Promise<TabState> {
        const tabPerfId = `tab-pending-${++this._tabPerfCounter}`;
        const tabPerf = this._perf.child({ tabId: tabPerfId, tabRequestKind: request.kind });
        return tabPerf.time('tab.createTabState', () => this._createTabStateInner(request, tabPerf), { kind: request.kind });
    }

    private async _createTabStateInner(request: ChatHostTabRequest, tabPerf: PerfLogger): Promise<TabState> {
        const session = this._createSessionManager(tabPerf);
        let checkpoint: CheckpointManager | undefined;
        let diff: DiffManager | undefined;
        let tab: TabState | undefined;
        try {
            if (request.kind === 'new') {
                await tabPerf.time('tab.session.initialize', () => session.initialize());
            } else {
                await tabPerf.time('tab.session.initializeFromPath', () => session.initializeFromPath(request.sessionPath));
            }

            ({ checkpoint, diff } = tabPerf.timeSync(
                'tab.fileChangeManagers.create',
                () => this._createFileChangeManagers(session),
            ));
            tab = tabPerf.timeSync('tab.runtime.construct', () => new TabRuntime({
                id: nextTabId(),
                session,
                diffManager: diff!,
                checkpointManager: checkpoint!,
                projectToolDefault: request.kind === 'new'
                    ? this._getProjectToolSelectionDefault()
                    : undefined,
                initialTurnCounter: countUserTurns(session.getMessages()),
            }));
            if (request.kind === 'sessionPath' && request.name) tab.name = request.name;
            return tab;
        } catch (error) {
            if (tab) {
                await tab.disposeResources().catch(() => undefined);
            } else {
                await Promise.resolve(diff?.dispose()).catch(() => undefined);
                await Promise.resolve(checkpoint?.dispose()).catch(() => undefined);
                await Promise.resolve(session.dispose()).catch(() => undefined);
            }
            throw error;
        }
    }

    /**
     * Load a session from disk into a brand-new tab and return its id.
     * Used by the panel serializer when restoring a panel whose session
     * is not currently represented by any tab.
     */
    async createTabFromSessionPath(sessionPath: string): Promise<string> {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Restoring Pi Code chat…',
            },
            () => this._host.createTabFromSessionPath(sessionPath),
        );
    }

    /** Public: create a new agent tab. */
    async createTab(): Promise<string> {
        // Wrap the wait in a VS Code progress notification so the user sees a
        // "Preparing new Pi Code chat…" spinner in the status bar while the
        // agent session is being brought up. Without this, clicking "New
        // chat" produced up to ~3 seconds of dead-air — the editor panel
        // itself only opens after `_host.createTab()` resolves.
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Preparing new Pi Code chat…',
            },
            () => this._host.createTab(),
        );
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
        this._postBroadcast({
            type: 'models',
            models,
            current,
            thinkingLevel,
            favorites: [...this._favoriteModels],
        });
    }

    // ── Prompt cache retention ──
    //
    // Pi resolves cache retention via `process.env.PI_CACHE_RETENTION` on every
    // provider call (`pi-ai/dist/providers/anthropic.js: resolveCacheRetention`),
    // so we set the env var right before any LLM-triggering operation. This is
    // the only injection point exposed by the SDK without forking it.

    /**
     * Pure read of the cache mode that would apply right now.
     *
     * In `auto`, the decision is provider-aware:
     *
     * - For backends where cache writes are free (OpenAI, Z.AI, …),
     *   `long` strictly dominates `short` cost-wise, so we always pick `long`.
     * - For backends with a real write surcharge (Anthropic / Bedrock-Claude /
     *   kimi-coding), we only pay the higher write cost when the session has
     *   either shown a real idle pause or accumulated a large cached prefix
     *   that would be expensive to re-write after a 5-min expiry.
     *
     * The idle gap considered includes the time accumulating since the last
     * turn ended (so the chip flips to "long" while the user is still
     * composing the next prompt after a break, not only after they send it).
     */
    private _cachePolicyInput(tab: TabState): Parameters<typeof computeEffectiveCache>[0] {
        const model = tab.session.getCurrentModel();
        return {
            cacheMode: this._cacheMode,
            provider: model?.provider,
            modelId: model?.id,
            lastTurnEndAt: tab.lastTurnEndAt,
            maxIdleGapMs: tab.maxIdleGapMs,
            contextTokens: tab.session.serializeState().contextUsage?.tokens ?? 0,
            now: Date.now(),
        };
    }

    private _computeEffectiveCache(tab: TabState): CacheEffective {
        return computeEffectiveCache(this._cachePolicyInput(tab));
    }

    private _prepareCacheForRequest(tab: TabState): void {
        const prepared = prepareCacheForRequest(this._cachePolicyInput(tab));
        tab.maxIdleGapMs = prepared.maxIdleGapMs;
        tab.cacheEffective = prepared.effective;
        if (prepared.effective === 'long') {
            process.env.PI_CACHE_RETENTION = 'long';
        } else {
            // Pi's resolver only flips to "long" on exact match; anything else
            // (including unset) means "short". Setting an empty string keeps
            // intent visible vs. delete and avoids subtle race with reads.
            process.env.PI_CACHE_RETENTION = '';
        }
    }

    private _subscribeTab(tab: TabState): void {
        tab.session.setSubagentParentTabId(tab.id);
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

        // ToDo store changes drive the launcher panel. Other tabs' stores
        // also call this fire(), but `computeLauncherState` only surfaces
        // the active tab's snapshot so unrelated updates re-render the
        // launcher with an unchanged shape (cheap).
        unsubs.push(
            tab.session.todoStore.subscribe(() => {
                if (tab.id === this._activeTabId) {
                    this._onLauncherStateChanged.fire();
                }
            }),
        );

        const subagentStateSubscription = tab.session.onSubagentStateChanged(() => {
            if (tab.id === this._activeTabId && !this._subagentSmokeSnapshot) {
                this._onLauncherStateChanged.fire();
            }
        });
        unsubs.push(() => subagentStateSubscription.dispose());
        const subagentMutationSubscription = tab.session.onSubagentMutation((event) => {
            routeSubagentMutation(event, tab.diffManager);
        });
        unsubs.push(() => subagentMutationSubscription.dispose());
        const subagentNotificationSubscription = tab.session.onSubagentNotification(() => {
            this.sendStateSync(tab.id);
        });
        unsubs.push(() => subagentNotificationSubscription.dispose());

        // Apply the persisted tool selection (ToDo toggle + per-tab
        // Tools panel denylist, folded into a single `disabled` set).
        // The session is already initialised at this point, so it
        // takes effect immediately.
        this._applyPersistedToolSelection(tab);

        for (const unsubscribe of unsubs) tab.addSubscription(unsubscribe);
    }

    private _todoDefaultEnabled(): boolean {
        // The setting defaults to ON, so a vanilla install of the
        // extension surfaces the ToDo panel for every new chat. Power
        // users who do not want that flip it off in settings.
        return vscode.workspace
            .getConfiguration('pi-code')
            .get<boolean>('todo.defaultEnabled', true);
    }

    private _isTodoEnabledFor(tab: TabState): boolean {
        const fallback = tab.projectToolDefault
            ? tab.projectToolDefault.enabled.includes('todo')
            : this._todoDefaultEnabled();
        return readSessionBoolean(
            this._workspaceState,
            TODO_ENABLED_KEY_PREFIX,
            tab.session.sessionPath,
            fallback,
        );
    }

    private _isSubagentsEnabledFor(tab: TabState): boolean {
        const key = this._subagentGate.key(tab.session.sessionPath);
        const stored = key ? this._workspaceState.get<unknown>(key) : undefined;
        if (typeof stored === 'boolean') return stored;
        if (tab.projectToolDefault) return tab.projectToolDefault.enabled.includes('subagent');
        return this._subagentGate.isEnabled(tab.session.sessionPath);
    }

    async setActiveTabSubagentsEnabled(enabled: boolean): Promise<void> {
        if (this._subagentSmokeSnapshot) {
            this._subagentSmokeSnapshot = undefined;
            this._subagentSmokeTranscripts.clear();
        }
        await this._host.setActiveSubagentsEnabled(enabled);
    }

    stopActiveTabSubagent(agentId: string): boolean {
        if (this._subagentSmokeSnapshot) return false;
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return false;
        const stopped = tab.session.stopSubagent(agentId);
        if (stopped) this._onLauncherStateChanged.fire();
        return stopped;
    }

    async inspectActiveTabSubagent(agentId: string): Promise<boolean> {
        const smokeTranscript = this._subagentSmokeTranscripts.get(agentId);
        const tab = this._tabs.get(this._activeTabId);
        const transcript = smokeTranscript ?? await tab?.session.readSubagentTranscript(agentId);
        if (!transcript) return false;
        const document = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: formatSubagentTranscript(agentId, transcript),
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return true;
    }

    async resumeActiveTabSubagent(agentId: string, task: string): Promise<void> {
        if (this._subagentSmokeSnapshot) throw new Error('Dismiss the smoke snapshot before resuming a subagent.');
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) throw new Error('No active chat.');
        if (this._isTabBusy(tab)) throw new Error('Wait for the parent agent to finish before resuming a subagent.');
        await tab.session.resumeSubagent(agentId, task);
    }

    async steerActiveTabSubagent(agentId: string, message: string): Promise<boolean> {
        if (this._subagentSmokeSnapshot) return false;
        const tab = this._tabs.get(this._activeTabId);
        return tab ? tab.session.steerSubagent(agentId, message) : false;
    }

    async dismissActiveTabSubagent(agentId: string): Promise<boolean> {
        if (this._subagentSmokeSnapshot) return false;
        const tab = this._tabs.get(this._activeTabId);
        return tab ? tab.session.dismissSubagent(agentId) : false;
    }

    async reviewActiveTabSubagentWorktree(agentId: string): Promise<boolean> {
        const run = this._tabs.get(this._activeTabId)?.session.getSubagentRun(agentId);
        if (!run?.isolationPath) return false;
        const diff = await this._writeIsolation.getWorktreeDiff(run.isolationPath);
        const document = await vscode.workspace.openTextDocument({
            language: 'diff',
            content: diff || '# No worktree changes.\n',
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return true;
    }

    async applyActiveTabSubagentWorktree(agentId: string): Promise<boolean> {
        const run = this._tabs.get(this._activeTabId)?.session.getSubagentRun(agentId);
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!run?.isolationPath || !workspace) return false;
        await this._writeIsolation.applyWorktree(workspace, run.isolationPath);
        return true;
    }

    async cleanupActiveTabSubagentWorktree(agentId: string): Promise<boolean> {
        const run = this._tabs.get(this._activeTabId)?.session.getSubagentRun(agentId);
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!run?.isolationPath || !workspace) return false;
        await this._writeIsolation.cleanupWorktree(workspace, run.isolationPath);
        this._tabs.get(this._activeTabId)?.session.clearSubagentIsolationPath(agentId);
        return true;
    }

    showSubagentSmokeSnapshot(
        snapshot: LauncherSubagentSnapshot,
        transcripts?: Readonly<Record<string, string>>,
    ): void {
        this._subagentSmokeTranscripts = new Map(Object.entries(transcripts ?? {}));
        this._subagentSmokeSnapshot = {
            ...snapshot,
            smokeSimulation: true,
            runs: snapshot.runs.map((run) => ({
                ...run,
                canDismiss: false,
            })),
        };
        this._onLauncherStateChanged.fire();
        void vscode.commands.executeCommand('pi-code.chat.focus');
    }

    dismissSubagentSmokeSnapshot(): void {
        if (!this._subagentSmokeSnapshot) return;
        this._subagentSmokeSnapshot = undefined;
        this._subagentSmokeTranscripts.clear();
        this._onLauncherStateChanged.fire();
    }

    // ── Per-tab tool selection ──
    //
    // Persistent denylist of tools disabled for this chat. Composed with
    // the ToDo toggle (which owns `todo` alone for backward compat) into
    // a single `disabled` set applied via `PiSessionManager.applyToolSelection`.
    // Rationale: MCP-heavy projects can push 100+ tools into the active set,
    // diluting `promptGuidelines` and causing the model to miss meta-tools
    // like `todo`. Per-chat denylist lets the user trim the surface without
    // changing global settings.

    private _getProjectToolSelectionDefault(): ProjectToolSelectionDefault | undefined {
        return parseProjectToolSelectionDefault(
            this._workspaceState.get<unknown>(PROJECT_TOOL_DEFAULT_KEY),
        );
    }

    /** Read the persisted disabled-tools list for this tab. Names not
     *  currently in the registry are still returned — they're preserved
     *  so a disable sticks if the tool comes back later (e.g. an MCP
     *  server re-added). */
    private _getDisabledToolsFor(tab: TabState): string[] {
        return readDisabledTools(
            this._workspaceState,
            tab.session.sessionPath,
            tab.projectToolDefault,
            tab.session.getRegisteredToolsInfo().map((tool) => tool.name),
        );
    }

    private async _setDisabledToolsFor(tab: TabState, disabled: string[]): Promise<void> {
        await writeDisabledTools(
            this._workspaceState,
            tab.session.sessionPath,
            disabled,
        );
    }

    /** The full effective denylist for this tab: everything in the Tools
     *  panel denylist, plus dedicated capability gates such as ToDo and
     *  Subagents. Kept in one place so callers cannot bypass those gates. */
    private _effectiveDisabledTools(tab: TabState): string[] {
        return composeEffectiveDisabledTools(
            this._getDisabledToolsFor(tab),
            this._isTodoEnabledFor(tab),
            this._isSubagentsEnabledFor(tab),
        );
    }

    /** Read persisted state (ToDo toggle + Tools panel denylist) and
     *  apply it to the session. Used at subscribe time and after the
     *  underlying agent session is swapped (`loadSession`, `newSession`) —
     *  both of those create a session whose initial active-tools list is
     *  the SDK default and need the user's explicit selection re-applied. */
    private _applyPersistedToolSelection(tab: TabState): void {
        const disabled = this._effectiveDisabledTools(tab);
        const todoEnabled = this._isTodoEnabledFor(tab);
        const subagentsEnabled = this._isSubagentsEnabledFor(tab);
        this._outputChannel.appendLine(
            `[tool apply] tab="${tab.name || tab.id}" todoEnabled=${todoEnabled} subagentsEnabled=${subagentsEnabled} ` +
            `disabled=[${disabled.join(', ')}]`,
        );
        tab.session.applyToolSelection(disabled);
    }

    /** Diagnostic — one line per prompt showing whether `todo` is active for
     *  this turn. Helps pin down cases where the UI toggle disagrees with the
     *  actual tool set the model sees. */
    private _logPromptToolState(tab: TabState, source: 'prompt' | 'queued' | 'steer' | 'followUp' | 'auto-continue'): void {
        const snap = tab.session.debugSnapshotTools();
        const uiEnabled = this._isTodoEnabledFor(tab);
        const subagentsEnabled = this._isSubagentsEnabledFor(tab);
        this._outputChannel.appendLine(
            `[${source}] tab="${tab.name || tab.id}" todo-toggle=${uiEnabled} subagents-toggle=${subagentsEnabled} ` +
            `todo-in-active=${snap.hasTodo} subagent-in-active=${snap.hasSubagent} ` +
            `todo-registered=${snap.todoRegistered} subagent-registered=${snap.subagentRegistered} ` +
            `active-count=${snap.active.length}` +
            (uiEnabled && !snap.hasTodo ? ' ⚠ UI shows ToDo ON but todo is NOT in active tools' : '') +
            (subagentsEnabled && !snap.hasSubagent ? ' ⚠ Subagents enabled but subagent is NOT in active tools' : ''),
        );
    }

    /** Public entry for the launcher's toggle click. Routes to the
     *  active tab. Ignored if the active tab is busy — the launcher
     *  webview also greys out the toggle, this is belt-and-braces. */
    async setActiveTabTodoEnabled(enabled: boolean): Promise<void> {
        await this._host.setActiveTodoEnabled(enabled);
    }

    /** Public entry — flip a single tool's disabled state via the Tools panel. */
    async setActiveTabToolDisabled(toolName: string, disabled: boolean): Promise<void> {
        await this._host.setActiveToolDisabled(toolName, disabled);
    }

    /** Public entry — replace the disabled-tools list wholesale (used by
     *  the Enable-all / Disable-all buttons and by Paste). */
    async setActiveTabToolsBulk(disabled: string[]): Promise<void> {
        await this._host.setActiveToolsBulk(disabled);
    }

    /** Copy the active tab's tool selection as JSON to the system clipboard.
     *  Format is versioned so a future paste can reject incompatible payloads. */
    async copyActiveTabToolSelection(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        const disabled = this._getDisabledToolsFor(tab);
        const todoEnabled = this._isTodoEnabledFor(tab);
        const subagentsEnabled = this._isSubagentsEnabledFor(tab);
        const payload = {
            piCodeToolSelection: {
                version: 2,
                todoEnabled,
                subagentsEnabled,
                disabled,
            },
        };
        await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
        vscode.window.setStatusBarMessage('Pi Code: tool selection copied.', 2500);
    }

    /** Save the active chat's exact enabled-tool list as the workspace default
     *  for agents created after this point. Existing chats remain unchanged. */
    async setActiveTabToolSelectionAsProjectDefault(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (!vscode.workspace.workspaceFolders?.length) {
            vscode.window.showWarningMessage('Pi Code: open a project folder before saving project tool defaults.');
            return;
        }
        const registered = tab.session.getRegisteredToolsInfo().map((tool) => tool.name);
        const selection = createProjectToolSelectionDefault(
            registered,
            this._effectiveDisabledTools(tab),
        );
        await this._workspaceState.update(PROJECT_TOOL_DEFAULT_KEY, selection);
        vscode.window.setStatusBarMessage(
            'Pi Code: tool selection saved as the project default for new agents.',
            3000,
        );
    }

    /** Read a tool selection from the system clipboard and apply it to the
     *  active tab. Silent-fails with a user notice if the clipboard doesn't
     *  contain our JSON payload. */
    async pasteActiveTabToolSelection(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (this._isTabBusy(tab)) return;

        const text = await vscode.env.clipboard.readText();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch {
            vscode.window.showWarningMessage('Pi Code: clipboard does not contain a valid tool selection.');
            return;
        }
        const cfg = parsed?.piCodeToolSelection;
        if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.disabled) || typeof cfg.todoEnabled !== 'boolean') {
            vscode.window.showWarningMessage('Pi Code: clipboard does not contain a valid tool selection.');
            return;
        }
        const others = cfg.disabled.filter((t: unknown): t is string =>
            typeof t === 'string' && t.length > 0 && t !== 'todo' && t !== 'subagent');
        const subagentsEnabled = typeof cfg.subagentsEnabled === 'boolean'
            ? cfg.subagentsEnabled
            : !cfg.disabled.includes('subagent');
        const applied = await this._host.applyActiveToolSelection({
            todoEnabled: cfg.todoEnabled,
            subagentsEnabled,
            disabled: others,
        });
        if (applied) vscode.window.setStatusBarMessage('Pi Code: tool selection pasted.', 2500);
    }

    private _isTabBusy(tab: TabState): boolean {
        return this._app.isBusy(tab);
    }

    // ── Turn-completion notifications ──

    private _dispatchNextQueuedMessage(tab: TabState): Promise<void> {
        return this._chatService.dispatchNextQueued(tab, {
            decoratePrompt: (text) => decorateDirectPrompt(text, this._isPlanModeEnabledFor(tab)),
            augmentPrompt: (text) => this._fileMentions.augmentPromptIfNeeded(text),
            compact: (instructions) => tab.session.compact(instructions),
            prompt: (text, onAgentStart) => {
                const stopWatchingAgentStart = tab.session.events.on('agent_start', onAgentStart);
                return tab.session.prompt(text).finally(stopWatchingAgentStart);
            },
            isSessionStreaming: () => tab.session.isStreaming,
            handleLocalCommand: (text) => this._handleNameCommand(tab, text, false, false),
            scheduleRetry: (retry) => {
                queueMicrotask(() => {
                    void retry().catch((error) => {
                        this._outputChannel.appendLine(
                            `[queued retry error] ${error instanceof Error ? error.message : String(error)}`,
                        );
                    });
                });
            },
            prepareRequest: () => this._prepareCacheForRequest(tab),
            logQueuedPrompt: () => this._logPromptToolState(tab, 'queued'),
            publishState: () => this.sendStateSync(tab.id),
            reportError: (error) => {
                this._outputChannel.appendLine(
                    `[queued prompt error] ${error instanceof Error ? error.message : String(error)}`,
                );
            },
        });
    }

    getTurnNotificationSettings(): TurnNotificationSettings {
        return {
            showPopup: this._globalState.get<boolean>(
                ChatController.NOTIFICATION_SHOW_POPUP_KEY,
                false,
            ),
            playSound: this._globalState.get<boolean>(
                ChatController.NOTIFICATION_PLAY_SOUND_KEY,
                false,
            ),
        };
    }

    async setNotificationShowPopup(enabled: boolean): Promise<void> {
        await this._globalState.update(ChatController.NOTIFICATION_SHOW_POPUP_KEY, enabled);
        this._onLauncherStateChanged.fire();
    }

    async setNotificationPlaySound(enabled: boolean): Promise<void> {
        await this._globalState.update(ChatController.NOTIFICATION_PLAY_SOUND_KEY, enabled);
        this._onLauncherStateChanged.fire();
    }

    // ── Plan Mode ──

    private _planModeDefaultEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('pi-code')
            .get<boolean>('planMode.defaultEnabled', false);
    }

    private _isPlanModeEnabledFor(tab: TabState): boolean {
        return readSessionBoolean(
            this._workspaceState,
            PLAN_MODE_KEY_PREFIX,
            tab.session.sessionPath,
            this._planModeDefaultEnabled(),
        );
    }

    /** Public entry for the launcher's Plan Mode toggle click. */
    async setActiveTabPlanModeEnabled(enabled: boolean): Promise<void> {
        await this._host.setActivePlanModeEnabled(enabled);
    }

    // ── File Undo View ──

    private _fileUndoViewDefaultEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('pi-code')
            .get<boolean>('fileUndoView.defaultEnabled', false);
    }

    private _isFileUndoViewEnabledFor(tab: TabState): boolean {
        return readSessionBoolean(
            this._workspaceState,
            FILE_UNDO_VIEW_KEY_PREFIX,
            tab.session.sessionPath,
            this._fileUndoViewDefaultEnabled(),
        );
    }

    /** Public entry for the launcher's File Undo View toggle click. */
    async setActiveTabFileUndoViewEnabled(enabled: boolean): Promise<void> {
        await this._host.setActiveFileUndoViewEnabled(enabled);
    }

    private async _handleTabEvent(tab: TabState, event: any): Promise<void> {
        await this._host.handleEvent(tab, event);
    }

    private _updateTabName(tab: TabState): void {
        this._host.refreshTabName(tab);
    }

    /**
     * Build the SerializedAgentState for `tabId` and post it to every sink
     * watching that tab. If `tabId` is omitted, the active tab is used.
     */
    sendStateSync(tabId?: string): void {
        const targetId = tabId ?? this._activeTabId;
        const tab = this._tabs.get(targetId);
        if (!tab) return;

        const state = this._host.getState(targetId);
        if (state) this._postForTab(targetId, { type: 'stateSync', state });
    }

    private _getTabInfos(): TabInfo[] {
        return this._host.application.getTabInfos();
    }

    /** Handle Pi's built-in session naming command without starting a model turn. */
    private _handleNameCommand(
        tab: TabState,
        text: string,
        hasAttachments = false,
        publishState = true,
    ): boolean {
        const name = parseNameCommand(text);
        if (name === null) return false;
        if (!name) throw new Error('Usage: /name <name>');
        if (hasAttachments) {
            throw new Error('The /name command cannot include attachments. Remove attachments and try again.');
        }

        tab.session.setSessionName(name);
        this._updateTabName(tab);
        if (publishState) this.sendStateSync(tab.id);
        return true;
    }

    private _createCommandCallbacks(tab: TabState) {
        return {
            directPrompt: {
                decoratePrompt: (text: string) => decorateDirectPrompt(
                    text,
                    this._isPlanModeEnabledFor(tab),
                ),
                augmentPrompt: (text: string) => this._fileMentions.augmentPromptIfNeeded(text),
                compact: (instructions?: string) => tab.session.compact(instructions),
                prompt: (
                    text: string,
                    images?: ImageAttachment[],
                    files?: FileAttachment[],
                ) => tab.session.prompt(text, images, files),
                prepareRequest: () => this._prepareCacheForRequest(tab),
                logPrompt: () => this._logPromptToolState(tab, 'prompt'),
                publishState: () => this.sendStateSync(tab.id),
                reportDetachedFailure: (error: unknown) => {
                    this._reportCommandFailure('prompt', tab.id, error);
                },
            },
            streaming: {
                augmentPrompt: (text: string) => this._fileMentions.augmentPromptIfNeeded(text),
                prepareRequest: () => this._prepareCacheForRequest(tab),
                logPrompt: (kind: 'steer' | 'followUp') => this._logPromptToolState(tab, kind),
                steer: (
                    text: string,
                    images?: ImageAttachment[],
                    files?: FileAttachment[],
                ) => tab.session.steer(text, images, files),
                followUp: (
                    text: string,
                    images?: ImageAttachment[],
                    files?: FileAttachment[],
                ) => tab.session.followUp(text, images, files),
                abort: () => tab.session.abort(),
            },
            fileMentions: this._fileMentions,
            handleName: (text: string, hasAttachments: boolean, publishState?: boolean) => (
                this._handleNameCommand(tab, text, hasAttachments, publishState)
            ),
            publishState: () => this.sendStateSync(tab.id),
            emit: (message: AgentServerMessage) => this._postForTab(tab.id, message),
            notifyFileHistory: (kind: 'restore' | 'redo', fileCount: number) => {
                const text = kind === 'restore'
                    ? `Restored ${fileCount} file(s) to checkpoint.`
                    : `Re-applied ${fileCount} file(s).`;
                vscode.window.showInformationMessage(text);
            },
        };
    }

    /**
     * Process a webview message. `sourceTabId` identifies the panel that
     * sent the message; if omitted, the message is routed to the active tab
     * (matches the sidebar's behaviour of always operating on the active tab).
     */
    async handleMessage(msg: ClientMessage, sourceTabId?: string): Promise<ChatCommandDispatchResult> {
        try {
            const targetId = sourceTabId ?? this._activeTabId;
            const tab = this._tabs.get(targetId);
            if (!tab) {
                return { ok: false, code: 'tab_not_found', message: `Chat tab not found: ${targetId}` };
            }

            let commandResult: unknown;
            switch (msg.type) {
                case 'openFile': {
                    const fileUri = vscode.Uri.file(msg.filePath);
                    try {
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(doc, { preview: true });
                    } catch { /* file may not exist */ }
                    break;
                }
                case 'openDiff':
                    await this._fileChangePorts.diffPresenter.openDiff(
                        tab.diffManager.getReview(msg.filePath, msg.toolCallId),
                    );
                    break;
                case 'confirmAction': {
                    if (msg.action === 'restoreCheckpoint' || msg.action === 'redoCheckpoint') {
                        this._chatService.assertFileHistoryIdle(tab);
                    }
                    const answer = await vscode.window.showWarningMessage(
                        msg.message,
                        { modal: true },
                        'Yes',
                    );
                    commandResult = { confirmed: answer === 'Yes' };
                    break;
                }
                case 'openSettings':
                    await vscode.commands.executeCommand('pi-code.openSettings');
                    break;
                case 'openKeybindings':
                    await vscode.commands.executeCommand(
                        'workbench.action.openGlobalKeybindings',
                        '@ext:Avhatar.pi-code',
                    );
                    break;
                case 'openChangelog':
                    await vscode.commands.executeCommand(
                        'markdown.showPreview',
                        vscode.Uri.joinPath(this._context.extensionUri, 'CHANGELOG.md'),
                    );
                    break;
                case 'openRawView': {
                    // Target the tab whose panel sent the message so a click on
                    // the button always opens Raw for that specific chat, even
                    // when the launcher's `active tab` is elsewhere.
                    const sessionPath = targetId
                        ? this._tabs.get(targetId)?.session.sessionPath
                        : this.getActiveSessionPath();
                    await vscode.commands.executeCommand(
                        'pi-code.openRawView',
                        sessionPath ? { sessionPath } : undefined,
                    );
                    break;
                }
                default: {
                    const result = await this._host.dispatch(msg, targetId);
                    if (!result.ok) return result;
                    break;
                }
            }
            return commandResult === undefined
                ? { ok: true }
                : { ok: true, result: commandResult };
        } catch (err: any) {
            // Errors from a panel-bound message route back to that panel; for sidebar
            // (no sourceTabId) they go to whoever currently shows the active tab.
            return this._reportCommandFailure(
                msg?.type ?? 'unknown',
                sourceTabId ?? this._activeTabId,
                err,
            );
        }
    }

    private _reportCommandFailure(
        messageType: string,
        targetId: string,
        err: any,
    ): Extract<ChatCommandDispatchResult, { ok: false }> {
        const message = err?.message ?? String(err);
        this._outputChannel.appendLine(
            `[handleMessage error] type=${messageType} tab=${targetId}: ${message}`,
        );
        if (err?.stack) {
            this._outputChannel.appendLine(err.stack);
        }
        this._postForTab(targetId, { type: 'error', message });
        return { ok: false, code: 'command_failed', message };
    }

    private _postAgentError(tab: TabState, raw: string | undefined, assistantMessage?: any): void {
        if (tab.errorReportedThisRun) { return; }
        tab.errorReportedThisRun = true;
        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        const message = formatProviderError(raw);
        this._logProviderError(tab, raw, assistantMessage);
        this._postForTab(tab.id, { type: 'error', message, severity: 'error' });
    }

    /**
     * Post a non-fatal notice about the turn's outcome (e.g. output
     * truncated by `stopReason === 'length'`, or an unmapped stop
     * reason). Sets `errorReportedThisRun` so `agent_end` fallbacks
     * don't stack a second banner on top.
     */
    private _postAgentNotice(
        tab: TabState,
        message: string,
        severity: 'warning' | 'info',
        assistantMessage?: any,
    ): void {
        if (tab.errorReportedThisRun) { return; }
        tab.errorReportedThisRun = true;
        this._logTurnNotice(tab, message, severity, assistantMessage);
        this._postForTab(tab.id, { type: 'error', message, severity });
    }

    private _logProviderError(tab: TabState, raw: string | undefined, assistantMessage?: any): void {
        const provider = assistantMessage?.provider ? String(assistantMessage.provider) : 'unknown';
        const model = assistantMessage?.model ? String(assistantMessage.model) : 'unknown';
        const stopReason = assistantMessage?.stopReason ?? 'unknown';
        const tabLabel = tab.name || tab.id;
        const lines = [
            `[provider error] tab="${tabLabel}" provider=${provider} model=${model} stopReason=${stopReason}`,
        ];
        if (raw) {
            lines.push(`  message: ${raw.replace(/\r?\n/g, ' ')}`);
        } else {
            lines.push('  message: (none — see chat banner for details)');
        }
        for (const line of lines) {
            this._outputChannel.appendLine(line);
        }
    }

    /**
     * One-line summary of every turn's outcome. Emitted unconditionally on
     * every `agent_end` so nothing about how a turn ended is invisible
     * post-hoc — even successful `stop` turns leave a trail in the
     * "Pi Code" output channel. Companion of `_logProviderError`, which
     * fires only when we surface an error banner.
     */
    private _logTurnEnd(tab: TabState, assistantMessage: any | undefined): void {
        const tabLabel = tab.name || tab.id;
        if (!assistantMessage) {
            this._outputChannel.appendLine(`[turn end] tab="${tabLabel}" (no assistant message)`);
            return;
        }
        const provider = assistantMessage.provider ? String(assistantMessage.provider) : 'unknown';
        const model = assistantMessage.model ? String(assistantMessage.model) : 'unknown';
        const stopReason = assistantMessage.stopReason ?? 'unknown';
        const usage = assistantMessage.usage ?? {};
        const input = Number(usage.input ?? 0);
        const output = Number(usage.output ?? 0);
        const cacheRead = Number(usage.cacheRead ?? 0);
        const cacheWrite = Number(usage.cacheWrite ?? 0);
        const parts = [
            `[turn end] tab="${tabLabel}"`,
            `provider=${provider}`,
            `model=${model}`,
            `stopReason=${stopReason}`,
            `in=${input}`,
            `out=${output}`,
            `cacheR=${cacheRead}`,
            `cacheW=${cacheWrite}`,
        ];
        this._outputChannel.appendLine(parts.join(' '));
        const err = assistantMessage.errorMessage;
        if (err) {
            this._outputChannel.appendLine(`  errorMessage: ${String(err).replace(/\r?\n/g, ' ')}`);
        }
    }

    /**
     * At turn end, every `tool_execution_start` should have a matching
     * `tool_execution_end` — if not, the SDK abandoned that tool call and
     * the transcript will show the assistant's tool-use block with no
     * corresponding tool result. Log the orphaned calls, and unless a
     * heavier banner was already surfaced (e.g. provider error), push a
     * warning notice so the user knows the turn wasn't clean.
     */
    private _sweepPendingTools(tab: TabState, assistantMessage: any | undefined): void {
        if (tab.pendingTools.size === 0) return;
        const tabLabel = tab.name || tab.id;
        const entries = collectOrphanedTools(tab.pendingTools, Date.now());
        for (const e of entries) {
            this._outputChannel.appendLine(
                `[tool orphan] tab="${tabLabel}" tool=${e.name} callId=${e.id} elapsedMs=${e.elapsedMs} — tool_execution_start had no matching tool_execution_end at agent_end`,
            );
        }
        tab.pendingTools.clear();

        // Aborted turns are expected to interrupt tools mid-flight — no
        // point pestering the user with a warning about tools they just
        // cancelled themselves.
        const stopReason = assistantMessage?.stopReason;
        if (stopReason === 'aborted') return;

        const names = entries.map((e) => e.name).join(', ');
        const label = entries.length === 1 ? 'tool call did' : `${entries.length} tool calls did`;
        this._postAgentNotice(
            tab,
            `${label} not report completion this turn (${names}). The response above may be incomplete.`,
            'warning',
            assistantMessage,
        );
    }

    private _logTurnNotice(
        tab: TabState,
        message: string,
        severity: 'warning' | 'info',
        assistantMessage?: any,
    ): void {
        const provider = assistantMessage?.provider ? String(assistantMessage.provider) : 'unknown';
        const model = assistantMessage?.model ? String(assistantMessage.model) : 'unknown';
        const stopReason = assistantMessage?.stopReason ?? 'unknown';
        const tabLabel = tab.name || tab.id;
        this._outputChannel.appendLine(
            `[turn ${severity}] tab="${tabLabel}" provider=${provider} model=${model} stopReason=${stopReason}: ${message.replace(/\r?\n/g, ' ')}`,
        );
    }

    private async _createTab(): Promise<string> {
        return this.createTab();
    }

    private async _closeTab(tabId: string): Promise<void> {
        await this._host.closeTab(tabId);
    }

    private _switchTab(tabId: string): void {
        this._host.switchTab(tabId);
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

        void this._workspaceState.update('pi-code.tabs', {
            tabs,
            activeIndex: Math.max(0, activeIndex),
        } satisfies PersistedTabsState);
    }

    async restorePersistedTabs(): Promise<void> {
        const persisted = this._workspaceState.get<PersistedTabsState>('pi-code.tabs');
        if (!persisted || persisted.tabs.length === 0) return;

        const restoredIds = await this._host.restoreTabs(persisted, this._activeTabId);
        if (restoredIds.length === 0) return;
        this._outputChannel.appendLine(`Restored ${restoredIds.length} tab(s).`);
    }

    dispose(): void {
        for (const tab of this._tabs.values()) tab.unsubscribe();
        this._authChangedSubscription?.dispose();
        this._authChangedSubscription = undefined;
        this._codexUsageUnsubscribe?.();
        this._codexUsageUnsubscribe = undefined;
        this._sinks.clear();
        this._openPanels.clear();
        this._panelOpener = undefined;
        this._onTabRenamed.dispose();
        this._onLauncherStateChanged.dispose();
    }
}

function formatSubagentTranscript(agentId: string, transcript: string): string {
    const sections = [`# Subagent transcript`, '', `**Agent ID:** \`${agentId}\``, ''];
    for (const line of transcript.split(/\r?\n/).filter(Boolean)) {
        try {
            const entry = JSON.parse(line) as any;
            if (entry.type === 'session') {
                sections.push('## Session', '', `- Session ID: \`${entry.id ?? 'unknown'}\``, `- Created: ${entry.timestamp ?? 'unknown'}`, '');
                continue;
            }
            if (entry.type === 'message') {
                const role = String(entry.message?.role ?? 'message');
                sections.push(`## ${role[0]?.toUpperCase() ?? ''}${role.slice(1)}`, '', renderTranscriptContent(entry.message?.content), '');
                continue;
            }
            sections.push(`## ${String(entry.type ?? 'entry')}`, '', '```json', JSON.stringify(entry, null, 2), '```', '');
        } catch {
            sections.push('## Unparsed entry', '', '```text', line, '```', '');
        }
    }
    return `${sections.join('\n')}\n`;
}

function renderTranscriptContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``;
    return content.map((part: any) => {
        if (part?.type === 'text') return String(part.text ?? '');
        return `\`\`\`json\n${JSON.stringify(part, null, 2)}\n\`\`\``;
    }).join('\n\n');
}
