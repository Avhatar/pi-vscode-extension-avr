import * as vscode from 'vscode';
import { unlink } from 'fs/promises';
import { PiSessionManager } from '../pi/session';
import type {
    ClientMessage, ServerMessage, TabInfo,
    LauncherState, LauncherTabInfo, LauncherSessionInfo,
    CacheMode, CacheEffective, TodoSnapshot,
} from '../shared/protocol';
import { getCacheCapability } from '../shared/cache-info';
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
    turnDurationMs?: number;
    totalTurnDurationMs?: number;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

/** Plan Mode phase for the current tab. */
type PlanModePhase = 'idle' | 'plan' | 'exec';

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
    /** Sum of completed agent turn durations in this tab, excluding idle gaps between turns. */
    totalTurnDurationMs: number;
    messageMeta: Map<number, MessageMeta>;
    hasNotification: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    queuedMessages: string[];
    /** Locally tracked streaming flag – the SDK's isStreaming lags behind agent_end. */
    isStreamingLocal: boolean;
    /** True while SDK context compaction is running. */
    isCompacting: boolean;
    /** Codex usage snapshot captured at agent_start; used to compute per-turn delta on agent_end. */
    codexTurnBaseline?: CodexUsageSnapshot | null;
    /** Set when a provider error has already been surfaced to the UI for the current run, so the agent_end fallback doesn't duplicate it. */
    errorReportedThisRun: boolean;
    /** Timestamp (ms) of the last `agent_end`. Used by `auto` cache heuristic. 0 means no turn finished yet. */
    lastTurnEndAt: number;
    /** Largest idle gap (ms) ever observed between successive turns in this tab's session. */
    maxIdleGapMs: number;
    /** Cache retention applied to the most recent request from this tab. */
    cacheEffective: CacheEffective;
    /** Plan Mode: current phase (idle → plan → exec → idle). */
    planModePhase: PlanModePhase;
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
        totalTurnDurationMs: 0,
        messageMeta: new Map(),
        hasNotification: false,
        pendingApprovals: new Map(),
        queuedMessages: [],
        isStreamingLocal: false,
        isCompacting: false,
        errorReportedThisRun: false,
        lastTurnEndAt: 0,
        maxIdleGapMs: 0,
        cacheEffective: 'short',
        planModePhase: 'idle',
    };
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

/**
 * Owns all chat tab state and routes messages from views to the appropriate
 * tab. View layers (sidebar, editor panels) attach themselves as a
 * {@link ChatViewSink} via {@link addSink} and forward webview messages via
 * {@link handleMessage} (passing their bound `tabId` if any).
 */
export class ChatController implements vscode.Disposable {
    private _outputChannel: vscode.OutputChannel;
    private _context: vscode.ExtensionContext;

    private _cacheMode: CacheMode = 'auto';
    private _favoriteModels: Set<string> = new Set();
    private static readonly FAVORITES_KEY = 'pi-code.favoriteModels';

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

    /** Persistence for per-tab ToDo toggle. Keyed by the session-file
     *  path (the same key used for tab persistence) so the toggle
     *  state survives reload and the tab is matched correctly on
     *  restore. Default for missing entries: `false` — the model
     *  knows nothing about ToDo until the user explicitly opts in. */
    private static readonly TODO_ENABLED_KEY_PREFIX = 'pi-code.todoEnabled.';

    /** Persistence for per-tab Plan Mode toggle. Same shape as ToDo. */
    private static readonly PLAN_MODE_KEY_PREFIX = 'pi-code.planModeEnabled.';

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
        const storedMode = context.globalState.get<CacheMode>('pi-code.cacheMode');
        if (storedMode === 'short' || storedMode === 'long' || storedMode === 'auto') {
            this._cacheMode = storedMode;
        }
        const storedFavorites = context.globalState.get<string[]>(
            ChatController.FAVORITES_KEY,
        );
        if (Array.isArray(storedFavorites)) {
            this._favoriteModels = new Set(storedFavorites);
        }
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

    /** Build a snapshot of launcher state (panel tabs + recent sessions). */
    async computeLauncherState(): Promise<Omit<LauncherState, 'historyCollapsed' | 'todoCollapsed'>> {
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
        const activeTab = this._tabs.get(this._activeTabId);
        if (activeTab && this._openPanels.has(activeTab.id)) {
            const state = activeTab.session.todoStore.getState();
            todos = { tasks: state.tasks, nextId: state.nextId };
            todoEnabled = this._isTodoEnabledFor(activeTab);
            todoToggleDisabled = this._isTabBusy(activeTab);
            planModeEnabled = this._isPlanModeEnabledFor(activeTab);
            planModeToggleDisabled = this._isTabBusy(activeTab);
        }

        return { tabs, recentSessions, todos, todoEnabled, todoToggleDisabled, planModeEnabled, planModeToggleDisabled };
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
     * - For backends where cache writes are free (OpenAI, DeepSeek, Z.AI, …),
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
        if (this._cacheMode === 'short' || this._cacheMode === 'long') {
            return this._cacheMode;
        }
        const model = tab.session.getCurrentModel();
        const cap = getCacheCapability(model?.provider, model?.id);
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

        // Apply persisted ToDo toggle for this tab. The session is
        // already initialised at this point, so setTodoVisibility()
        // takes effect immediately — replay (which fired on
        // session_start during initialize) has populated the store
        // with whatever todos survived in the branch.
        //
        // Symmetric: also force OFF when persisted is false. The SDK
        // enables all extension tools by default, so without this the
        // user's "OFF" preference would be silently ignored on paths
        // that skip a fresh `initialize()` (panel restore via
        // `initializeFromPath`, `loadSession`, `newSession`).
        this._applyPersistedTodo(tab);

        // Apply persisted Plan Mode toggle. Same shape as ToDo — the
        // toggle gates the feature; when OFF the agent has full tools
        // immediately on every prompt.
        this._applyPersistedPlanMode(tab);

        tab.session.setToolApprovalHandler(async (toolCallId, toolName, args) => {
            return this._requestToolApproval(tab, toolCallId, toolName, args);
        });

        this._tabSubscriptions.set(tab.id, unsubs);
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

    /** Read persisted ToDo state for `tab` and apply it to the session
     *  without writing back. Used at subscribe time and after the
     *  underlying agent session is swapped (`loadSession`, `newSession`)
     *  — both of those create a session whose initial active-tools list
     *  is the SDK default (todo ON) and need the user's explicit OFF
     *  preference re-applied. */
    private _applyPersistedTodo(tab: TabState): void {
        tab.session.setTodoVisibility(this._isTodoEnabledFor(tab));
    }

    private _isTodoEnabledFor(tab: TabState): boolean {
        const key = this._todoEnabledKey(tab.session.sessionPath);
        const fallback = this._todoDefaultEnabled();
        if (!key) return fallback;
        // Explicitly stored values (`true` / `false`) win over the
        // config default — so once the user toggled OFF for a chat,
        // it stays OFF even if `defaultEnabled` is `true`.
        return this._context.workspaceState.get<boolean>(key, fallback);
    }

    private async _setTodoEnabledFor(tab: TabState, enabled: boolean): Promise<void> {
        const key = this._todoEnabledKey(tab.session.sessionPath);
        if (!key) {
            // No session path yet (rare — only for a brand-new tab
            // before Pi created its session file). Skip persistence
            // but still apply visibility so the user sees an effect.
            tab.session.setTodoVisibility(enabled);
            this._onLauncherStateChanged.fire();
            return;
        }
        await this._context.workspaceState.update(key, enabled);
        tab.session.setTodoVisibility(enabled);
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

    private _isTabBusy(tab: TabState): boolean {
        return tab.isStreamingLocal || tab.isCompacting;
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

    private _applyPersistedPlanMode(tab: TabState): void {
        const enabled = this._isPlanModeEnabledFor(tab);
        // When enabled, start in `idle` phase so the next prompt
        // triggers a planning cycle. When disabled, ensure full
        // tools are restored.
        if (enabled) {
            tab.planModePhase = 'idle';
            tab.session.setPlanModeActive(false); // ensure full tools initially
        } else {
            tab.session.setPlanModeActive(false);
            tab.planModePhase = 'idle';
        }
    }

    private _isPlanModeEnabledFor(tab: TabState): boolean {
        const key = this._planModeKey(tab.session.sessionPath);
        const fallback = this._planModeDefaultEnabled();
        if (!key) return fallback;
        return this._context.workspaceState.get<boolean>(key, fallback);
    }

    private async _setPlanModeEnabledFor(tab: TabState, enabled: boolean): Promise<void> {
        const key = this._planModeKey(tab.session.sessionPath);
        if (!key) {
            tab.session.setPlanModeActive(false);
            tab.planModePhase = 'idle';
            this._onLauncherStateChanged.fire();
            return;
        }
        await this._context.workspaceState.update(key, enabled);
        if (enabled) {
            tab.planModePhase = 'idle';
            tab.session.setPlanModeActive(false);
        } else {
            tab.session.setPlanModeActive(false);
            tab.planModePhase = 'idle';
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

    // ── Plan Mode heuristic: follow-up vs new task ──
    //
    // After the agent finishes executing (EXEC phase → agent_end),
    // the next user message might be a minor follow-up ("also add X",
    // "fix the typo", "thanks") or a brand-new task. We distinguish
    // based on message length and timing to avoid re-entering the
    // PLAN phase for trivial continuations.

    /** Max message length (chars) for a message to be considered a follow-up. */
    private static readonly FOLLOWUP_MAX_LENGTH = 120;
    /** Max idle time (ms) since last agent_end before forcing a new PLAN cycle. */
    private static readonly FOLLOWUP_MAX_IDLE_MS = 2 * 60 * 1000;

    /** Heuristic patterns that suggest a confirmation or follow-up. */
    private static readonly FOLLOWUP_PATTERNS = [
        /^(ok|okay|yes|yeah|yep|sure|да|ага|ок|хорошо|ладно|го|погнали|поехали|давай|продолжай|continue|proceed|go ahead|go on|lgtm|looks good|approved?\.?)/i,
        /^(thanks|thank you|thx|спасибо|спс|мерси)/i,
        /^(и|а|a|and|also|тоже|также|ещё|еще|plus|additionally)/i,
        /^(fix|исправь|поправь|добавь|удали|поменяй|переименуй|сделай).{0,50}$/i,
        /^(what about|как насчет|как насчёт|а как|what if|а если)/i,
        /^(no|нет|не|don't|не надо).{0,80}$/i,
        /^[?]\w|^(why|почему|зачем|как|how|what|что|where|где|when|когда).{0,60}[?]$/i,
    ];

    private _isFollowUp(tab: TabState, text: string): boolean {
        const trimmed = text.trim();
        if (trimmed.length > ChatController.FOLLOWUP_MAX_LENGTH) return false;

        const idleGap = tab.lastTurnEndAt > 0 ? Date.now() - tab.lastTurnEndAt : 0;
        if (idleGap > ChatController.FOLLOWUP_MAX_IDLE_MS) return false;

        for (const pattern of ChatController.FOLLOWUP_PATTERNS) {
            if (pattern.test(trimmed)) return true;
        }
        return false;
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
            tab.errorReportedThisRun = false;
            tab.codexTurnBaseline = getCodexUsageStore().getCurrent();
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', true);
            }
            this._onLauncherStateChanged.fire();
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
        }

        if (event.type === 'agent_end') {
            if (!tab.errorReportedThisRun) {
                const msgs = tab.session.getMessages();
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const m = msgs[i] as any;
                    if (m?.role === 'assistant') {
                        if (m.stopReason === 'error') {
                            this._postAgentError(tab, m.errorMessage, m);
                        } else if (m.stopReason !== 'aborted' && isEmptyAssistantResponse(m)) {
                            this._postAgentError(
                                tab,
                                buildEmptyResponseMessage(m),
                                m,
                            );
                        }
                        break;
                    }
                }
            }
            const turnEndAt = Date.now();
            const turnDurationMs = tab.agentStartTime > 0
                ? Math.max(0, turnEndAt - tab.agentStartTime)
                : 0;
            if (turnDurationMs > 0) {
                tab.totalTurnDurationMs += turnDurationMs;
            }

            const baseline = tab.codexTurnBaseline;
            tab.codexTurnBaseline = undefined;
            const after = getCodexUsageStore().getCurrent();
            const turn = computeCodexTurnUsage(baseline ?? null, after);
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
            // Plan Mode: after executing, return to idle so the next
            // prompt starts a fresh planning cycle (unless it's a follow-up).
            if (tab.planModePhase === 'exec') {
                tab.planModePhase = 'idle';
            }
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-code.isStreaming', false);
            } else {
                tab.hasNotification = true;
            }
            this._persistTabs();
            this._onLauncherStateChanged.fire();

            if (tab.queuedMessages.length > 0) {
                const text = tab.queuedMessages.shift()!;
                const compactInstructions = parseCompactCommand(text);
                if (compactInstructions !== null) {
                    this._prepareCacheForRequest(tab);
                    try {
                        await tab.session.compact(compactInstructions);
                    } catch {
                        // The SDK emits compaction_end with a user-facing error message.
                    }
                    this.sendStateSync(tab.id);
                } else {
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
                    tab.session.prompt(await this._fileMentions.augmentPromptIfNeeded(text));
                }
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

                    // Plan Mode interception — restrict tools during PLAN phase.
                    const planEnabled = this._isPlanModeEnabledFor(tab);
                    if (planEnabled) {
                        if (tab.planModePhase === 'idle') {
                            // Start a new planning cycle: restrict to read-only tools.
                            tab.planModePhase = 'plan';
                            tab.session.setPlanModeActive(true);
                        } else if (tab.planModePhase === 'plan') {
                            // User is responding to the plan — grant full tools for execution.
                            tab.planModePhase = 'exec';
                            tab.session.setPlanModeActive(false);
                        } else if (tab.planModePhase === 'exec') {
                            // During execution, decide: follow-up or new task?
                            if (this._isFollowUp(tab, msg.text)) {
                                // Minor follow-up — keep full tools, stay in exec.
                            } else {
                                // New task — start a fresh planning cycle.
                                tab.planModePhase = 'plan';
                                tab.session.setPlanModeActive(true);
                            }
                        }
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
                    await tab.session.prompt(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images, msg.files);
                    break;
                }
                case 'steer':
                    this._prepareCacheForRequest(tab);
                    await tab.session.steer(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images, msg.files);
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
                    this._prepareCacheForRequest(tab);
                    await tab.session.followUp(await this._fileMentions.augmentPromptIfNeeded(msg.text), msg.images, msg.files);
                    break;
                case 'setCacheMode': {
                    const next = msg.mode;
                    if (next !== 'short' && next !== 'long' && next !== 'auto') break;
                    this._cacheMode = next;
                    await this._context.globalState.update('pi-code.cacheMode', next);
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
                    // If the user aborted during PLAN phase, reset to idle
                    // so the next prompt starts a fresh planning cycle rather
                    // than jumping directly to execution.
                    if (tab.planModePhase === 'plan') {
                        tab.planModePhase = 'idle';
                    }
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
                    await this._context.globalState.update(
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
                case 'newSession':
                    await tab.session.newSession();
                    this._applyPersistedTodo(tab);
                    this._applyPersistedPlanMode(tab);
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
                    tab.totalTurnDurationMs = 0;
                    tab.isStreamingLocal = false;
                    tab.isCompacting = false;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    tab.lastTurnEndAt = 0;
                    tab.maxIdleGapMs = 0;
                    this._onTabRenamed.fire({ tabId: tab.id, name: tab.name });
                    this.sendStateSync(tab.id);
                    break;
                case 'loadSession':
                    await tab.session.loadSession(msg.sessionPath);
                    this._applyPersistedTodo(tab);
                    this._applyPersistedPlanMode(tab);
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
                    tab.totalTurnDurationMs = 0;
                    tab.isStreamingLocal = false;
                    tab.isCompacting = false;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    tab.lastTurnEndAt = 0;
                    tab.maxIdleGapMs = 0;
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
            const message = err?.message ?? String(err);
            this._outputChannel.appendLine(
                `[handleMessage error] type=${msg?.type ?? 'unknown'} tab=${targetId}: ${message}`,
            );
            if (err?.stack) {
                this._outputChannel.appendLine(err.stack);
            }
            this._postForTab(targetId, { type: 'error', message });
        }
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
        this._postForTab(tab.id, { type: 'error', message });
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

function parseCompactCommand(text: string): string | undefined | null {
    const trimmed = text.trim();
    if (trimmed === '/compact') return undefined;
    if (trimmed.startsWith('/compact ')) {
        return trimmed.slice('/compact '.length).trim() || undefined;
    }
    return null;
}
