import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type {
    AgentClientMessage,
    AgentServerMessage,
    ClientMessage,
    PlatformClientMessage,
    ServerMessage,
    VsCodeClientMessage,
    VsCodeServerMessage,
} from './protocol';
import {
    AGENT_PROTOCOL_VERSION,
    type AgentEventEnvelope,
    type AgentRequestEnvelope,
    type AgentResponseEnvelope,
} from './connection-protocol';

const StrictObject = { additionalProperties: false } as const;
const NonEmptyString = Type.String({ minLength: 1 });
const CacheModeSchema = Type.Union([
    Type.Literal('short'),
    Type.Literal('long'),
    Type.Literal('auto'),
]);
const ImageAttachmentSchema = Type.Object({
    type: Type.Literal('image'),
    data: Type.String(),
    mimeType: Type.String(),
    name: Type.Optional(Type.String()),
    size: Type.Optional(Type.Number()),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
}, StrictObject);
const FileAttachmentSchema = Type.Object({
    type: Type.Literal('file'),
    data: Type.String(),
    mimeType: Type.String(),
    name: Type.String(),
    size: Type.Number(),
    binary: Type.Optional(Type.Boolean()),
}, StrictObject);

const TextCommandFields = {
    text: Type.String(),
    images: Type.Optional(Type.Array(ImageAttachmentSchema)),
    files: Type.Optional(Type.Array(FileAttachmentSchema)),
};

export const AgentClientMessageSchema = Type.Union([
    Type.Object({ type: Type.Literal('prompt'), ...TextCommandFields }, StrictObject),
    Type.Object({ type: Type.Literal('steer'), ...TextCommandFields }, StrictObject),
    Type.Object({ type: Type.Literal('followUp'), ...TextCommandFields }, StrictObject),
    Type.Object({ type: Type.Literal('abort') }, StrictObject),
    Type.Object({ type: Type.Literal('getModels') }, StrictObject),
    Type.Object({
        type: Type.Literal('setModel'),
        provider: Type.String(),
        modelId: Type.String(),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('toggleFavorite'),
        provider: Type.String(),
        modelId: Type.String(),
    }, StrictObject),
    Type.Object({ type: Type.Literal('setThinkingLevel'), level: Type.String() }, StrictObject),
    Type.Object({ type: Type.Literal('newSession') }, StrictObject),
    Type.Object({ type: Type.Literal('loadSession'), sessionPath: Type.String() }, StrictObject),
    Type.Object({ type: Type.Literal('getSessions') }, StrictObject),
    Type.Object({ type: Type.Literal('getState') }, StrictObject),
    Type.Object({ type: Type.Literal('renameTab'), name: NonEmptyString }, StrictObject),
    Type.Object({
        type: Type.Literal('undoFileChange'),
        filePath: Type.String(),
        toolCallId: Type.String(),
    }, StrictObject),
    Type.Object({ type: Type.Literal('restoreCheckpoint'), messageIndex: Type.Number() }, StrictObject),
    Type.Object({ type: Type.Literal('redoCheckpoint') }, StrictObject),
    Type.Object({ type: Type.Literal('createTab') }, StrictObject),
    Type.Object({ type: Type.Literal('closeTab'), tabId: Type.String() }, StrictObject),
    Type.Object({ type: Type.Literal('switchTab'), tabId: Type.String() }, StrictObject),
    Type.Object({ type: Type.Literal('getSkills') }, StrictObject),
    Type.Object({
        type: Type.Literal('searchWorkspaceFiles'),
        query: Type.String(),
        requestId: Type.Number(),
    }, StrictObject),
    Type.Object({ type: Type.Literal('queueMessage'), text: Type.String() }, StrictObject),
    Type.Object({
        type: Type.Literal('editQueuedMessage'),
        index: Type.Integer({ minimum: 0 }),
        text: Type.String(),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('removeQueuedMessage'),
        index: Type.Integer({ minimum: 0 }),
    }, StrictObject),
    Type.Object({ type: Type.Literal('cancelQueue') }, StrictObject),
    Type.Object({ type: Type.Literal('setCacheMode'), mode: CacheModeSchema }, StrictObject),
    Type.Object({ type: Type.Literal('setTodoEnabled'), enabled: Type.Boolean() }, StrictObject),
    Type.Object({ type: Type.Literal('setSubagentsEnabled'), enabled: Type.Boolean() }, StrictObject),
    Type.Object({ type: Type.Literal('setPlanModeEnabled'), enabled: Type.Boolean() }, StrictObject),
    Type.Object({ type: Type.Literal('setFileUndoViewEnabled'), enabled: Type.Boolean() }, StrictObject),
    Type.Object({
        type: Type.Literal('setToolDisabled'),
        toolName: NonEmptyString,
        disabled: Type.Boolean(),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('setToolsBulk'),
        disabled: Type.Array(NonEmptyString),
    }, StrictObject),
]);

export const PlatformClientMessageSchema = Type.Union([
    Type.Object({ type: Type.Literal('openFile'), filePath: Type.String() }, StrictObject),
    Type.Object({
        type: Type.Literal('confirmAction'),
        action: Type.String(),
        message: Type.String(),
        payload: Type.Optional(Type.Unknown()),
    }, StrictObject),
]);

export const VsCodeClientMessageSchema = Type.Union([
    Type.Object({
        type: Type.Literal('openDiff'),
        filePath: Type.String(),
        toolCallId: Type.String(),
    }, StrictObject),
    Type.Object({ type: Type.Literal('openSettings') }, StrictObject),
    Type.Object({ type: Type.Literal('openKeybindings') }, StrictObject),
    Type.Object({ type: Type.Literal('openChangelog') }, StrictObject),
    Type.Object({ type: Type.Literal('openRawView') }, StrictObject),
]);

export const ClientMessageSchema = Type.Union([
    AgentClientMessageSchema,
    PlatformClientMessageSchema,
    VsCodeClientMessageSchema,
]);

export const AgentRequestEnvelopeSchema = Type.Object({
    protocolVersion: Type.Literal(AGENT_PROTOCOL_VERSION),
    requestId: NonEmptyString,
    clientId: NonEmptyString,
    tabId: Type.Optional(NonEmptyString),
    type: NonEmptyString,
    payload: Type.Record(Type.String(), Type.Unknown()),
}, StrictObject);

const AgentSuccessResponseSchema = Type.Object({
    protocolVersion: Type.Literal(AGENT_PROTOCOL_VERSION),
    requestId: NonEmptyString,
    clientId: NonEmptyString,
    ok: Type.Literal(true),
    result: Type.Optional(Type.Unknown()),
}, StrictObject);
const AgentErrorResponseSchema = Type.Object({
    protocolVersion: Type.Literal(AGENT_PROTOCOL_VERSION),
    requestId: NonEmptyString,
    clientId: NonEmptyString,
    ok: Type.Literal(false),
    error: Type.Object({
        code: NonEmptyString,
        message: Type.String(),
    }, StrictObject),
}, StrictObject);

export const AgentResponseEnvelopeSchema = Type.Union([
    AgentSuccessResponseSchema,
    AgentErrorResponseSchema,
]);

const ModelInfoSchema = Type.Object({
    provider: Type.String(),
    id: Type.String(),
    name: Type.Optional(Type.String()),
    supportsImages: Type.Optional(Type.Boolean()),
}, StrictObject);
const ContextUsageInfoSchema = Type.Object({
    tokens: Type.Union([Type.Number(), Type.Null()]),
    contextWindow: Type.Number(),
    percent: Type.Union([Type.Number(), Type.Null()]),
    estimated: Type.Optional(Type.Boolean()),
}, StrictObject);
const FileChangeInfoSchema = Type.Object({
    filePath: Type.String(),
    toolCallId: Type.String(),
    toolName: Type.String(),
    isNew: Type.Boolean(),
    diff: Type.Optional(Type.String()),
    addedLines: Type.Number(),
    removedLines: Type.Number(),
    turnIndex: Type.Number(),
}, StrictObject);
const TabInfoSchema = Type.Object({
    id: Type.String(),
    name: Type.String(),
    isActive: Type.Boolean(),
    isStreaming: Type.Boolean(),
    hasNotification: Type.Boolean(),
}, StrictObject);
const PendingToolInfoSchema = Type.Object({
    toolCallId: Type.String(),
    toolName: Type.String(),
    startTime: Type.Number(),
    args: Type.Optional(Type.Unknown()),
}, StrictObject);
const TaskStatusSchema = Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
    Type.Literal('deleted'),
]);
const TaskInfoSchema = Type.Object({
    id: Type.Number(),
    subject: Type.String(),
    description: Type.Optional(Type.String()),
    activeForm: Type.Optional(Type.String()),
    status: TaskStatusSchema,
    blockedBy: Type.Optional(Type.Array(Type.Number())),
}, StrictObject);
const TodoSnapshotSchema = Type.Object({
    tasks: Type.Array(TaskInfoSchema),
    nextId: Type.Number(),
}, StrictObject);
const RegisteredToolInfoSchema = Type.Object({
    name: Type.String(),
    description: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    hasGuidelines: Type.Optional(Type.Boolean()),
}, StrictObject);
const ToolSelectionSnapshotSchema = Type.Object({
    registered: Type.Array(RegisteredToolInfoSchema),
    disabled: Type.Array(Type.String()),
    toggleDisabled: Type.Boolean(),
}, StrictObject);
const SubagentStatusSchema = Type.Union([
    Type.Literal('queued'),
    Type.Literal('starting'),
    Type.Literal('running'),
    Type.Literal('waiting_for_permission'),
    Type.Literal('retrying'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
]);
const SubagentRunSchema = Type.Object({
    agentId: Type.String(),
    name: Type.String(),
    task: Type.String(),
    taskPreview: Type.String(),
    result: Type.Optional(Type.String()),
    resultPreview: Type.Optional(Type.String()),
    status: SubagentStatusSchema,
    modelLabel: Type.Optional(Type.String()),
    currentTool: Type.Optional(Type.String()),
    activity: Type.Optional(Type.String()),
    elapsedMs: Type.Number(),
    queueWaitMs: Type.Optional(Type.Number()),
    turnCount: Type.Number(),
    error: Type.Optional(Type.String()),
    canDismiss: Type.Boolean(),
}, StrictObject);
const SubagentSnapshotSchema = Type.Object({
    enabled: Type.Boolean(),
    toggleDisabled: Type.Boolean(),
    activeCount: Type.Number(),
    queuedCount: Type.Number(),
    runs: Type.Array(SubagentRunSchema),
    smokeSimulation: Type.Optional(Type.Boolean()),
}, StrictObject);
const AgentTabControlsSchema = Type.Object({
    todos: TodoSnapshotSchema,
    todoEnabled: Type.Boolean(),
    todoToggleDisabled: Type.Boolean(),
    planModeEnabled: Type.Boolean(),
    planModeToggleDisabled: Type.Boolean(),
    subagents: SubagentSnapshotSchema,
    toolSelection: ToolSelectionSnapshotSchema,
}, StrictObject);
const SerializedAgentStateSchema = Type.Object({
    messages: Type.Array(Type.Unknown()),
    model: Type.Optional(ModelInfoSchema),
    thinkingLevel: Type.Optional(Type.String()),
    isStreaming: Type.Boolean(),
    isCompacting: Type.Optional(Type.Boolean()),
    streamingMessage: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    tools: Type.Array(Type.String()),
    pendingTools: Type.Optional(Type.Array(PendingToolInfoSchema)),
    sessionId: Type.Optional(Type.String()),
    sessionName: Type.Optional(Type.String()),
    sessionPath: Type.Optional(Type.String()),
    contextUsage: Type.Optional(ContextUsageInfoSchema),
    fileChanges: Type.Optional(Type.Array(FileChangeInfoSchema)),
    rollbackPoint: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    tabs: Type.Optional(Type.Array(TabInfoSchema)),
    activeTabId: Type.Optional(Type.String()),
    streamingText: Type.Optional(Type.String()),
    streamingThinking: Type.Optional(Type.String()),
    isThinking: Type.Optional(Type.Boolean()),
    thinkingStartTime: Type.Optional(Type.Number()),
    streamingThinkingDuration: Type.Optional(Type.Number()),
    queuedMessages: Type.Optional(Type.Array(Type.String())),
    cacheMode: Type.Optional(CacheModeSchema),
    cacheEffective: Type.Optional(Type.Union([Type.Literal('short'), Type.Literal('long')])),
    fileUndoViewEnabled: Type.Optional(Type.Boolean()),
    controls: Type.Optional(AgentTabControlsSchema),
    interruptedTurn: Type.Optional(Type.Object({
        reason: Type.Literal('incomplete_session_tail'),
    }, StrictObject)),
}, StrictObject);
const SessionInfoSchema = Type.Object({
    id: Type.String(),
    name: Type.Optional(Type.String()),
    firstMessage: Type.Optional(Type.String()),
    path: Type.String(),
    lastModified: Type.Optional(Type.Number()),
}, StrictObject);
const SkillInfoSchema = Type.Object({
    name: Type.String(),
    description: Type.String(),
    filePath: Type.String(),
    source: Type.String(),
    disableModelInvocation: Type.Boolean(),
}, StrictObject);
const WorkspaceFileSuggestionSchema = Type.Object({
    relativePath: Type.String(),
    basename: Type.String(),
    insertText: Type.String(),
}, StrictObject);
const CodexUsageWindowSchema = Type.Object({
    percentUsed: Type.Number(),
    windowMinutes: Type.Optional(Type.Number()),
    resetAt: Type.Optional(Type.Number()),
}, StrictObject);
const CodexUsageCreditsSchema = Type.Object({
    balance: Type.Optional(Type.String()),
    hasCredits: Type.Boolean(),
    unlimited: Type.Boolean(),
}, StrictObject);
const CodexUsageBucketSchema = Type.Object({
    limitId: Type.String(),
    limitName: Type.Optional(Type.String()),
    primary: Type.Optional(CodexUsageWindowSchema),
    secondary: Type.Optional(CodexUsageWindowSchema),
}, StrictObject);
const CodexSpendControlLimitSchema = Type.Object({
    limit: Type.String(),
    used: Type.String(),
    remainingPercent: Type.Number(),
    resetAt: Type.Number(),
}, StrictObject);
const CodexUsageSnapshotSchema = Type.Object({
    planType: Type.Optional(Type.String()),
    activeLimit: Type.Optional(Type.String()),
    buckets: Type.Array(CodexUsageBucketSchema),
    credits: Type.Optional(CodexUsageCreditsSchema),
    individualLimit: Type.Optional(CodexSpendControlLimitSchema),
    rateLimitReachedType: Type.Optional(Type.String()),
    resetCreditsAvailable: Type.Optional(Type.Number()),
    capturedAt: Type.Number(),
}, StrictObject);
const DeepSeekBalanceInfoSchema = Type.Object({
    currency: Type.String(),
    totalBalance: Type.Number({ minimum: 0 }),
    grantedBalance: Type.Number({ minimum: 0 }),
    toppedUpBalance: Type.Number({ minimum: 0 }),
}, StrictObject);
const DeepSeekUsageSnapshotSchema = Type.Object({
    isAvailable: Type.Boolean(),
    balanceInfos: Type.Array(DeepSeekBalanceInfoSchema),
    todayCost: Type.Number({ minimum: 0 }),
    todayDate: Type.String(),
    capturedAt: Type.Number(),
}, StrictObject);
const ErrorSeveritySchema = Type.Union([
    Type.Literal('error'),
    Type.Literal('warning'),
    Type.Literal('info'),
]);

export const AgentServerMessageSchema = Type.Union([
    Type.Object({ type: Type.Literal('stateSync'), state: SerializedAgentStateSchema }, StrictObject),
    Type.Object({ type: Type.Literal('agentEvent'), event: Type.Unknown() }, StrictObject),
    Type.Object({
        type: Type.Literal('models'),
        models: Type.Array(ModelInfoSchema),
        current: Type.Optional(ModelInfoSchema),
        thinkingLevel: Type.Optional(Type.String()),
        favorites: Type.Optional(Type.Array(Type.String())),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('modelChanged'),
        model: ModelInfoSchema,
        thinkingLevel: Type.Optional(Type.String()),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('sessions'),
        sessions: Type.Array(SessionInfoSchema),
        currentSessionId: Type.Optional(Type.String()),
    }, StrictObject),
    Type.Object({ type: Type.Literal('sessionChanged'), sessionId: Type.String() }, StrictObject),
    Type.Object({ type: Type.Literal('fileChange'), change: FileChangeInfoSchema }, StrictObject),
    Type.Object({ type: Type.Literal('skills'), skills: Type.Array(SkillInfoSchema) }, StrictObject),
    Type.Object({
        type: Type.Literal('workspaceFileSuggestions'),
        requestId: Type.Number(),
        query: Type.String(),
        isIndexing: Type.Optional(Type.Boolean()),
        items: Type.Array(WorkspaceFileSuggestionSchema),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('codexUsage'),
        usage: Type.Union([CodexUsageSnapshotSchema, Type.Null()]),
    }, StrictObject),
    Type.Object({ type: Type.Literal('codexUsageError'), message: Type.String() }, StrictObject),
    Type.Object({
        type: Type.Literal('deepSeekUsage'),
        usage: Type.Union([DeepSeekUsageSnapshotSchema, Type.Null()]),
    }, StrictObject),
    Type.Object({ type: Type.Literal('deepSeekUsageError'), message: Type.String() }, StrictObject),
    Type.Object({
        type: Type.Literal('turnCompleted'),
        outcome: Type.Union([
            Type.Literal('completed'),
            Type.Literal('failed'),
            Type.Literal('stopped'),
            Type.Literal('truncated'),
        ]),
        durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    }, StrictObject),
    Type.Object({
        type: Type.Literal('error'),
        message: Type.String(),
        severity: Type.Optional(ErrorSeveritySchema),
    }, StrictObject),
]);

export const VsCodeServerMessageSchema = Type.Union([
    Type.Object({ type: Type.Literal('ready') }, StrictObject),
    Type.Object({
        type: Type.Literal('rawModeEnabled'),
        enabled: Type.Boolean(),
    }, StrictObject),
]);

export const ServerMessageSchema = Type.Union([
    AgentServerMessageSchema,
    VsCodeServerMessageSchema,
]);

const AgentServerMessageTypeSchema = Type.Union([
    Type.Literal('stateSync'),
    Type.Literal('agentEvent'),
    Type.Literal('models'),
    Type.Literal('modelChanged'),
    Type.Literal('sessions'),
    Type.Literal('sessionChanged'),
    Type.Literal('fileChange'),
    Type.Literal('skills'),
    Type.Literal('workspaceFileSuggestions'),
    Type.Literal('codexUsage'),
    Type.Literal('codexUsageError'),
    Type.Literal('deepSeekUsage'),
    Type.Literal('deepSeekUsageError'),
    Type.Literal('turnCompleted'),
    Type.Literal('error'),
]);

const ServerMessageTypeSchema = Type.Union([
    AgentServerMessageTypeSchema,
    Type.Literal('ready'),
    Type.Literal('rawModeEnabled'),
]);

export const AgentServerEventEnvelopeSchema = Type.Object({
    protocolVersion: Type.Literal(AGENT_PROTOCOL_VERSION),
    clientId: NonEmptyString,
    epoch: NonEmptyString,
    sequence: Type.Integer({ minimum: 1 }),
    tabId: Type.Optional(NonEmptyString),
    type: AgentServerMessageTypeSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
}, StrictObject);

/** Validates event metadata before correlating the discriminator with its payload. */
export const AgentEventEnvelopeSchema = Type.Object({
    protocolVersion: Type.Literal(AGENT_PROTOCOL_VERSION),
    clientId: NonEmptyString,
    epoch: NonEmptyString,
    sequence: Type.Integer({ minimum: 1 }),
    tabId: Type.Optional(NonEmptyString),
    type: ServerMessageTypeSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
}, StrictObject);

export function isAgentClientMessage(value: unknown): value is AgentClientMessage {
    return Check(AgentClientMessageSchema, value);
}

export function isPlatformClientMessage(value: unknown): value is PlatformClientMessage {
    return Check(PlatformClientMessageSchema, value);
}

export function isVsCodeClientMessage(value: unknown): value is VsCodeClientMessage {
    return Check(VsCodeClientMessageSchema, value);
}

export function isClientMessage(value: unknown): value is ClientMessage {
    return Check(ClientMessageSchema, value);
}

export function isAgentClientRequestEnvelope(
    value: unknown,
): value is AgentRequestEnvelope<AgentClientMessage> {
    if (!Check(AgentRequestEnvelopeSchema, value)) return false;
    if (Object.prototype.hasOwnProperty.call(value.payload, 'type')) return false;
    return isAgentClientMessage({ ...value.payload, type: value.type });
}

export function isAgentRequestEnvelope(value: unknown): value is AgentRequestEnvelope {
    if (!Check(AgentRequestEnvelopeSchema, value)) return false;
    if (Object.prototype.hasOwnProperty.call(value.payload, 'type')) return false;
    return isClientMessage({ ...value.payload, type: value.type });
}

export function isAgentResponseEnvelope(value: unknown): value is AgentResponseEnvelope {
    return Check(AgentResponseEnvelopeSchema, value);
}

function hasValidInterruptedTurnState(value: AgentServerMessage | ServerMessage): boolean {
    if (value.type === 'stateSync' && value.state.interruptedTurn) {
        return !value.state.isStreaming && !value.state.isCompacting;
    }
    return true;
}

export function isAgentServerMessage(value: unknown): value is AgentServerMessage {
    return Check(AgentServerMessageSchema, value) && hasValidInterruptedTurnState(value as AgentServerMessage);
}

export function isVsCodeServerMessage(value: unknown): value is VsCodeServerMessage {
    return Check(VsCodeServerMessageSchema, value);
}

export function isServerMessage(value: unknown): value is ServerMessage {
    return Check(ServerMessageSchema, value) && hasValidInterruptedTurnState(value as ServerMessage);
}

export function isAgentServerEventEnvelope(
    value: unknown,
): value is AgentEventEnvelope<AgentServerMessage> {
    if (!Check(AgentServerEventEnvelopeSchema, value)) return false;
    if (Object.prototype.hasOwnProperty.call(value.payload, 'type')) return false;
    return isAgentServerMessage({ ...value.payload, type: value.type });
}

export function isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope {
    if (!Check(AgentEventEnvelopeSchema, value)) return false;
    if (Object.prototype.hasOwnProperty.call(value.payload, 'type')) return false;
    return isServerMessage({ ...value.payload, type: value.type });
}
