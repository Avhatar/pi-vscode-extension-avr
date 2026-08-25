import {
    parseSubagentStatEntries,
    parseToolStatEntries,
    type SubagentStatEntry,
    type ToolStatEntry,
} from './tool-timing';

/**
 * Turn timing is written into the session file as a plain `custom` entry, not a
 * `custom_message`: only the latter becomes a context message, so these metrics
 * cost no tokens, never appear in the chat, survive an extension host restart,
 * and are destroyed together with the session they describe. A checkpoint
 * rollback truncates the branch and takes the discarded turns' metrics with it.
 */
export const TURN_METRICS_CUSTOM_TYPE = 'pi-code.turn-metrics';

/**
 * Upper bound on per-call durations stored for one turn. A turn with hundreds of
 * tool calls should not grow the session file for the sake of card footers.
 */
export const TURN_METRICS_TOOL_DURATION_LIMIT = 400;

/** One closing assistant message's turn metadata, as persisted. */
export interface PersistedTurnMetrics {
    /** `assistantMetaKey` of the assistant message the turn closes on. */
    key: string;
    thinkingDurationSec?: number;
    messageEndTime?: number;
    turnDurationMs?: number;
    totalTurnDurationMs?: number;
    modelWaitMs?: number;
    compactionMs?: number;
    toolStats?: ToolStatEntry[];
    childToolStats?: ToolStatEntry[];
    combinedToolStats?: ToolStatEntry[];
    subagentStats?: SubagentStatEntry[];
    /** Wall-clock duration per tool call id, for the individual action footers. */
    toolDurations?: Record<string, number>;
}

/**
 * Replay persisted metrics from a session branch, newest write winning per key.
 *
 * A turn is re-written when a background child settles after it closed, so the
 * same key legitimately appears more than once and the last entry is the
 * authoritative one.
 */
export function collectPersistedTurnMetrics(
    entries: readonly unknown[],
): PersistedTurnMetrics[] {
    const byKey = new Map<string, PersistedTurnMetrics>();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Record<string, unknown>;
        if (candidate.type !== 'custom') continue;
        if (candidate.customType !== TURN_METRICS_CUSTOM_TYPE) continue;
        const parsed = parsePersistedTurnMetrics(candidate.data);
        if (parsed) byKey.set(parsed.key, parsed);
    }
    return [...byKey.values()];
}

/** Narrow one untrusted payload read back from the session file. */
export function parsePersistedTurnMetrics(value: unknown): PersistedTurnMetrics | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.key !== 'string' || !record.key) return undefined;

    const metrics: PersistedTurnMetrics = { key: record.key };
    assignNumber(metrics, 'thinkingDurationSec', record.thinkingDurationSec);
    assignNumber(metrics, 'messageEndTime', record.messageEndTime);
    assignNumber(metrics, 'turnDurationMs', record.turnDurationMs);
    assignNumber(metrics, 'totalTurnDurationMs', record.totalTurnDurationMs);
    assignNumber(metrics, 'modelWaitMs', record.modelWaitMs);
    assignNumber(metrics, 'compactionMs', record.compactionMs);

    const toolStats = parseToolStatEntries(record.toolStats);
    if (toolStats.length > 0) metrics.toolStats = toolStats;
    const childToolStats = parseToolStatEntries(record.childToolStats);
    if (childToolStats.length > 0) metrics.childToolStats = childToolStats;
    const combinedToolStats = parseToolStatEntries(record.combinedToolStats);
    if (combinedToolStats.length > 0) metrics.combinedToolStats = combinedToolStats;
    const subagentStats = parseSubagentStatEntries(record.subagentStats);
    if (subagentStats.length > 0) metrics.subagentStats = subagentStats;

    const toolDurations = parseToolDurations(record.toolDurations);
    if (toolDurations) metrics.toolDurations = toolDurations;
    return metrics;
}

function parseToolDurations(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const parsed: Record<string, number> = {};
    let count = 0;
    for (const [toolCallId, durationMs] of Object.entries(value as Record<string, unknown>)) {
        if (!toolCallId) continue;
        // Corrupt rows are dropped rather than clamped: a bogus call id pinned
        // at zero is noise that also spends the cap a real call could use.
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) continue;
        if (durationMs < 0) continue;
        parsed[toolCallId] = durationMs;
        if (++count >= TURN_METRICS_TOOL_DURATION_LIMIT) break;
    }
    return count > 0 ? parsed : undefined;
}

function assignNumber(
    target: PersistedTurnMetrics,
    field: 'thinkingDurationSec' | 'messageEndTime' | 'turnDurationMs'
        | 'totalTurnDurationMs' | 'modelWaitMs' | 'compactionMs',
    value: unknown,
): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    target[field] = value;
}
