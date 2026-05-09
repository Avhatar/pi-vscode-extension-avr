export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    estimated?: boolean;
}

export interface CodexUsageWindow {
    /** Percentage already used in this window (0-100). */
    percentUsed: number;
    /** Window length in minutes (e.g. 300 for the 5h window, 10080 for the weekly one). */
    windowMinutes: number;
    /** Seconds until reset, as reported when the headers were captured. */
    resetAfterSeconds: number;
    /** Unix epoch seconds when the window resets. */
    resetAt: number;
}

export interface CodexUsageCredits {
    balance?: string;
    hasCredits: boolean;
    unlimited: boolean;
}

export interface CodexUsageSnapshot {
    /** Subscription plan label reported by Codex (e.g. "plus", "pro"). */
    planType: string;
    /** Active limit label (e.g. "premium"). */
    activeLimit?: string;
    primary?: CodexUsageWindow;
    secondary?: CodexUsageWindow;
    credits?: CodexUsageCredits;
    /** Unix epoch milliseconds when these headers were captured. */
    capturedAt: number;
}

export interface CodexTurnWindowDelta {
    windowMinutes: number;
    /** Window usage at the start of the turn (clamped to 0 if the window reset mid-turn). */
    beforePercent: number;
    /** Window usage right after the turn ended. */
    afterPercent: number;
    /** Percent points consumed by this turn. */
    deltaPercent: number;
}

export interface CodexTurnUsage {
    primary?: CodexTurnWindowDelta;
    secondary?: CodexTurnWindowDelta;
    /** Unix epoch milliseconds when the post-turn snapshot was captured. */
    capturedAt: number;
}

export interface OAuthProviderInfo {
    id: string;
    name: string;
    signedIn: boolean;
    usesCallbackServer: boolean;
}

export interface SettingsData {
    apiProvider: string;
    apiBaseUrl: string;
    apiKeySet: boolean;
    authMethod: 'env' | 'pi-login' | 'manual' | 'none';
    defaultModel: string;
    thinkingLevel: string;
    autoApproveTools: boolean;
    allowedTools: string[];
    autoSaveSessions: boolean;
    sessionStoragePath: string;
    contextUsageWarningThreshold: number;
    oauthProviders: OAuthProviderInfo[];
}

export type OAuthFlowState =
    | { kind: 'idle' }
    | { kind: 'starting'; message?: string }
    | { kind: 'awaitingBrowser'; url: string; instructions?: string; promptForCode?: { message: string; placeholder?: string; allowEmpty?: boolean } }
    | { kind: 'progress'; message: string }
    | { kind: 'success' }
    | { kind: 'error'; message: string };

export interface ToolCallPendingInfo {
    toolCallId: string;
    toolName: string;
    args: any;
}

export interface FileChangeInfo {
    filePath: string;
    toolCallId: string;
    toolName: string;
    isNew: boolean;
    diff?: string;
    addedLines: number;
    removedLines: number;
    turnIndex: number;
}

export interface TabInfo {
    id: string;
    name: string;
    isActive: boolean;
    isStreaming: boolean;
    hasNotification: boolean;
}

export type CacheMode = 'short' | 'long' | 'auto';
export type CacheEffective = 'short' | 'long';

export interface SerializedAgentState {
    messages: any[];
    model?: { provider: string; id: string; name?: string; supportsImages?: boolean };
    thinkingLevel?: string;
    isStreaming: boolean;
    isCompacting?: boolean;
    streamingMessage?: any;
    errorMessage?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    /** Absolute path to the persisted session file (used by webview panels for restoration). */
    sessionPath?: string;
    contextUsage?: ContextUsageInfo;
    fileChanges?: FileChangeInfo[];
    rollbackPoint?: number | null;
    tabs?: TabInfo[];
    activeTabId?: string;
    streamingText?: string;
    streamingThinking?: string;
    isThinking?: boolean;
    thinkingStartTime?: number;
    streamingThinkingDuration?: number;
    queuedMessages?: string[];
    /** User preference for prompt cache retention. Global, persisted in extension state. */
    cacheMode?: CacheMode;
    /** Effective retention applied to the next request for this tab (computed in `auto`). */
    cacheEffective?: CacheEffective;
}

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
    supportsImages?: boolean;
}

export interface ImageAttachment {
    type: 'image';
    data: string;
    mimeType: string;
    name?: string;
    size?: number;
    width?: number;
    height?: number;
}

export interface FileAttachment {
    type: 'file';
    data: string;
    mimeType: string;
    name: string;
    size: number;
    binary?: boolean;
}

export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
    source: string;
    disableModelInvocation: boolean;
}

export interface WorkspaceFileSuggestion {
    relativePath: string;
    basename: string;
    insertText: string;
}

export interface SessionInfo {
    id: string;
    name?: string;
    firstMessage?: string;
    path: string;
    lastModified?: number;
}

// Webview -> Extension messages
export type ClientMessage =
    | { type: 'prompt'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
    | { type: 'steer'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
    | { type: 'followUp'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
    | { type: 'abort' }
    | { type: 'getModels' }
    | { type: 'setModel'; provider: string; modelId: string }
    | { type: 'setThinkingLevel'; level: string }
    | { type: 'newSession' }
    | { type: 'loadSession'; sessionPath: string }
    | { type: 'getSessions' }
    | { type: 'getState' }
    | { type: 'approveToolCall'; toolCallId: string }
    | { type: 'rejectToolCall'; toolCallId: string }
    | { type: 'openFile'; filePath: string }
    | { type: 'openDiff'; filePath: string; toolCallId: string }
    | { type: 'undoFileChange'; filePath: string; toolCallId: string }
    | { type: 'restoreCheckpoint'; messageIndex: number }
    | { type: 'redoCheckpoint' }
    | { type: 'confirmAction'; action: string; message: string; payload?: any }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'switchTab'; tabId: string }
    | { type: 'openSettings' }
    | { type: 'getSkills' }
    | { type: 'searchWorkspaceFiles'; query: string; requestId: number }
    | { type: 'queueMessage'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    | { type: 'cancelQueue' }
    | { type: 'setCacheMode'; mode: CacheMode };

// ── Launcher (sidebar) ──
//
// The sidebar webview is a launcher: it shows recent sessions and lets the
// user open a chat as an editor panel. It does not host the chat itself.

export interface LauncherTabInfo {
    id: string;
    name: string;
    isStreaming: boolean;
    hasNotification: boolean;
    /** True if a `WebviewPanel` is currently visible for this tab. */
    isOpen: boolean;
    /** Optional: provider/model id for a small badge. */
    modelLabel?: string;
}

export interface LauncherSessionInfo {
    path: string;
    name?: string;
    firstMessage?: string;
    lastModified?: number;
    /** True if this session is already represented by an open tab. */
    isOpen: boolean;
}

// ── ToDo (per-tab persistent task list) ──
//
// Cross-boundary types for the persistent ToDo feature. `TaskInfo` mirrors
// the in-memory `Task` shape on the host side; `src/pi/todo/types.ts`
// re-exports it so reducer code never has to round-trip through this file.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskInfo {
    id: number;
    subject: string;
    description?: string;
    activeForm?: string;
    status: TaskStatus;
    blockedBy?: number[];
}

export interface TodoSnapshot {
    tasks: TaskInfo[];
    nextId: number;
}

export interface LauncherState {
    tabs: LauncherTabInfo[];
    recentSessions: LauncherSessionInfo[];
    historyCollapsed: boolean;
    /** Active tab's todo snapshot. Absent when there is no active tab. */
    todos?: TodoSnapshot;
    /** Per-tab toggle state for the active tab. Absent when there is
     *  no active tab. The tool's visibility to the model is gated on
     *  this — when false, the model has zero knowledge of the ToDo
     *  feature (no schema, no promptGuidelines). */
    todoEnabled?: boolean;
    /** True when the active tab is streaming or compacting and the
     *  toggle should be greyed out. The launcher webview ignores
     *  click events while this is true. */
    todoToggleDisabled?: boolean;
    /** Whether the user has collapsed the ToDo section in the sidebar
     *  (purely a UI preference, global like `historyCollapsed`).
     *  Persisted via globalState. */
    todoCollapsed: boolean;
}

export type LauncherClientMessage =
    | { type: 'getLauncherState' }
    | { type: 'openTab'; tabId: string }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'openSession'; sessionPath: string }
    | { type: 'deleteSession'; sessionPath: string }
    | { type: 'setHistoryCollapsed'; collapsed: boolean }
    | { type: 'setTodoEnabled'; enabled: boolean }
    | { type: 'setTodoCollapsed'; collapsed: boolean }
    | { type: 'openSettings' };

export type LauncherServerMessage =
    | { type: 'launcherState'; state: LauncherState };

// Settings webview -> Extension messages
export type SettingsClientMessage =
    | { type: 'getSettings' }
    | { type: 'updateSetting'; key: string; value: any }
    | { type: 'setApiKey'; provider: string; key: string }
    | { type: 'clearApiKey'; provider: string }
    | { type: 'getSkills' }
    | { type: 'oauthLogin'; providerId: string }
    | { type: 'oauthLogout'; providerId: string }
    | { type: 'oauthCancel'; providerId: string }
    | { type: 'oauthSubmitCode'; providerId: string; code: string };

// Extension -> Webview messages
export type ServerMessage =
    | { type: 'ready' }
    | { type: 'stateSync'; state: SerializedAgentState }
    | { type: 'agentEvent'; event: any }
    | { type: 'models'; models: ModelInfo[]; current?: ModelInfo; thinkingLevel?: string }
    | { type: 'modelChanged'; model: ModelInfo; thinkingLevel?: string }
    | { type: 'sessions'; sessions: SessionInfo[]; currentSessionId?: string }
    | { type: 'sessionChanged'; sessionId: string }
    | { type: 'fileChange'; change: FileChangeInfo }
    | { type: 'confirmResult'; action: string; confirmed: boolean; payload?: any }
    | { type: 'toolCallPending'; pending: ToolCallPendingInfo }
    | { type: 'toolCallResolved'; toolCallId: string }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'workspaceFileSuggestions'; requestId: number; query: string; isIndexing?: boolean; items: WorkspaceFileSuggestion[] }
    | { type: 'codexUsage'; usage: CodexUsageSnapshot | null }
    | { type: 'error'; message: string };

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'settingChanged'; key: string; value: any }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'oauthState'; providerId: string; state: OAuthFlowState }
    | { type: 'error'; message: string };
