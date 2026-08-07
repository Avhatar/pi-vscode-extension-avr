import type { AgentTabControls } from './agent-control-protocol';

export type {
    AgentTabControls,
    LauncherSubagentRun,
    LauncherSubagentSnapshot,
    LauncherSubagentStatus,
    RegisteredToolInfo,
    TaskInfo,
    TaskStatus,
    TodoSnapshot,
    ToolSelectionSnapshot,
} from './agent-control-protocol';

export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    estimated?: boolean;
}

export interface CodexUsageWindow {
    /** Percentage already used in this window (0-100). */
    percentUsed: number;
    /** Rolling-window duration in minutes, when reported by Codex. */
    windowMinutes?: number;
    /** Unix epoch seconds when the window resets, when reported by Codex. */
    resetAt?: number;
}

export interface CodexUsageCredits {
    balance?: string;
    hasCredits: boolean;
    unlimited: boolean;
}

export interface CodexUsageBucket {
    /** Stable metered-feature id (for example "codex" or "codex_other"). */
    limitId: string;
    /** Optional human/model-facing name reported by Codex. */
    limitName?: string;
    primary?: CodexUsageWindow;
    secondary?: CodexUsageWindow;
}

export interface CodexSpendControlLimit {
    limit: string;
    used: string;
    remainingPercent: number;
    resetAt: number;
}

export interface CodexUsageSnapshot {
    /** Subscription plan label reported by Codex (for example "plus" or "prolite"). */
    planType?: string;
    /** Active metered-feature id reported on a provider response. */
    activeLimit?: string;
    /** Default and model/feature-specific rate-limit buckets. */
    buckets: CodexUsageBucket[];
    credits?: CodexUsageCredits;
    individualLimit?: CodexSpendControlLimit;
    rateLimitReachedType?: string;
    resetCreditsAvailable?: number;
    /** Unix epoch milliseconds when this state was captured. */
    capturedAt: number;
}

export interface CodexTurnWindowDelta {
    windowMinutes?: number;
    /** Window usage at the start of the turn from a matching fresh snapshot. */
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

export interface DeepSeekBalanceInfo {
    currency: string;
    totalBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
}

export interface DeepSeekUsageSnapshot {
    isAvailable: boolean;
    balanceInfos: DeepSeekBalanceInfo[];
    /** Locally accounted DeepSeek spend in Pi Code for the current calendar day. */
    todayCost: number;
    /** Local calendar date in YYYY-MM-DD form. */
    todayDate: string;
    /** Unix epoch milliseconds when the account balance was captured. */
    capturedAt: number;
}

export interface DeepSeekTurnUsage {
    turnCost: number;
    sessionCost: number;
    /** Unix epoch milliseconds when the turn accounting was captured. */
    capturedAt: number;
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
    /** Non-empty only for shared-workspace subagent edits; absent for parent-originated changes. */
    subagentAgentId?: string;
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

export interface PendingToolInfo {
    toolCallId: string;
    toolName: string;
    startTime: number;
    args?: unknown;
}

export interface TranscriptItem {
    /** Stable within one session branch and suitable for client-side page merging. */
    id: string;
    /** SDK session-entry id used as the backwards pagination cursor. */
    entryId: string;
    message: any;
}

export interface TranscriptPage {
    sessionId: string;
    items: TranscriptItem[];
    /** Entry id of the first item in this page. */
    beforeCursor?: string;
    hasMoreBefore: boolean;
    /** Full-branch user turn count used by checkpoint/file-change ordinals. */
    totalUserMessages: number;
    /** The requested cursor left the active branch; replace instead of prepend. */
    reset?: boolean;
}

export interface SerializedAgentState {
    /** Compact model context. The chat UI renders `transcript` when present. */
    messages: any[];
    model?: { provider: string; id: string; name?: string; supportsImages?: boolean };
    thinkingLevel?: string;
    isStreaming: boolean;
    isCompacting?: boolean;
    streamingMessage?: any;
    errorMessage?: string;
    tools: string[];
    /** In-flight tool calls needed to reconstruct transient cards after panel reattachment. */
    pendingTools?: PendingToolInfo[];
    sessionId?: string;
    sessionName?: string;
    /** Absolute path to the persisted session file (used by webview panels for restoration). */
    sessionPath?: string;
    /** Latest page of the complete current-branch transcript. */
    transcript?: TranscriptPage;
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
    /** Whether the always-visible File Undo View (changed-files bar with
     *  Undo / Redo / Review above the input) is enabled for this tab. */
    fileUndoViewEnabled?: boolean;
    /** Active-tab capabilities and preferences used by portable desktop control panels. */
    controls?: AgentTabControls;
    /** An idle persisted conversation tail still requires an assistant continuation. */
    interruptedTurn?: { reason: 'incomplete_session_tail' };
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

/** Renderer commands whose semantics belong to the shared agent application. */
export type AgentClientMessage =
    | { type: 'prompt'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
    | { type: 'steer'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
    | { type: 'followUp'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
    | { type: 'abort' }
    | { type: 'getModels' }
    | { type: 'setModel'; provider: string; modelId: string }
    | { type: 'toggleFavorite'; provider: string; modelId: string }
    | { type: 'setThinkingLevel'; level: string }
    | { type: 'newSession' }
    | { type: 'loadSession'; sessionPath: string }
    | { type: 'getSessions' }
    | { type: 'getState' }
    | { type: 'getTranscriptPage'; sessionId: string; beforeEntryId: string; limit?: number }
    | { type: 'renameTab'; name: string }
    | { type: 'undoFileChange'; filePath: string; toolCallId: string }
    | { type: 'restoreCheckpoint'; messageIndex: number }
    | { type: 'redoCheckpoint' }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'switchTab'; tabId: string }
    | { type: 'getSkills' }
    | { type: 'searchWorkspaceFiles'; query: string; requestId: number }
    | { type: 'queueMessage'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    | { type: 'cancelQueue' }
    | { type: 'setCacheMode'; mode: CacheMode }
    | { type: 'setTodoEnabled'; enabled: boolean }
    | { type: 'setSubagentsEnabled'; enabled: boolean }
    | { type: 'setPlanModeEnabled'; enabled: boolean }
    | { type: 'setFileUndoViewEnabled'; enabled: boolean }
    | { type: 'setToolDisabled'; toolName: string; disabled: boolean }
    | { type: 'setToolsBulk'; disabled: string[] };

/** Host events and snapshots whose semantics belong to the shared agent application. */
export type AgentServerMessage =
    | { type: 'stateSync'; state: SerializedAgentState }
    | { type: 'agentEvent'; event: any }
    | { type: 'models'; models: ModelInfo[]; current?: ModelInfo; thinkingLevel?: string; favorites?: string[] }
    | { type: 'modelChanged'; model: ModelInfo; thinkingLevel?: string }
    | { type: 'sessions'; sessions: SessionInfo[]; currentSessionId?: string }
    | { type: 'sessionChanged'; sessionId: string }
    | { type: 'fileChange'; change: FileChangeInfo }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'workspaceFileSuggestions'; requestId: number; query: string; isIndexing?: boolean; items: WorkspaceFileSuggestion[] }
    | { type: 'codexUsage'; usage: CodexUsageSnapshot | null }
    | { type: 'codexUsageError'; message: string }
    | { type: 'deepSeekUsage'; usage: DeepSeekUsageSnapshot | null }
    | { type: 'deepSeekUsageError'; message: string }
    | { type: 'turnCompleted'; outcome: 'completed' | 'failed' | 'stopped' | 'truncated'; durationMs?: number }
    | { type: 'error'; message: string; severity?: 'error' | 'warning' | 'info' };
