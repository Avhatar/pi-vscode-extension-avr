import type { AgentClientMessage, AgentServerMessage, SkillInfo } from './agent-protocol';
import type { PlatformClientMessage, PlatformServerMessage } from './platform-protocol';
import type { VsCodeClientMessage, VsCodeServerMessage } from './vscode-protocol';

export type {
    AgentClientMessage,
    AgentServerMessage,
    AgentTabControls,
    CacheEffective,
    CacheMode,
    CodexSpendControlLimit,
    CodexTurnUsage,
    CodexTurnWindowDelta,
    CodexUsageBucket,
    CodexUsageCredits,
    CodexUsageSnapshot,
    CodexUsageWindow,
    ContextUsageInfo,
    FileAttachment,
    FileChangeInfo,
    ImageAttachment,
    ModelInfo,
    PendingToolInfo,
    SerializedAgentState,
    SessionInfo,
    SkillInfo,
    TabInfo,
    WorkspaceFileSuggestion,
} from './agent-protocol';
export type { PlatformClientMessage, PlatformServerMessage } from './platform-protocol';
export type { VsCodeClientMessage, VsCodeServerMessage } from './vscode-protocol';

export interface OAuthProviderInfo {
    id: string;
    name: string;
    signedIn: boolean;
    usesCallbackServer: boolean;
}

export interface SettingsData {
    apiProvider: string;
    apiKeySet: boolean;
    configuredProviders: string[];
    authMethod: 'env' | 'pi-login' | 'manual' | 'none';
    defaultModel: string;
    thinkingLevel: string;
    allowedTools: string[];
    todoPromptGuidelines: string;
    subagentsDefaultEnabled: boolean;
    subagentsDefaultModel: string;
    subagentsAllowedModels: string[];
    subagentsAllowInvocationModelOverride: boolean;
    subagentsDefaultMaxTurns: number;
    subagentsDefaultTimeoutMinutes: number;
    subagentsMaxConcurrentGlobal: number;
    subagentsMaxConcurrentPerChat: number;
    mcpImportClaudeCode: boolean;
    lspEnabled: boolean;
    userMessageGlowColor: string;
    userMessageGlowOpacity: number;
    oauthProviders: OAuthProviderInfo[];
}

export interface OAuthSelectOption {
    id: string;
    label: string;
}

export type OAuthFlowState =
    | { kind: 'idle' }
    | { kind: 'starting'; message?: string }
    | { kind: 'awaitingSelection'; message: string; options: OAuthSelectOption[] }
    | { kind: 'awaitingPrompt'; message: string; placeholder?: string; allowEmpty: boolean }
    | { kind: 'awaitingBrowser'; url: string; instructions?: string; promptForCode?: { message: string; placeholder?: string; allowEmpty?: boolean } }
    | { kind: 'awaitingDeviceCode'; userCode: string; verificationUri: string; expiresInSeconds?: number }
    | { kind: 'progress'; message: string }
    | { kind: 'success' }
    | { kind: 'error'; message: string };

// Webview -> Extension messages. Keep this compatibility union stable while
// transports migrate to the portable, platform, and VS Code partitions.
export type ClientMessage = AgentClientMessage | PlatformClientMessage | VsCodeClientMessage;

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

/** Snapshot of the tool set for a chat: everything the SDK has registered
 *  (via `pi-code.allowedTools` + built-ins + extensions) plus the per-chat
 *  denylist that the user maintains through the Tools panel. */
export interface RegisteredToolInfo {
    /** Tool identifier (e.g. `read`, `unity_scene_new`). */
    name: string;
    /** Human-readable description — same string the LLM sees in its system
     *  prompt. May be multi-line and quite long for MCP-heavy tools. */
    description?: string;
    /** Where the tool came from: `"builtin"`, `"sdk"`, or a package name
     *  (e.g. `"pi-web-access"`, `"pi-mcp-adapter"`). Useful when the user
     *  wants to know why a tool is in their set. */
    source?: string;
    /** True when the tool ships with promptGuidelines beyond just the
     *  description — those guidelines add tokens to every turn while the
     *  tool is active. Surfaced so the user can see which entries carry
     *  extra prompt weight. */
    hasGuidelines?: boolean;
}

export interface ToolSelectionSnapshot {
    /** All tools currently registered for this session, sorted by name.
     *  Includes `todo`. Each entry carries metadata for the tooltip. */
    registered: RegisteredToolInfo[];
    /** Tools currently disabled for this chat (subset of `registered.name`,
     *  but may also contain names not in `registered` — those are preserved
     *  so the disable sticks if the tool comes back later, e.g. an MCP
     *  server re-added). */
    disabled: string[];
    /** True when the active tab is streaming/compacting and the panel
     *  toggles should be greyed out. */
    toggleDisabled: boolean;
}

export type LauncherSubagentStatus =
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_for_permission'
    | 'retrying'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface LauncherSubagentRun {
    agentId: string;
    name: string;
    task: string;
    taskPreview: string;
    result?: string;
    resultPreview?: string;
    status: LauncherSubagentStatus;
    modelLabel?: string;
    currentTool?: string;
    activity?: string;
    elapsedMs: number;
    queueWaitMs?: number;
    turnCount: number;
    error?: string;
    /** The only user-facing lifecycle action; orchestration controls stay with the parent agent. */
    canDismiss: boolean;
}

export interface LauncherSubagentSnapshot {
    enabled: boolean;
    toggleDisabled: boolean;
    activeCount: number;
    queuedCount: number;
    runs: LauncherSubagentRun[];
    /** True for deterministic smoke rows rather than live child runs. */
    smokeSimulation?: boolean;
}

export interface TurnNotificationSettings {
    showPopup: boolean;
    playSound: boolean;
}

export interface LauncherState {
    tabs: LauncherTabInfo[];
    recentSessions: LauncherSessionInfo[];
    historyCollapsed: boolean;
    /** Global turn-completion effects. Both default to disabled. */
    notificationSettings: TurnNotificationSettings;
    /** Whether the Notifications panel is collapsed in the launcher. */
    notificationsCollapsed: boolean;
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
    /** Per-tab Plan Mode toggle state for the active tab. Absent when
     *  there is no active tab. When enabled, the agent first studies
     *  the task with read-only tools before executing. */
    planModeEnabled?: boolean;
    /** True when the active tab is streaming or compacting and the
     *  Plan Mode toggle should be greyed out. */
    planModeToggleDisabled?: boolean;
    /** Per-tab File Undo View toggle state for the active tab. Absent
     *  when there is no active tab. When enabled, the bar listing
     *  files the agent changed (with Undo/Redo/Review buttons) is
     *  shown above the chat input. */
    fileUndoViewEnabled?: boolean;
    /** Active tab's subagent capability and retained lifecycle rows.
     *  Absent when no chat panel is active. */
    subagents?: LauncherSubagentSnapshot;
    /** Whether the Subagents section is collapsed. This is a global UI
     *  preference and does not change per-chat capability state. */
    subagentsCollapsed: boolean;
    /** Active tab's tool selection (registered + disabled). Absent when
     *  no active tab. Drives the Tools panel in the launcher. */
    toolSelection?: ToolSelectionSnapshot;
    /** Whether the user has collapsed the Tools panel (UI-only, global
     *  like `historyCollapsed`). Persisted via globalState. */
    toolsCollapsed: boolean;
}

export type LauncherClientMessage =
    | { type: 'getLauncherState' }
    | { type: 'openTab'; tabId: string }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'openSession'; sessionPath: string }
    | { type: 'deleteSession'; sessionPath: string }
    | { type: 'setHistoryCollapsed'; collapsed: boolean }
    | { type: 'setNotificationsCollapsed'; collapsed: boolean }
    | { type: 'setNotificationShowPopup'; enabled: boolean }
    | { type: 'setNotificationPlaySound'; enabled: boolean }
    | { type: 'setTodoEnabled'; enabled: boolean }
    | { type: 'setTodoCollapsed'; collapsed: boolean }
    | { type: 'setSubagentsEnabled'; enabled: boolean }
    | { type: 'setSubagentsCollapsed'; collapsed: boolean }
    | { type: 'stopSubagent'; agentId: string }
    | { type: 'inspectSubagent'; agentId: string }
    | { type: 'resumeSubagent'; agentId: string }
    | { type: 'steerSubagent'; agentId: string }
    | { type: 'dismissSubagent'; agentId: string }
    | { type: 'reviewSubagentWorktree'; agentId: string }
    | { type: 'applySubagentWorktree'; agentId: string }
    | { type: 'cleanupSubagentWorktree'; agentId: string }
    | { type: 'dismissSubagentSmoke' }
    | { type: 'setPlanModeEnabled'; enabled: boolean }
    | { type: 'setFileUndoViewEnabled'; enabled: boolean }
    | { type: 'setToolDisabled'; toolName: string; disabled: boolean }
    | { type: 'setToolsBulk'; disabled: string[] }
    | { type: 'setToolsCollapsed'; collapsed: boolean }
    | { type: 'copyToolSelection' }
    | { type: 'pasteToolSelection' }
    | { type: 'setToolSelectionAsProjectDefault' }
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
    | { type: 'oauthSelect'; providerId: string; optionId: string }
    | { type: 'oauthSubmitInput'; providerId: string; value: string }
    | { type: 'oauthOpenUrl'; url: string };

// Extension -> Webview messages. Keep this compatibility union stable while
// transports migrate to the portable, platform, and VS Code partitions.
export type ServerMessage = AgentServerMessage | PlatformServerMessage | VsCodeServerMessage;

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'settingChanged'; key: string; value: any }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'oauthState'; providerId: string; state: OAuthFlowState }
    | { type: 'error'; message: string };
