import type { AvailableModel, ResolvedAgentSpec, SubagentRun } from './types';

export interface SubagentArtifact {
    path: string;
    description?: string;
}

export interface SubagentCompletion {
    result: string;
    summary?: string;
    artifacts?: SubagentArtifact[];
}

export type ChildSessionEvent =
    | { type: 'turn-ended'; assistantText?: string; hasToolCalls?: boolean }
    | { type: 'tool-started'; toolName: string; toolCallId: string; args?: unknown }
    | { type: 'tool-ended'; toolName: string; toolCallId: string; isError: boolean; args?: unknown }
    | { type: 'retrying'; attempt: number; delayMs: number; error?: string }
    | { type: 'permission-wait'; toolName: string }
    | { type: 'completion'; completion: SubagentCompletion };

export interface ChildSessionHandle {
    readonly sessionId: string;
    readonly model: AvailableModel;
    readonly transcriptPath?: string;
    readonly isolationPath?: string;
    subscribe(listener: (event: ChildSessionEvent) => void): () => void;
    prompt(text: string): Promise<void>;
    steer(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    getCompletion(): SubagentCompletion | undefined;
    getLastAssistantText(): string | undefined;
}

export interface ChildSessionFactory {
    create(spec: ResolvedAgentSpec, context: {
        agentId: string;
        signal: AbortSignal;
    }): Promise<ChildSessionHandle>;
    resume?(spec: ResolvedAgentSpec, transcriptPath: string, context: {
        agentId: string;
        signal: AbortSignal;
    }): Promise<ChildSessionHandle>;
}

export interface SubagentForegroundResult extends SubagentCompletion {
    agentId: string;
    model: AvailableModel;
    turnCount: number;
    truncated: boolean;
    background?: false;
}

export interface SubagentBackgroundResult {
    agentId: string;
    model: AvailableModel;
    background: true;
}

export type SubagentExecutionResult = SubagentForegroundResult | SubagentBackgroundResult;

export interface SubagentManagerSnapshot {
    runs: SubagentRun[];
    activeCount: number;
    queuedCount: number;
}

export type SubagentTerminationReason =
    | 'cancelled'
    | 'timeout'
    | 'max-turns'
    | 'incomplete'
    | 'runtime-error';

export class SubagentRunError extends Error {
    constructor(
        readonly reason: SubagentTerminationReason,
        message: string,
        readonly agentId: string,
        readonly partialResult?: string,
    ) {
        super(message);
        this.name = 'SubagentRunError';
    }
}
