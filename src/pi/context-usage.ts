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

/**
 * Lowest input-token threshold at which the model switches to a pricier tier.
 *
 * Cost tables express this as `tiers[].inputTokensAbove` — OpenAI's
 * long-context rate above 272K, for example. The highest matching tier prices
 * the whole request, so the point worth warning about is the lowest threshold.
 * Read from the model rather than a constant, so it follows catalog updates and
 * documented corrections.
 *
 * @returns the threshold, or undefined when the model has one price at any
 * context size.
 */
export function higherRateAboveTokens(model: unknown): number | undefined {
    const tiers = (model as { cost?: { tiers?: unknown } } | undefined)?.cost?.tiers;
    if (!Array.isArray(tiers)) return undefined;
    const thresholds = tiers
        .map((tier) => (tier as { inputTokensAbove?: unknown })?.inputTokensAbove)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    return thresholds.length > 0 ? Math.min(...thresholds) : undefined;
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
