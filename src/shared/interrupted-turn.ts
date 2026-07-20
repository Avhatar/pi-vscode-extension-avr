export const TURN_LIFECYCLE_CUSTOM_TYPE = 'pi-code.turn-lifecycle';

const CONVERSATION_ROLES = new Set(['user', 'assistant', 'toolResult', 'tool']);
const TOOL_CALL_TYPES = new Set(['toolCall', 'tool_call', 'tool_use']);
const TERMINAL_TOOL_CALL_STOP_REASONS = new Set(['aborted', 'error']);

export type TurnLifecycleStatus = 'started' | 'completed';

/**
 * Detects a persisted conversation tail that cannot be complete without
 * another assistant continuation. This is used after process/session restore;
 * it never implies that replaying a side-effecting tool is safe.
 */
export function hasIncompleteTurnTail(messages: readonly unknown[]): boolean {
    let last: unknown;
    for (let index = messages.length - 1; index >= 0; index--) {
        const candidate = messages[index];
        const role = getRole(candidate);
        if (role !== undefined && CONVERSATION_ROLES.has(role)) {
            last = candidate;
            break;
        }
    }
    if (!last || typeof last !== 'object') return false;

    const role = getRole(last);
    if (role === 'user') return true;
    // A tool result usually requires another assistant step, but Pi tools may
    // terminate a turn intentionally and that flag is not persisted. Durable
    // lifecycle markers disambiguate new sessions; legacy tool tails do not.
    if (role === 'toolResult' || role === 'tool') return false;
    if (role !== 'assistant') return false;

    const message = last as Record<string, unknown>;
    const stopReason = message.stopReason ?? message.stop_reason;
    if (typeof stopReason === 'string' && TERMINAL_TOOL_CALL_STOP_REASONS.has(stopReason)) return false;
    if (hasItems(message.toolCalls) || hasItems(message.tool_calls)) return true;
    return Array.isArray(message.content)
        && message.content.some((part) => {
            if (!part || typeof part !== 'object') return false;
            const type = (part as Record<string, unknown>).type;
            return typeof type === 'string' && TOOL_CALL_TYPES.has(type);
        });
}

export function getLatestTurnLifecycleStatus(
    entries: readonly unknown[],
): TurnLifecycleStatus | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Record<string, unknown>;
        if (candidate.type !== 'custom' || candidate.customType !== TURN_LIFECYCLE_CUSTOM_TYPE) continue;
        const data = candidate.data;
        if (!data || typeof data !== 'object') return undefined;
        const status = (data as Record<string, unknown>).status;
        return status === 'started' || status === 'completed' ? status : undefined;
    }
    return undefined;
}

export function hasInterruptedTurnLifecycle(entries: readonly unknown[]): boolean {
    return getLatestTurnLifecycleStatus(entries) === 'started';
}

function getRole(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') return undefined;
    const role = (message as Record<string, unknown>).role;
    return typeof role === 'string' ? role : undefined;
}

function hasItems(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0;
}
