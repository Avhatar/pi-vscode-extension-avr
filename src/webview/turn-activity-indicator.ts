import type { PendingToolInfo } from '../shared/agent-protocol';

export interface TurnActivityIndicatorState {
    isStreaming: boolean;
    isCompacting: boolean;
    isThinking: boolean;
    isWritingText: boolean;
    hasStreamingText: boolean;
    pendingToolCount: number;
    pendingSubagentCount: number;
}

/** Count only parent tool calls that wait for a foreground child execution. */
export function countForegroundSubagentTools(pendingTools: readonly PendingToolInfo[]): number {
    return pendingTools.filter((tool) => {
        if (tool.toolName.toLowerCase() !== 'subagent') return false;
        const args = tool.args && typeof tool.args === 'object'
            ? tool.args as Record<string, unknown>
            : {};
        const action = typeof args.action === 'string' ? args.action : 'spawn';
        if (action === 'resume') return true;
        return action === 'spawn' && args.background !== true;
    }).length;
}

/** Describe the single aggregate activity that should terminate the live parent timeline. */
export function getTurnActivityIndicatorLabel(state: TurnActivityIndicatorState): string | undefined {
    if (state.isCompacting) return 'Compacting...';
    const hasVisibleTextActivity = state.isWritingText && state.hasStreamingText;
    if (!state.isStreaming || state.isThinking || hasVisibleTextActivity) return undefined;
    if (
        state.pendingSubagentCount > 0
        && state.pendingSubagentCount === state.pendingToolCount
    ) {
        const noun = state.pendingSubagentCount === 1 ? 'subagent' : 'subagents';
        return `Waiting for ${state.pendingSubagentCount} ${noun}...`;
    }
    return state.pendingToolCount === 0 ? 'Preparing next moves...' : undefined;
}

/** Decide whether the fallback activity indicator should represent an active turn. */
export function shouldShowTurnActivityIndicator(state: TurnActivityIndicatorState): boolean {
    return getTurnActivityIndicatorLabel(state) !== undefined;
}
