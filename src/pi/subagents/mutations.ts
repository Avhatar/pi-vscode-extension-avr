export interface SubagentMutationEvent {
    type: 'tool_execution_start' | 'tool_execution_end';
    agentId: string;
    toolCallId: string;
    toolName: string;
    args?: unknown;
    isError?: boolean;
    isolationPath?: string;
}

export interface SubagentMutationSink {
    handleExternalToolEvent(event: SubagentMutationEvent): void;
}

/** Route shared-workspace child mutations into the parent's Diff/Checkpoint
 * pipeline. Worktree mutations stay isolated and are reviewed as a patch. */
export function routeSubagentMutation(
    event: SubagentMutationEvent,
    sink: SubagentMutationSink,
): 'shared-workspace' | 'worktree' {
    if (event.isolationPath) return 'worktree';
    sink.handleExternalToolEvent(event);
    return 'shared-workspace';
}
