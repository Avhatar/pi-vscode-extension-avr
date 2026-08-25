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
    dispose(): void | Promise<void>;
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
        /** Worktree the run recorded, to be reattached rather than recreated. */
        isolationPath?: string;
    }): Promise<ChildSessionHandle>;
}

export interface SubagentForegroundResult extends SubagentCompletion {
    agentId: string;
    model: AvailableModel;
    turnCount: number;
    truncated: boolean;
    /** Preserved worktree holding the child's edits, when it ran isolated. */
    isolationPath?: string;
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

/** Upper bound for the salvaged tail appended to a failure message. Large
 *  enough to carry a real partial answer, small enough that a stranded child
 *  cannot flood the parent context with a failed run's transcript. */
export const PARTIAL_RESULT_LIMIT = 8_000;

/**
 * Keeps a stranded child's work reachable by the parent.
 *
 * A run that hits its turn budget or timeout is a real failure, so the status
 * stays `failed` — but the child's last message is often most of the delegated
 * answer. Reporting the bare reason forces the parent to re-spawn the whole
 * task from scratch, which is the expensive part of a failure. Appending the
 * salvage lets the parent finish the work, or at least resume from where the
 * child stopped, without paying for the run twice.
 *
 * Returns the failure message unchanged when there is nothing to salvage, so
 * callers can tell the two cases apart by identity.
 */
export function describeSubagentFailure(error: SubagentRunError): string {
    const partial = error.partialResult?.trim();
    if (!partial) return error.message;
    const bounded = partial.length > PARTIAL_RESULT_LIMIT
        ? `${partial.slice(0, PARTIAL_RESULT_LIMIT)}\n… salvaged output truncated …`
        : partial;
    return `${error.message}\n\n`
        + 'The child produced this before it stopped. It is unverified and may be incomplete, '
        + 'but it is real work — use it instead of re-running the same task from scratch:\n'
        + bounded;
}

/**
 * Appends the parent-facing handle to a finished child's result.
 *
 * Every lifecycle action keys off `agentId`, and a worktree child's edits exist
 * only inside its preserved worktree — yet both facts used to live exclusively
 * in the tool call's `details`, which the model never reads. A parent that
 * cannot see the id has no legal way to review the work it just delegated, and
 * one that cannot see the worktree does not even know the changes are absent
 * from the workspace. The observed failure mode is a parent that starts
 * locating worktrees by hand and dispatching writers into a sibling's isolated
 * checkout. Naming both in the result text is what closes that gap.
 *
 * Kept deliberately short: this trailer is paid for on every foreground spawn.
 */
export function describeSubagentResult(result: SubagentForegroundResult): string {
    const lines = [
        '---',
        `Subagent handle: agentId=${result.agentId} `
        + `model=${result.model.provider}/${result.model.id} turns=${result.turnCount}`,
    ];
    if (result.isolationPath) {
        lines.push(
            `Preserved worktree: ${result.isolationPath}`,
            'The child edited that isolated checkout, so none of its changes are in the workspace yet. '
            + 'Call this tool with action="review" and this agentId to read the patch, action="apply" to '
            + 'accept it, then action="cleanup" when you are done. Never edit another agent\'s worktree '
            + 'directly and never send a shared-workspace child into one.',
        );
    } else {
        lines.push('Use this agentId for inspect, resume, send, or dismiss.');
    }
    return `${result.result}\n\n${lines.join('\n')}`;
}
