import type { ContextUsageInfo } from '../shared/agent-protocol';

export interface HigherRateContextNotice {
    /** Token count above which the model switches to its pricier tier. */
    aboveTokens: number;
    /** Warning appended to the context chip tooltip. */
    note: string;
}

/**
 * Describe the model's pricier tier once the conversation has entered it.
 *
 * A request whose total input exceeds the tier threshold is billed — or metered
 * against the plan — at that tier's rates for the whole request, so the chip
 * turns yellow before the next message is sent rather than after.
 *
 * @param formatTokens Token formatter; the webview passes the shared
 * `formatTokenCount` so the tooltip and the chip spell numbers the same way.
 * @returns the notice, or undefined while the conversation is still below the
 * threshold or the model has a single price at any context size.
 */
export function higherRateContextNotice(
    usage: ContextUsageInfo | undefined,
    formatTokens: (tokens: number) => string,
): HigherRateContextNotice | undefined {
    const aboveTokens = usage?.higherRateAboveTokens;
    if (aboveTokens === undefined || usage?.tokens == null || usage.tokens <= aboveTokens) {
        return undefined;
    }
    const threshold = formatTokens(aboveTokens);
    return {
        aboveTokens,
        note: ` This conversation is past ${threshold} tokens, the point where this model switches to its more expensive long-context tier. Compact it to go back below ${threshold}.`,
    };
}
