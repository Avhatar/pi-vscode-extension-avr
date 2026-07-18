import * as vscode from 'vscode';
import { unlink } from 'fs/promises';
import { PiSessionManager } from '../pi/session';
import type { Logger } from '../core/ports/logger';
import type { SecretStore, SessionRuntimePorts } from '../core/ports/session-platform';
import type { ChatPlatformPorts, FileMentionsPort, StateStore } from '../core/ports/chat-platform';
import { TabRuntime } from '../core/chat/tab-runtime';
import type {
    ClientMessage, ServerMessage, TabInfo,
    LauncherState, LauncherTabInfo, LauncherSessionInfo,
    CacheMode, CacheEffective, TodoSnapshot, LauncherSubagentSnapshot,
    TurnNotificationSettings, ImageAttachment, FileAttachment,
} from '../shared/protocol';
import { getCacheCapability } from '../shared/cache-info';
import {
    createProjectToolSelectionDefault,
    disabledToolsFromProjectDefault,
    parseProjectToolSelectionDefault,
    type ProjectToolSelectionDefault,
} from '../shared/project-tool-default';
import { DiffManager } from '../providers/diff';
import { CheckpointManager } from '../providers/checkpoint';
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
import type { TurnCompletionOutcome } from '../shared/turn-notification';

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
    | { ok: true }
    | { ok: false; code: 'tab_not_found' | 'command_failed'; message: string };

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

// Auto-mode heuristic thresholds for prompt cache retention.
//
// The Anthropic 5-min ephemeral cache (default, "short") survives back-to-back
// turns indefinitely as long as each next request lands within ~5 min of the
// previous one. The 1-hour "long" cache costs ~2× the input price on writes
// (vs ~1.25× for short) but lets the prefix survive idle gaps up to an hour.
//
// We pick "long" speculatively when we expect the next idle gap to exceed
// short's TTL — either because we've already seen a long pause in this
// session, or because the cached prefix is large enough that losing it would
// be expensive even on a single re-write.
const AUTO_IDLE_GAP_THRESHOLD_MS = 2 * 60 * 1000;
const AUTO_LARGE_CONTEXT_TOKENS = 20_000;

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { type: obj?.type, _serializationFailed: true };
    }
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
 * True when an assistant message ended without producing any visible content —
 * no text, no tool calls, no thinking. Some providers (notably DashScope/Qwen)
 * answer HTTP 200 with no choices when the request is rejected for non-network
 * reasons (invalid key, exhausted quota, region mismatch), which leaves
 * `stopReason === 'stop'` and an empty `content` array. Treat that as an
 * error rather than letting it disappear silently.
 */
function isEmptyAssistantResponse(message: any): boolean {
    if (!message || message.role !== 'assistant') return false;
    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) return true;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) return false;
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) return false;
        if (block.type === 'toolCall') return false;
    }
    return true;
}

function buildEmptyResponseMessage(message: any): string {
    const provider = message?.provider ? String(message.provider) : 'the provider';
    const model = message?.model ? `/${message.model}` : '';
    return (
        `${provider}${model} returned an empty response (HTTP succeeded but no content was streamed). ` +
        `This usually means an invalid API key, exhausted quota/balance, or a region/endpoint mismatch ` +
        `(e.g. a China DashScope key on the international endpoint, or vice versa). ` +
        `Check the "Pi Code" output channel and your provider dashboard.`
    );
}

function findLastAssistantMessage(messages: any[]): any | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'assistant') return m;
    }
    return undefined;
}

function turnCompletionOutcome(message: any): TurnCompletionOutcome {
    if (!message) return 'completed';
    if (message.stopReason === 'aborted') return 'stopped';
    if (message.stopReason === 'error' || isEmptyAssistantResponse(message)) return 'failed';
    if (message.stopReason === 'length') return 'truncated';
    return 'completed';
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
    private readonly _workspaceState: StateStore;
    private readonly _globalState: StateStore;
    private _context: vscode.ExtensionContext;

    private _cacheMode: CacheMode = 'auto';
    private _favoriteModels: Set<string> = new Set();
    private static readonly FAVORITES_KEY = 'pi-code.favoriteModels';
    private static readonly NOTIFICATION_SHOW_POPUP_KEY = 'pi-code.notifications.showPopup';
    private static readonly NOTIFICATION_PLAY_SOUND_KEY = 'pi-code.notifications.playSound';

    private _tabs = new Map<string, TabState>();
    private _activeTabId = '';
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

    /** Persistence for the per-tab ToDo toggle. Keyed by the session-file
     *  path so the toggle survives reload and follows the restored session.
     *  Missing entries fall back to the project selection, then configuration. */
    private static readonly TODO_ENABLED_KEY_PREFIX = 'pi-code.todoEnabled.';

    /** Persistence for per-tab Plan Mode toggle. Same shape as ToDo. */
    private static readonly PLAN_MODE_KEY_PREFIX = 'pi-code.planModeEnabled.';

    /** Fixed instruction block injected in front of every user prompt when
     *  the Plan Mode toggle is on. No tool restriction, no phase state —
     *  the agent decides per-prompt whether the request warrants a plan.
     *  The wrapper tags must stay in sync with PLAN_MODE_BLOCK_RE in
     *  webview/main.ts so the block is stripped from the rendered bubble. */
    private static readonly PLAN_MODE_INSTRUCTIONS =
        '<plan-mode-instructions>\n' +
        'Plan Mode is on. Not every prompt needs a plan — use judgment:\n' +
        '\n' +
        '- If the user is asking a question, requesting information, or\n' +
        '  discussing an approach: answer directly, no planning required.\n' +
        '- If the user is asking for changes to code or a multi-step task:\n' +
        '  first study the relevant files, then sketch a plan (use the todo\n' +
        '  tool for multi-step work), then execute. Confirm the approach is\n' +
        '  sound before doing anything invasive.\n' +
        '\n' +
        'When editing a file, oldText must match the current file\n' +
        'byte-for-byte (exact whitespace, indentation, line endings).\n' +
        'Re-read the target region if you are unsure — do not reconstruct\n' +
        'oldText from memory or from an earlier plan.\n' +
        '\n' +
        'You can execute the plan in the same turn once it is clear. Only\n' +
        'stop and wait for the user if you have a genuinely open question\n' +
        'they need to answer before you can proceed.\n' +
        '</plan-mode-instructions>';

    /** Persistence for per-tab File Undo View toggle (the changed-files
     *  bar above the input). Default for missing entries: `false`. */
    private static readonly FILE_UNDO_VIEW_KEY_PREFIX = 'pi-code.fileUndoViewEnabled.';

    /** Persistence for the per-tab Tools panel denylist. Value is `string[]`
     *  of tool names to hide from the LLM. `todo` is handled separately
     *  (see `TODO_ENABLED_KEY_PREFIX`) for backward compat. */
    private static readonly TOOLS_DISABLED_KEY_PREFIX = 'pi-code.disabledTools.';

    /** Exact enabled-tool allowlist applied to newly created agents in this workspace. */
    private static readonly PROJECT_TOOL_DEFAULT_KEY = 'pi-code.projectToolSelectionDefault';

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
    ) {
        this._context = context;
        this._outputChannel = outputChannel;
        this._sessionLogger = initialSession.logger;
        this._sessionSecrets = initialSession.secrets;
        this._sessionPorts = initialSession.ports;
        this._workspaceState = chatPorts.state.workspace;
        this._globalState = chatPorts.state.global;
        this._fileMentions = chatPorts.fileMentions;
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
        });
        this._tabs.set(id, tab);
        this._activeTabId = id;
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
        this._openPanels.set(tabId, panel);
        this._activeTabId = tabId;
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
        if (!this._tabs.has(tabId)) return;
        if (this._activeTabId === tabId) return;
        this._activeTabId = tabId;
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

        await tab.disposeResources();
        this._tabs.delete(tabId);

        if (tabId === this._activeTabId) {
            const next = this._tabs.keys().next().value;
            this._activeTabId = next ?? '';
        }

        this._persistTabs();
        this._onLauncherStateChanged.fire();
    }

    /** Build a snapshot of launcher state (panel tabs + recent sessions). */
    async computeLauncherState(): Promise<Omit<LauncherState, 'historyCollapsed' | 'notificationsCollapsed' | 'todoCollapsed' | 'subagentsCollapsed' | 'toolsCollapsed'>> {
        // Track only tabs with a visible editor panel. A bare TabState without
        // a panel is an internal placeholder (e.g. the initial empty tab), not
        // something the user thinks of as open.
        const tabs: LauncherTabInfo[] = [...this._tabs.values()]
            .filter(tab => this._openPanels.has(tab.id))
            .map(tab => ({
                id: tab.id,
                name: tab.name,
                isStreaming: tab.isStreamingLocal || tab.isCompacting,
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

        // Surface the active tab's todo state to the launcher only when
        // its panel is visible — bare tabs without an editor panel are
        // launcher placeholders, not user-perceived chats.
        let todos: TodoSnapshot | undefined;
        let todoEnabled: boolean | undefined;
        let todoToggleDisabled: boolean | undefined;
        let planModeEnabled: boolean | undefined;
        let planModeToggleDisabled: boolean | undefined;
        let fileUndoViewEnabled: boolean | undefined;
        let subagents: LauncherSubagentSnapshot | undefined;
        let toolSelection: LauncherState['toolSelection'];
        const activeTab = this._tabs.get(this._activeTabId);
        if (activeTab && this._openPanels.has(activeTab.id)) {
            const state = activeTab.session.todoStore.getState();
            todos = { tasks: state.tasks, nextId: state.nextId };
            todoEnabled = this._isTodoEnabledFor(activeTab);
            todoToggleDisabled = this._isTabBusy(activeTab);
            planModeEnabled = this._isPlanModeEnabledFor(activeTab);
            planModeToggleDisabled = this._isTabBusy(activeTab);
            fileUndoViewEnabled = this._isFileUndoViewEnabledFor(activeTab);
            subagents = projectSubagentLauncherSnapshot(activeTab.session.getSubagentSnapshot(), {
                enabled: this._isSubagentsEnabledFor(activeTab),
                toggleDisabled: this._isTabBusy(activeTab),
            });
            toolSelection = {
                registered: activeTab.session.getRegisteredToolsInfo(),
                disabled: this._effectiveDisabledTools(activeTab),
                toggleDisabled: this._isTabBusy(activeTab),
            };
        }

        return {
            tabs, recentSessions,
            notificationSettings: this.getTurnNotificationSettings(),
            todos, todoEnabled, todoToggleDisabled,
            planModeEnabled, planModeToggleDisabled, fileUndoViewEnabled,
            subagents: this._subagentSmokeSnapshot ?? subagents,
            toolSelection,
        };
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
                await tab.disposeResources();
                this._tabs.delete(loadedTabId);
                if (loadedTabId === this._activeTabId) {
                    this._activeTabId = this._tabs.keys().next().value ?? '';
                }
            }
        }

        await this._subagentStore.deleteByParentSessionPath(sessionPath);
        await unlink(sessionPath);
        this._persistTabs();
        this._onLauncherStateChanged.fire();
        if (this._activeTabId) this.sendStateSync(this._activeTabId);
    }

    private _createSessionManager(): PiSessionManager {
        return new PiSessionManager(
            this._sessionLogger,
            this._sessionSecrets,
            this._subagentCoordinator,
            this._subagentStore,
            this._writeIsolation,
            this._childToolFactories,
            this._sessionPorts,
        );
    }

    /**
     * Load a session from disk into a brand-new tab and return its id.
     * Used by the panel serializer when restoring a panel whose session
     * is not currently represented by any tab.
     */
    async createTabFromSessionPath(sessionPath: string): Promise<string> {
        const session = this._createSessionManager();
        await session.initializeFromPath(sessionPath);

        const checkpoint = new CheckpointManager();
        const diff = new DiffManager(session, checkpoint);

        const id = nextTabId();
        const tab = new TabRuntime({
            id,
            session,
            diffManager: diff,
            checkpointManager: checkpoint,
        });
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
    private _computeEffectiveCache(tab: TabState): CacheEffective {
        const model = tab.session.getCurrentModel();
        const cap = getCacheCapability(model?.provider, model?.id);
        if (cap.forcedEffective) {
            return cap.forcedEffective;
        }
        if (this._cacheMode === 'short' || this._cacheMode === 'long') {
            return this._cacheMode;
        }
        if (cap.writeFree) {
            return 'long';
        }
        const pendingIdleGap = tab.lastTurnEndAt > 0 ? Date.now() - tab.lastTurnEndAt : 0;
        const observedMaxGap = Math.max(tab.maxIdleGapMs, pendingIdleGap);
        const tokens = tab.session.serializeState().contextUsage?.tokens ?? 0;
        if (observedMaxGap >= AUTO_IDLE_GAP_THRESHOLD_MS) return 'long';
        if (tokens >= AUTO_LARGE_CONTEXT_TOKENS) return 'long';
        return 'short';
    }

    private _prepareCacheForRequest(tab: TabState): void {
        // Commit the pending idle gap into the persistent max only at the
        // moment a request actually goes out — that's when the gap stops
        // being "still idle, might keep growing" and becomes a realized
        // observation we want to remember for future decisions.
        if (tab.lastTurnEndAt > 0) {
            const idleGap = Date.now() - tab.lastTurnEndAt;
            if (idleGap > tab.maxIdleGapMs) tab.maxIdleGapMs = idleGap;
        }
        const effective = this._computeEffectiveCache(tab);
        tab.cacheEffective = effective;
        if (effective === 'long') {
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

    private _todoEnabledKey(sessionPath: string | undefined): string | undefined {
        if (!sessionPath) return undefined;
        return `${ChatController.TODO_ENABLED_KEY_PREFIX}${sessionPath}`;
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
        const key = this._todoEnabledKey(tab.session.sessionPath);
        const fallback = tab.projectToolDefault
            ? tab.projectToolDefault.enabled.includes('todo')
            : this._todoDefaultEnabled();
        if (!key) return fallback;
        // Explicitly stored values (`true` / `false`) win over the project
        // tool default and the config default once this chat is customized.
        const stored = this._workspaceState.get<unknown>(key);
        return typeof stored === 'boolean' ? stored : fallback;
    }

    private _isSubagentsEnabledFor(tab: TabState): boolean {
        const key = this._subagentGate.key(tab.session.sessionPath);
        const stored = key ? this._workspaceState.get<unknown>(key) : undefined;
        if (typeof stored === 'boolean') return stored;
        if (tab.projectToolDefault) return tab.projectToolDefault.enabled.includes('subagent');
        return this._subagentGate.isEnabled(tab.session.sessionPath);
    }

    private async _setSubagentsEnabledFor(tab: TabState, enabled: boolean): Promise<boolean> {
        const changed = await this._subagentGate.setEnabled(
            tab.session.sessionPath,
            enabled,
            this._isTabBusy(tab),
        );
        if (!changed) return false;
        this._applyPersistedToolSelection(tab);
        this._onLauncherStateChanged.fire();
        return true;
    }

    async setActiveTabSubagentsEnabled(enabled: boolean): Promise<void> {
        if (this._subagentSmokeSnapshot) {
            this._subagentSmokeSnapshot = undefined;
            this._subagentSmokeTranscripts.clear();
        }
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        await this._setSubagentsEnabledFor(tab, enabled);
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
            this._workspaceState.get<unknown>(ChatController.PROJECT_TOOL_DEFAULT_KEY),
        );
    }

    private _toolsDisabledKey(sessionPath: string | undefined): string | undefined {
        if (!sessionPath) return undefined;
        return `${ChatController.TOOLS_DISABLED_KEY_PREFIX}${sessionPath}`;
    }

    /** Read the persisted disabled-tools list for this tab. Names not
     *  currently in the registry are still returned — they're preserved
     *  so a disable sticks if the tool comes back later (e.g. an MCP
     *  server re-added). */
    private _getDisabledToolsFor(tab: TabState): string[] {
        const key = this._toolsDisabledKey(tab.session.sessionPath);
        const stored = key ? this._workspaceState.get<unknown>(key) : undefined;
        if (stored !== undefined) {
            return Array.isArray(stored)
                ? stored.filter((v): v is string => typeof v === 'string' && v.length > 0)
                : [];
        }
        if (!tab.projectToolDefault) return [];
        return disabledToolsFromProjectDefault(
            tab.projectToolDefault,
            tab.session.getRegisteredToolsInfo().map((tool) => tool.name),
        ).filter((tool) => tool !== 'todo' && tool !== 'subagent');
    }

    private async _setDisabledToolsFor(tab: TabState, disabled: string[]): Promise<void> {
        const key = this._toolsDisabledKey(tab.session.sessionPath);
        if (!key) return;
        const uniq = [...new Set(disabled.filter((t) => typeof t === 'string' && t.length > 0))];
        await this._workspaceState.update(key, uniq);
    }

    /** The full effective denylist for this tab: everything in the Tools
     *  panel denylist, plus dedicated capability gates such as ToDo and
     *  Subagents. Kept in one place so callers cannot bypass those gates. */
    private _effectiveDisabledTools(tab: TabState): string[] {
        const base = new Set(this._getDisabledToolsFor(tab));
        if (this._isTodoEnabledFor(tab)) base.delete('todo');
        else base.add('todo');
        if (this._isSubagentsEnabledFor(tab)) base.delete('subagent');
        else base.add('subagent');
        return [...base];
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

    private async _setTodoEnabledFor(tab: TabState, enabled: boolean): Promise<void> {
        const key = this._todoEnabledKey(tab.session.sessionPath);
        if (key) {
            await this._workspaceState.update(key, enabled);
        }
        this._applyPersistedToolSelection(tab);
        this._onLauncherStateChanged.fire();
    }

    /** Public entry for the launcher's toggle click. Routes to the
     *  active tab. Ignored if the active tab is busy — the launcher
     *  webview also greys out the toggle, this is belt-and-braces. */
    async setActiveTabTodoEnabled(enabled: boolean): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (this._isTabBusy(tab)) return;
        await this._setTodoEnabledFor(tab, enabled);
    }

    /** Public entry — flip a single tool's disabled state via the Tools panel. */
    async setActiveTabToolDisabled(toolName: string, disabled: boolean): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (this._isTabBusy(tab)) return;

        // `todo` has its own persisted flag (existing UX + config default).
        // Route through the ToDo toggle path so the two views stay in sync.
        if (toolName === 'todo') {
            await this._setTodoEnabledFor(tab, !disabled);
            return;
        }
        if (toolName === 'subagent') {
            await this._setSubagentsEnabledFor(tab, !disabled);
            return;
        }

        const current = new Set(this._getDisabledToolsFor(tab));
        if (disabled) current.add(toolName);
        else current.delete(toolName);
        await this._setDisabledToolsFor(tab, [...current]);
        this._applyPersistedToolSelection(tab);
        this._onLauncherStateChanged.fire();
    }

    /** Public entry — replace the disabled-tools list wholesale (used by
     *  the Enable-all / Disable-all buttons and by Paste). */
    async setActiveTabToolsBulk(disabled: string[]): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (this._isTabBusy(tab)) return;

        const filtered = disabled.filter((t) => typeof t === 'string' && t.length > 0);
        // Split dedicated capability tools out of the generic denylist so
        // their per-chat toggle storage remains authoritative.
        const wantsTodoDisabled = filtered.includes('todo');
        const wantsSubagentDisabled = filtered.includes('subagent');
        const others = filtered.filter((t) => t !== 'todo' && t !== 'subagent');

        const todoKey = this._todoEnabledKey(tab.session.sessionPath);
        if (todoKey) {
            await this._workspaceState.update(todoKey, !wantsTodoDisabled);
        }
        await this._subagentGate.setEnabled(tab.session.sessionPath, !wantsSubagentDisabled, false);
        await this._setDisabledToolsFor(tab, others);
        this._applyPersistedToolSelection(tab);
        this._onLauncherStateChanged.fire();
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
        await this._workspaceState.update(ChatController.PROJECT_TOOL_DEFAULT_KEY, selection);
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
        const todoKey = this._todoEnabledKey(tab.session.sessionPath);
        if (todoKey) {
            await this._workspaceState.update(todoKey, cfg.todoEnabled);
        }
        const subagentsEnabled = typeof cfg.subagentsEnabled === 'boolean'
            ? cfg.subagentsEnabled
            : !cfg.disabled.includes('subagent');
        await this._subagentGate.setEnabled(tab.session.sessionPath, subagentsEnabled, false);
        await this._setDisabledToolsFor(tab, others);
        this._applyPersistedToolSelection(tab);
        this._onLauncherStateChanged.fire();
        vscode.window.setStatusBarMessage('Pi Code: tool selection pasted.', 2500);
    }

    private _isTabBusy(tab: TabState): boolean {
        return tab.isStreamingLocal || tab.isCompacting;
    }

    // ── Turn-completion notifications ──

    private async _promptUserTask(
        tab: TabState,
        text: string,
        images?: ImageAttachment[],
        files?: FileAttachment[],
    ): Promise<void> {
        const armToken = tab.turnNotificationGate.arm();
        try {
            await tab.session.prompt(text, images, files);
        } finally {
            // If prompt preflight returned without agent_start, do not let this
            // task arm leak into a later internal run. Token matching preserves
            // a newer arm that may already belong to a queued user task.
            tab.turnNotificationGate.cancelArm(armToken);
        }
    }

    private async _dispatchNextQueuedMessage(tab: TabState): Promise<void> {
        const text = tab.queuedMessages[0];
        if (text === undefined) {
            tab.isStreamingLocal = false;
            this.sendStateSync(tab.id);
            return;
        }

        const compactInstructions = parseCompactCommand(text);
        if (compactInstructions !== null) {
            tab.queuedMessages.shift();
            this._prepareCacheForRequest(tab);
            try {
                await tab.session.compact(compactInstructions);
            } catch {
                // The SDK emits compaction_end with a user-facing error message.
            } finally {
                tab.isStreamingLocal = false;
                this.sendStateSync(tab.id);
            }
            if (tab.queuedMessages.length > 0 && !tab.session.serializeState().isStreaming) {
                tab.isStreamingLocal = true;
                this.sendStateSync(tab.id);
                await this._dispatchNextQueuedMessage(tab);
            }
            return;
        }

        let queuedPrompt: string;
        try {
            queuedPrompt = await this._fileMentions.augmentPromptIfNeeded(text);
        } catch (error) {
            tab.isStreamingLocal = false;
            this._outputChannel.appendLine(
                `[queued prompt error] ${error instanceof Error ? error.message : String(error)}`,
            );
            this.sendStateSync(tab.id);
            return;
        }

        // Queue controls remain available while file indexing runs. If the
        // head item changed, prepare the current head instead of dispatching
        // stale text or removing a different item.
        if (tab.queuedMessages[0] !== text) {
            await this._dispatchNextQueuedMessage(tab);
            return;
        }

        tab.queuedMessages.shift();
        if (tab.checkpointManager.rollbackPoint !== null) {
            tab.checkpointManager.discardSuspended();
            tab.diffManager.discardSuspended();
            tab.suspendedMessages = [];
        }
        tab.turnCounter++;
        const turnIdx = tab.turnCounter;
        tab.checkpointManager.startTurn(turnIdx);
        tab.diffManager.setCurrentTurn(turnIdx);
        this._prepareCacheForRequest(tab);
        this._logPromptToolState(tab, 'queued');
        this.sendStateSync(tab.id);

        let agentStarted = false;
        const stopWatchingAgentStart = tab.session.events.on('agent_start', () => {
            agentStarted = true;
        });
        void this._promptUserTask(tab, queuedPrompt)
            .catch((error) => {
                if (!agentStarted) tab.queuedMessages.unshift(text);
                this._outputChannel.appendLine(
                    `[queued prompt error] ${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
                stopWatchingAgentStart();
                if (!agentStarted && !tab.session.serializeState().isStreaming) {
                    tab.isStreamingLocal = false;
                    this.sendStateSync(tab.id);
                }
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

    private _planModeKey(sessionPath: string | undefined): string | undefined {
        if (!sessionPath) return undefined;
        return `${ChatController.PLAN_MODE_KEY_PREFIX}${sessionPath}`;
    }

    private _planModeDefaultEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('pi-code')
            .get<boolean>('planMode.defaultEnabled', false);
    }

    private _isPlanModeEnabledFor(tab: TabState): boolean {
        const key = this._planModeKey(tab.session.sessionPath);
        const fallback = this._planModeDefaultEnabled();
        if (!key) return fallback;
        return this._workspaceState.get<boolean>(key, fallback);
    }

    private async _setPlanModeEnabledFor(tab: TabState, enabled: boolean): Promise<void> {
        const key = this._planModeKey(tab.session.sessionPath);
        if (key) {
            await this._workspaceState.update(key, enabled);
        }
        this._onLauncherStateChanged.fire();
    }

    /** Public entry for the launcher's Plan Mode toggle click. */
    async setActiveTabPlanModeEnabled(enabled: boolean): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        if (this._isTabBusy(tab)) return;
        await this._setPlanModeEnabledFor(tab, enabled);
    }

    // ── File Undo View ──

    private _fileUndoViewKey(sessionPath: string | undefined): string | undefined {
        if (!sessionPath) return undefined;
        return `${ChatController.FILE_UNDO_VIEW_KEY_PREFIX}${sessionPath}`;
    }

    private _fileUndoViewDefaultEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('pi-code')
            .get<boolean>('fileUndoView.defaultEnabled', false);
    }

    private _isFileUndoViewEnabledFor(tab: TabState): boolean {
        const key = this._fileUndoViewKey(tab.session.sessionPath);
        const fallback = this._fileUndoViewDefaultEnabled();
        if (!key) return fallback;
        return this._workspaceState.get<boolean>(key, fallback);
    }

    private async _setFileUndoViewEnabledFor(tab: TabState, enabled: boolean): Promise<void> {
        const key = this._fileUndoViewKey(tab.session.sessionPath);
        if (key) {
            await this._workspaceState.update(key, enabled);
        }
        // Push fresh state to the chat panel so the bar appears/hides
        // immediately, and to the launcher so the toggle reflects the
        // new value.
        this.sendStateSync(tab.id);
        this._onLauncherStateChanged.fire();
    }

    /** Public entry for the launcher's File Undo View toggle click. */
    async setActiveTabFileUndoViewEnabled(enabled: boolean): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) return;
        await this._setFileUndoViewEnabledFor(tab, enabled);
    }

    private async _handleTabEvent(tab: TabState, event: any): Promise<void> {
        let dispatchQueuedAfterEvent = false;

        if (event.type === 'agent_start') {
            tab.session.markTurnStarted?.();
            tab.turnNotificationGate.onAgentStart();
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = Date.now();
            tab.isStreamingLocal = true;
            tab.errorReportedThisRun = false;
            tab.pendingTools.clear();
            const currentModel = tab.session.getCurrentModel();
            const currentUsage = getCodexUsageStore().getCurrent();
            tab.codexTurnModelId = currentModel?.provider === 'openai-codex' ? currentModel.id : undefined;
            tab.codexTurnBaseline = tab.codexTurnModelId && currentUsage && !isCodexUsageStale(currentUsage)
                ? currentUsage
                : null;
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', true);
            }
            this._onLauncherStateChanged.fire();
        }

        if (event.type === 'tool_execution_start' && event.toolCallId) {
            tab.pendingTools.set(String(event.toolCallId), {
                name: String(event.toolName ?? '?'),
                startTime: Date.now(),
            });
        }

        if (event.type === 'tool_execution_end' && event.toolCallId) {
            tab.pendingTools.delete(String(event.toolCallId));
        }

        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'error'
            && event.assistantMessageEvent.reason === 'error') {
            const raw = event.assistantMessageEvent.error?.errorMessage;
            this._postAgentError(tab, raw);
        }

        if (event.type === 'auto_retry_start') {
            const delaySec = Math.max(1, Math.round((event.delayMs ?? 0) / 1000));
            const reason = trimErrorForStatus(event.errorMessage);
            const text = `Pi: rate limited, retry ${event.attempt}/${event.maxAttempts} in ${delaySec}s — ${reason}`;
            vscode.window.setStatusBarMessage(text, (delaySec + 2) * 1000);
        }

        if (event.type === 'compaction_start') {
            tab.isCompacting = true;
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', true);
            }
            this._onLauncherStateChanged.fire();
        }

        if (event.type === 'compaction_end') {
            tab.isCompacting = false;
            if (tab.id === this._activeTabId && !tab.isStreamingLocal) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', false);
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
                const meta = tab.messageMeta.get(lastOrdinal) ?? { thinkingDurationSec: 0, messageEndTime: 0 };
                meta.thinkingDurationSec = tab.streamingThinkingDuration;
                meta.messageEndTime = Date.now();
                tab.messageMeta.set(lastOrdinal, meta);
            }
            tab.streamingThinkingDuration = 0;
            // Reset streaming buffers so the next assistant message in the
            // same turn starts fresh. Without this, `tab.streamingText` /
            // `tab.streamingThinking` carry the finalized message's content
            // into the next `message_update`; deltas append to stale text,
            // and the webview's `#answer-draft` widget shows duplicated
            // content when it repopulates after the mid-turn stateSync wipe.
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
        }

        if (event.type === 'agent_end') {
            // Persist completion before slower post-turn accounting so a window
            // reload cannot misclassify a settled terminal-tool batch.
            tab.session.markTurnCompleted?.();
            const lastAssistant = findLastAssistantMessage(tab.session.getMessages());
            if (!tab.errorReportedThisRun && lastAssistant) {
                const stopReason = lastAssistant.stopReason;
                if (stopReason === 'error') {
                    this._postAgentError(tab, lastAssistant.errorMessage, lastAssistant);
                } else if (stopReason !== 'aborted' && isEmptyAssistantResponse(lastAssistant)) {
                    this._postAgentError(
                        tab,
                        buildEmptyResponseMessage(lastAssistant),
                        lastAssistant,
                    );
                } else if (stopReason === 'length') {
                    // Provider truncated the response because the model hit
                    // its per-turn output token cap. The message content is
                    // valid but incomplete — surface this so the user does
                    // not think the agent silently died mid-sentence.
                    this._postAgentNotice(
                        tab,
                        'Response was cut off — the model hit its output token limit for this turn. Ask it to continue where it left off.',
                        'warning',
                        lastAssistant,
                    );
                } else if (
                    stopReason !== 'stop'
                    && stopReason !== 'aborted'
                    && stopReason !== undefined
                ) {
                    // Any stop reason we do not explicitly recognise
                    // (e.g. 'toolUse' bubbling up to the outer loop, or a
                    // provider-specific value the SDK does not map).
                    // Surface it so nothing gets hidden.
                    this._postAgentNotice(
                        tab,
                        `Turn ended with unexpected stop reason "${String(stopReason)}". The response above may be incomplete.`,
                        'info',
                        lastAssistant,
                    );
                }
            }
            this._logTurnEnd(tab, lastAssistant);
            this._sweepPendingTools(tab, lastAssistant);
            const turnEndAt = Date.now();
            const turnDurationMs = tab.agentStartTime > 0
                ? Math.max(0, turnEndAt - tab.agentStartTime)
                : 0;
            if (turnDurationMs > 0) {
                tab.totalTurnDurationMs += turnDurationMs;
            }
            tab.turnNotificationGate.onAgentEnd({
                tabName: tab.name,
                outcome: turnCompletionOutcome(lastAssistant),
                durationMs: turnDurationMs,
            });

            const baseline = tab.codexTurnBaseline;
            const codexModelId = tab.codexTurnModelId;
            tab.codexTurnBaseline = undefined;
            tab.codexTurnModelId = undefined;
            if (codexModelId) {
                await this._refreshCodexUsageForTab(tab, 'turn ended');
            }
            const after = getCodexUsageStore().getCurrent();
            const turn = computeCodexTurnUsage(baseline ?? null, after, codexModelId);
            const lastOrdinal = lastAssistantOrdinal(tab.session.getMessages());
            if (lastOrdinal >= 0 && (turn || turnDurationMs > 0)) {
                const meta = tab.messageMeta.get(lastOrdinal) ?? { thinkingDurationSec: 0, messageEndTime: 0 };
                if (turn) {
                    meta.codexTurn = turn;
                }
                if (turnDurationMs > 0) {
                    meta.turnDurationMs = turnDurationMs;
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
            tab.lastTurnEndAt = turnEndAt;
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', false);
            }
            this._persistTabs();
            this._onLauncherStateChanged.fire();

            // EventRouter does not await async reducers. If the SDK reached
            // agent_settled while Codex accounting above was still pending,
            // this agent_end reducer is responsible for dispatching after it
            // finishes publishing the old run's terminal state.
            dispatchQueuedAfterEvent = !tab.session.serializeState().isStreaming;
        }

        if (event.type === 'agent_settled') {
            const completion = tab.turnNotificationGate.onAgentSettled();
            if (completion) {
                this._turnNotifier.notify(completion, this.getTurnNotificationSettings());
                if (tab.id !== this._activeTabId) {
                    tab.hasNotification = true;
                    this._persistTabs();
                    this._onLauncherStateChanged.fire();
                }
            }

            // AgentSession remains busy while it emits agent_end. Wait until
            // both the SDK is settled and the async agent_end reducer has
            // published the old run's terminal state before starting a normal
            // prompt. If that reducer is still active, it dispatches instead.
            dispatchQueuedAfterEvent = !tab.isStreamingLocal;
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

        if (dispatchQueuedAfterEvent && tab.queuedMessages.length > 0) {
            // Reserve the tab before publishing terminal state. The queued
            // prompt may still need async file-mention expansion, and the
            // webview must continue treating Enter as queueing during that gap.
            tab.isStreamingLocal = true;
            if (event.type === 'agent_settled') {
                // agent_settled is not part of the regular state-sync set below;
                // publish the reservation before awaiting prompt augmentation.
                this.sendStateSync(tab.id);
            }
        }

        // Stream raw events to whoever is watching this tab (the sidebar if active, panels for this tab).
        this._postForTab(tab.id, { type: 'agentEvent', event: safeSerialize(event) });

        const stateSyncEvents = ['agent_start', 'agent_end', 'message_end', 'turn_end', 'compaction_start', 'compaction_end'];
        if (stateSyncEvents.includes(event.type)) {
            this.sendStateSync(tab.id);
            // When activity happens on a non-active tab, also refresh the sidebar
            // so its tab indicators (streaming spinner / unread dot) update.
            if (tab.id !== this._activeTabId
                && (event.type === 'agent_start' || event.type === 'agent_end')) {
                this.sendStateSync(this._activeTabId);
            }
        }

        if (event.type === 'compaction_end' && event.errorMessage) {
            this._postForTab(tab.id, { type: 'error', message: event.errorMessage });
        }

        if (dispatchQueuedAfterEvent) {
            await this._dispatchNextQueuedMessage(tab);
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
        state.isCompacting = tab.isCompacting;
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
        state.cacheMode = this._cacheMode;
        // Recompute on every sync so `auto` reflects the latest idle gap and
        // context size without waiting for the next prompt to update the chip.
        state.cacheEffective = this._computeEffectiveCache(tab);
        tab.cacheEffective = state.cacheEffective;
        state.fileUndoViewEnabled = this._isFileUndoViewEnabledFor(tab);
        let assistantOrdinal = 0;
        for (let i = 0; i < state.messages.length; i++) {
            if (state.messages[i].role === 'assistant') {
                const meta = tab.messageMeta.get(assistantOrdinal);
                if (meta) {
                    state.messages[i]._thinkingDurationSec = meta.thinkingDurationSec;
                    state.messages[i]._messageEndTime = meta.messageEndTime;
                    if (meta.turnDurationMs !== undefined) {
                        state.messages[i]._turnDurationMs = meta.turnDurationMs;
                    }
                    if (meta.totalTurnDurationMs !== undefined) {
                        state.messages[i]._totalTurnDurationMs = meta.totalTurnDurationMs;
                    }
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
            isStreaming: tab.isStreamingLocal || tab.isCompacting,
            hasNotification: tab.hasNotification,
        }));
    }

    /** Handle Pi's built-in session naming command without starting a model turn. */
    private _handleNameCommand(tab: TabState, text: string): boolean {
        const name = parseNameCommand(text);
        if (name === null) return false;
        if (!name) throw new Error('Usage: /name <name>');

        tab.session.setSessionName(name);
        this._updateTabName(tab);
        this.sendStateSync(tab.id);
        return true;
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

            switch (msg.type) {
                case 'prompt': {
                    if (this._handleNameCommand(tab, msg.text)) break;

                    const compactInstructions = parseCompactCommand(msg.text);
                    if (compactInstructions !== null) {
                        this._prepareCacheForRequest(tab);
                        try {
                            await tab.session.compact(compactInstructions);
                        } catch {
                            // The SDK emits compaction_end with a user-facing error message.
                        }
                        this.sendStateSync(tab.id);
                        break;
                    }

                    // Plan Mode injection — when the toggle is on, prepend a
                    // fixed <plan-mode-instructions> block that tells the agent
                    // to plan before making changes and to re-read files before
                    // editing them. No tool restriction, no state machine — the
                    // agent decides per-prompt whether the task needs a plan.
                    // The wrapper tags let the webview strip the block from the
                    // rendered user bubble; keep them in sync with
                    // PLAN_MODE_BLOCK_RE in webview/main.ts.
                    let promptText = msg.text;
                    if (this._isPlanModeEnabledFor(tab)) {
                        promptText = ChatController.PLAN_MODE_INSTRUCTIONS + '\n\n' + promptText;
                    }

                    if (tab.checkpointManager.rollbackPoint !== null) {
                        tab.checkpointManager.discardSuspended();
                        tab.diffManager.discardSuspended();
                        tab.suspendedMessages = [];
                    }
                    tab.turnCounter++;
                    const turnIdx = tab.turnCounter;
                    tab.checkpointManager.startTurn(turnIdx);
                    tab.diffManager.setCurrentTurn(turnIdx);
                    this._prepareCacheForRequest(tab);
                    this._logPromptToolState(tab, 'prompt');
                    const augmentedPrompt = await this._fileMentions.augmentPromptIfNeeded(promptText);
                    void this._promptUserTask(tab, augmentedPrompt, msg.images, msg.files).catch((error) => {
                        this._reportCommandFailure(msg.type, tab.id, error);
                    });
                    break;
                }
                case 'steer':
                    this._prepareCacheForRequest(tab);
                    this._logPromptToolState(tab, 'steer');
                    await tab.session.steer(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images, msg.files);
                    break;
                case 'queueMessage':
                    if (this._handleNameCommand(tab, msg.text)) break;
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
                    this._prepareCacheForRequest(tab);
                    this._logPromptToolState(tab, 'followUp');
                    await tab.session.followUp(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images, msg.files);
                    break;
                case 'setCacheMode': {
                    const next = msg.mode;
                    if (next !== 'short' && next !== 'long' && next !== 'auto') break;
                    this._cacheMode = next;
                    await this._globalState.update('pi-code.cacheMode', next);
                    // Re-evaluate effective for every tab so the UI reflects the
                    // change immediately, not only after the next prompt.
                    for (const t of this._tabs.values()) {
                        t.cacheEffective = this._computeEffectiveCache(t);
                    }
                    for (const id of this._tabs.keys()) {
                        this.sendStateSync(id);
                    }
                    break;
                }
                case 'abort':
                    await tab.session.abort();
                    break;
                case 'getModels': {
                    const models = tab.session.getModels();
                    const current = tab.session.getCurrentModel();
                    const thinkingLevel = tab.session.getThinkingLevel();
                    this._postForTab(tab.id, {
                        type: 'models',
                        models,
                        current,
                        thinkingLevel,
                        favorites: [...this._favoriteModels],
                    });
                    break;
                }
                case 'setModel':
                    await tab.session.setModel(msg.provider, msg.modelId);
                    this.sendStateSync(tab.id);
                    break;
                case 'toggleFavorite': {
                    const key = `${msg.provider}:${msg.modelId}`;
                    if (this._favoriteModels.has(key)) {
                        this._favoriteModels.delete(key);
                    } else {
                        this._favoriteModels.add(key);
                    }
                    await this._globalState.update(
                        ChatController.FAVORITES_KEY,
                        [...this._favoriteModels],
                    );
                    this._broadcastModels();
                    break;
                }
                case 'setThinkingLevel':
                    tab.session.setThinkingLevel(msg.level);
                    this.sendStateSync(tab.id);
                    break;
                case 'newSession': {
                    await tab.session.newSession();
                    const projectToolDefault = this._getProjectToolSelectionDefault();
                    tab.projectToolDefault = projectToolDefault;
                    this._applyPersistedToolSelection(tab);
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.resetSessionProjection(projectToolDefault);
                    this._onTabRenamed.fire({ tabId: tab.id, name: tab.name });
                    this.sendStateSync(tab.id);
                    break;
                }
                case 'loadSession':
                    await tab.session.loadSession(msg.sessionPath);
                    tab.projectToolDefault = undefined;
                    this._applyPersistedToolSelection(tab);
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.resetSessionProjection(undefined);
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
            }
            return { ok: true };
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
        const now = Date.now();
        const entries = Array.from(tab.pendingTools.entries()).map(([id, meta]) => ({
            id,
            name: meta.name,
            elapsedMs: Math.max(0, now - meta.startTime),
        }));
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
        const newSession = this._createSessionManager();
        await newSession.initialize();

        const newCheckpoint = new CheckpointManager();
        const newDiff = new DiffManager(newSession, newCheckpoint);

        const id = nextTabId();
        const tab = new TabRuntime({
            id,
            session: newSession,
            diffManager: newDiff,
            checkpointManager: newCheckpoint,
            projectToolDefault: this._getProjectToolSelectionDefault(),
        });
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

        await tab.disposeResources();
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

        void this._workspaceState.update('pi-code.tabs', {
            tabs,
            activeIndex: Math.max(0, activeIndex),
        } satisfies PersistedTabsState);
    }

    async restorePersistedTabs(): Promise<void> {
        const persisted = this._workspaceState.get<PersistedTabsState>('pi-code.tabs');
        if (!persisted || persisted.tabs.length === 0) { return; }

        // Remember the initial empty tab to dispose after successful restore
        const initialTabId = this._activeTabId;
        const initialTab = this._tabs.get(initialTabId);

        const restoredIds: string[] = [];

        for (const { name, sessionPath } of persisted.tabs) {
            try {
                const session = this._createSessionManager();
                await session.initializeFromPath(sessionPath);

                const checkpoint = new CheckpointManager();
                const diff = new DiffManager(session, checkpoint);

                const id = nextTabId();
                const tab = new TabRuntime({
                    id,
                    session,
                    diffManager: diff,
                    checkpointManager: checkpoint,
                });
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
            await initialTab.disposeResources();
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

function parseNameCommand(text: string): string | undefined | null {
    const trimmed = text.trim();
    if (trimmed === '/name') return undefined;
    if (trimmed.startsWith('/name ')) {
        return trimmed.slice('/name '.length).trim() || undefined;
    }
    return null;
}

function parseCompactCommand(text: string): string | undefined | null {
    const trimmed = text.trim();
    if (trimmed === '/compact') return undefined;
    if (trimmed.startsWith('/compact ')) {
        return trimmed.slice('/compact '.length).trim() || undefined;
    }
    return null;
}
