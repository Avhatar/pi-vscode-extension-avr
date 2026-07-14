/**
 * Whether the SDK's current context token count contains a local estimate.
 * A completed assistant usage snapshot is exact; messages after it are
 * estimated by the SDK, as is the entire conversation before the first one.
 */
export function isContextUsageEstimated(messages: readonly any[]): boolean {
    if (messages.length === 0) return false;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (hasValidAssistantUsage(messages[index])) {
            return index < messages.length - 1;
        }
    }

    return true;
}

function hasValidAssistantUsage(message: any): boolean {
    if (message?.role !== 'assistant') return false;
    if (message.stopReason === 'aborted' || message.stopReason === 'error') return false;

    const usage = message.usage;
    if (!usage || typeof usage !== 'object') return false;

    const total = numberOrZero(usage.totalTokens)
        || numberOrZero(usage.input)
            + numberOrZero(usage.output)
            + numberOrZero(usage.cacheRead)
            + numberOrZero(usage.cacheWrite);
    return total > 0;
}

function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
