export type TurnCompletionOutcome = 'completed' | 'failed' | 'stopped' | 'truncated';

export interface TurnCompletionInfo {
    tabName: string;
    outcome: TurnCompletionOutcome;
    durationMs?: number;
}

/** Build the short text used by turn-completion popups. */
export function formatTurnCompletionMessage(info: TurnCompletionInfo): string {
    const name = info.tabName.trim() || 'Agent';
    const duration = info.durationMs && info.durationMs > 0
        ? ` in ${formatTurnDuration(info.durationMs)}`
        : '';
    const result = info.outcome === 'failed'
        ? 'failed'
        : info.outcome === 'stopped'
            ? 'was stopped'
            : info.outcome === 'truncated'
                ? 'finished with a truncated response'
                : 'completed';
    return `Pi Code: ${name} ${result}${duration}.`;
}

function formatTurnDuration(durationMs: number): string {
    const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
