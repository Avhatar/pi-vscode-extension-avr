export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
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

export interface SerializedAgentState {
    messages: any[];
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    isStreaming: boolean;
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
}

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
}

export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
    source: string;
    disableModelInvocation: boolean;
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
    | { type: 'prompt'; text: string; images?: string[] }
    | { type: 'steer'; text: string }
    | { type: 'followUp'; text: string }
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
    | { type: 'queueMessage'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    | { type: 'cancelQueue' };

// ── Launcher (sidebar) ──
//
// The sidebar webview is a launcher: it lists currently-open chats and
// recent (closed) sessions and lets the user open a chat as an editor
// panel. It does not host the chat itself.

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

export interface LauncherState {
    tabs: LauncherTabInfo[];
    recentSessions: LauncherSessionInfo[];
}

export type LauncherClientMessage =
    | { type: 'getLauncherState' }
    | { type: 'openTab'; tabId: string }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'openSession'; sessionPath: string }
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
    | { type: 'error'; message: string };

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'settingChanged'; key: string; value: any }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'oauthState'; providerId: string; state: OAuthFlowState }
    | { type: 'error'; message: string };
