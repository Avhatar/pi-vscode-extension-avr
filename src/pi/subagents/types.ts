export interface ModelRef {
    provider: string;
    id: string;
}

export interface AvailableModel extends ModelRef {
    name?: string;
}

export type AgentDefinitionSource =
    | 'runtime'
    | 'project'
    | 'user'
    | 'package'
    | 'claude-compat';

export interface AgentDefinition {
    name: string;
    description: string;
    instructions?: string;

    model?: ModelRef | 'inherit';
    thinkingLevel?: string | 'inherit';

    tools?: string[];
    disallowedTools?: string[];
    skills?: string[];
    mcpServers?: string[];

    maxTurns?: number;
    timeoutMinutes?: number;
    background?: boolean;
    contextMode?: 'fresh' | 'fork';
    isolation?: 'shared-workspace' | 'worktree';

    source: AgentDefinitionSource;
    /** Original scope/provenance for adapted definitions that share one source kind. */
    scope?: 'user' | 'project' | 'package';
    packageName?: string;
    filePath?: string;
}

export type AgentDiagnosticSeverity = 'info' | 'warning' | 'error';

export type AgentDiagnosticCode =
    | 'read-error'
    | 'frontmatter-error'
    | 'invalid-definition'
    | 'duplicate-name'
    | 'shadowed-definition'
    | 'untrusted-project'
    | 'unsafe-path'
    | 'compatibility-normalized'
    | 'unsupported-capability'
    | 'invalid-package-manifest';

export interface AgentDefinitionDiagnostic {
    code: AgentDiagnosticCode;
    severity: AgentDiagnosticSeverity;
    message: string;
    filePath?: string;
    agentName?: string;
    source?: AgentDefinitionSource;
}

export interface AgentRegistrySnapshot {
    definitions: AgentDefinition[];
    diagnostics: AgentDefinitionDiagnostic[];
}

export interface SubagentInvocation {
    task: string;
    agent?: string;
    /** Transient display name for ad-hoc spawns. Named definitions override this. */
    name?: string;
    instructions?: string;
    /** Exact provider/id, {provider,id}, or "inherit" to use the parent model. */
    model?: ModelRef | string;
    thinkingLevel?: string;
    tools?: string[];
    disallowedTools?: string[];
    maxTurns?: number;
    timeoutMinutes?: number;
    contextMode?: 'fresh' | 'fork';
    isolation?: 'shared-workspace' | 'worktree';
    background?: boolean;
}

export interface SubagentResolutionPolicy {
    availableModels: readonly AvailableModel[];
    parentModel: ModelRef;
    parentThinkingLevel?: string;
    defaultModel?: ModelRef | string;
    defaultThinkingLevel?: string;
    allowedModels?: readonly (ModelRef | string)[];
    allowInvocationModelOverride?: boolean;
    forcedModelsByAgent?: Readonly<Record<string, ModelRef | string>>;

    registeredTools: readonly string[];
    activeTools: readonly string[];
    childSafeTools: readonly string[];
    globallyDisallowedTools?: readonly string[];
    nonChildSafeTools?: readonly string[];

    defaultMaxTurns?: number;
    maxTurns?: number;
    defaultTimeoutMinutes?: number;
    maxTimeoutMinutes?: number;
    defaultContextMode?: 'fresh' | 'fork';
    defaultIsolation?: 'shared-workspace' | 'worktree';
}

export type ModelResolutionSource =
    | 'forced-setting'
    | 'invocation'
    | 'definition'
    | 'default-setting'
    | 'parent';

export interface ResolutionDiagnostic {
    code: 'default-model-skipped' | 'tool-unavailable' | 'limit-clamped';
    message: string;
}

export interface ToolResolutionTrace {
    registered: string[];
    active: string[];
    childSafe: string[];
    definitionAllowlist?: string[];
    invocationAllowlist?: string[];
    denied: string[];
    effective: string[];
}

export type SubagentRunStatus =
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_for_permission'
    | 'retrying'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface SubagentRun {
    agentId: string;
    parentSessionId: string;
    parentTabId: string;
    name: string;
    source: AgentDefinitionSource | 'invocation';
    /** Full bounded delegation task for user-visible orchestration history. */
    task?: string;
    taskPreview: string;
    status: SubagentRunStatus;
    model?: AvailableModel;
    currentTool?: string;
    activity?: string;
    queuedAt?: number;
    queueWaitMs?: number;
    startedAt?: number;
    finishedAt?: number;
    turnCount: number;
    error?: string;
    /** Full bounded child result for user-visible orchestration history. */
    result?: string;
    resultPreview?: string;
    transcriptPath?: string;
    isolationPath?: string;
}

export type SubagentActivityEvent =
    | { type: 'run-started'; agentId: string; model: ModelRef }
    | { type: 'tool-started'; agentId: string; toolName: string; description?: string }
    | { type: 'tool-ended'; agentId: string; toolName: string; isError: boolean }
    | { type: 'retrying'; agentId: string; attempt: number; delayMs: number }
    | { type: 'permission-wait'; agentId: string; toolName: string }
    | { type: 'completed'; agentId: string; resultPreview: string }
    | { type: 'failed'; agentId: string; error: string }
    | { type: 'cancelled'; agentId: string };

export interface ResolvedAgentSpec {
    name: string;
    description?: string;
    source: AgentDefinitionSource | 'invocation';
    filePath?: string;
    task: string;
    instructions?: string;

    model: AvailableModel;
    modelSource: ModelResolutionSource;
    thinkingLevel?: string;
    tools: string[];
    toolTrace: ToolResolutionTrace;

    maxTurns: number;
    timeoutMinutes: number;
    background: boolean;
    contextMode: 'fresh' | 'fork';
    isolation: 'shared-workspace' | 'worktree';
    diagnostics: ResolutionDiagnostic[];
}
