/**
 * Wall-clock accounting for tool executions.
 *
 * Durations are measured by the extension host between `tool_execution_start`
 * and `tool_execution_end`, then surfaced twice in the chat: once per finished
 * action (its own meta line) and once per turn (an aggregate breakdown under
 * the closing assistant message).
 */

/** One finished tool call, already resolved to its display name. */
export interface ToolCallDuration {
    readonly name: string;
    readonly durationMs: number;
}

/** All calls of one tool within a single turn, summed. */
export interface ToolStatEntry {
    readonly name: string;
    readonly calls: number;
    readonly durationMs: number;
}

export type SubagentStatStatus = 'active' | 'completed' | 'failed' | 'cancelled';

/**
 * One delegated run, accounted against the turn that spawned it.
 *
 * A background child outlives its spawning turn, so entries stay mutable on the
 * host: the turn keeps a reference and the numbers settle in place once the run
 * finishes. Failed and cancelled runs are reported like any other — the time
 * was spent regardless of the outcome.
 */
export interface SubagentStatEntry {
    readonly agentId: string;
    name: string;
    status: SubagentStatStatus;
    /** Wall clock from run start to settle, or to the last observation. */
    durationMs: number;
    /** Time spent waiting for a concurrency slot before the run started. */
    queueWaitMs: number;
    /** Share of `durationMs` the child spent inside its own tool calls. */
    toolDurationMs: number;
    toolCalls: number;
}

const UNKNOWN_TOOL_NAME = 'Unknown tool';
const SUBAGENT_TERMINAL_STATUSES = new Set<SubagentStatStatus>([
    'completed', 'failed', 'cancelled',
]);

/**
 * Human-readable name used to group durations.
 *
 * Every MCP call arrives through the single `mcp` tool, so the server and tool
 * arguments have to be folded into the name or the breakdown would collapse
 * all remote tools into one row.
 */
export function toolStatDisplayName(toolName: unknown, args?: unknown): string {
    const raw = typeof toolName === 'string' ? toolName.trim() : '';
    if (!raw) return UNKNOWN_TOOL_NAME;

    if (raw.toLowerCase() === 'mcp') {
        const record = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
        const server = typeof record?.server === 'string' ? record.server.trim() : '';
        const tool = typeof record?.tool === 'string' ? record.tool.trim() : '';
        if (server && tool) return `MCP ${server}.${tool}`;
        if (tool) return `MCP ${tool}`;
        if (server) return `MCP ${server}`;
        return 'MCP';
    }

    const spaced = raw.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Fold one finished call into a per-turn accumulator keyed by display name. */
export function accumulateToolStat(
    target: Map<string, ToolStatEntry>,
    sample: ToolCallDuration,
): void {
    const name = sample.name || UNKNOWN_TOOL_NAME;
    const durationMs = Number.isFinite(sample.durationMs) ? Math.max(0, sample.durationMs) : 0;
    const previous = target.get(name);
    target.set(name, previous
        ? { name, calls: previous.calls + 1, durationMs: previous.durationMs + durationMs }
        : { name, calls: 1, durationMs });
}

/** Snapshot an accumulator, slowest tool first. */
export function toolStatEntries(source: ReadonlyMap<string, ToolStatEntry>): ToolStatEntry[] {
    return [...source.values()].sort(
        (a, b) => b.durationMs - a.durationMs || a.name.localeCompare(b.name),
    );
}

/** Sum several breakdowns into one, matching rows by display name. */
export function mergeToolStats(
    ...sources: ReadonlyArray<readonly ToolStatEntry[]>
): ToolStatEntry[] {
    const merged = new Map<string, ToolStatEntry>();
    for (const source of sources) {
        for (const entry of source) {
            const previous = merged.get(entry.name);
            merged.set(entry.name, previous
                ? {
                    name: entry.name,
                    calls: previous.calls + entry.calls,
                    durationMs: previous.durationMs + entry.durationMs,
                }
                : entry);
        }
    }
    return toolStatEntries(merged);
}

/**
 * The delegation wrapper is not a unit of work: its wall clock is the child's
 * run, which the combined breakdown already represents through the child's own
 * tool rows. Counting both would double-report the same seconds.
 */
export function isDelegationToolName(toolName: unknown): boolean {
    return typeof toolName === 'string' && toolName.trim().toLowerCase() === 'subagent';
}

export function totalToolStats(
    entries: readonly ToolStatEntry[],
): { calls: number; durationMs: number } {
    let calls = 0;
    let durationMs = 0;
    for (const entry of entries) {
        calls += entry.calls;
        durationMs += entry.durationMs;
    }
    return { calls, durationMs };
}

/**
 * Render a duration as seconds, which is the unit the chat meta lines use.
 * Sub-decisecond calls are reported as a bound rather than rounded to `0.0s`.
 */
export function formatToolDurationSeconds(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    if (ms < 100) return '<0.1s';
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 1000)}s`;
}

/**
 * Collapse the manager's run lifecycle onto the three outcomes worth reporting
 * plus `active`. Queued, starting, retrying, and permission waits are all still
 * in flight as far as turn accounting is concerned.
 */
export function subagentStatStatus(status: unknown): SubagentStatStatus {
    const raw = typeof status === 'string' ? status : '';
    return SUBAGENT_TERMINAL_STATUSES.has(raw as SubagentStatStatus)
        ? raw as SubagentStatStatus
        : 'active';
}

/** Longest run first; ties broken by name so the order survives re-renders. */
export function sortSubagentStats(entries: readonly SubagentStatEntry[]): SubagentStatEntry[] {
    return [...entries].sort(
        (a, b) => b.durationMs - a.durationMs
            || a.name.localeCompare(b.name)
            || a.agentId.localeCompare(b.agentId),
    );
}

export function totalSubagentStats(entries: readonly SubagentStatEntry[]): {
    runs: number;
    durationMs: number;
    toolDurationMs: number;
    toolCalls: number;
    queueWaitMs: number;
    active: number;
    failed: number;
    cancelled: number;
} {
    let durationMs = 0;
    let toolDurationMs = 0;
    let toolCalls = 0;
    let queueWaitMs = 0;
    let active = 0;
    let failed = 0;
    let cancelled = 0;
    for (const entry of entries) {
        durationMs += entry.durationMs;
        toolDurationMs += entry.toolDurationMs;
        toolCalls += entry.toolCalls;
        queueWaitMs += entry.queueWaitMs;
        if (entry.status === 'active') active++;
        if (entry.status === 'failed') failed++;
        if (entry.status === 'cancelled') cancelled++;
    }
    return {
        runs: entries.length,
        durationMs,
        toolDurationMs,
        toolCalls,
        queueWaitMs,
        active,
        failed,
        cancelled,
    };
}

/**
 * The part of delegated wall clock that is not tool execution: provider
 * round-trips and child session startup.
 *
 * Without this the panel does not add up — a child that spends eight seconds
 * thinking and forty milliseconds running `ls` looks like it did nothing, and
 * the reader is left guessing whether some action went unrecorded.
 */
export function subagentNonToolTime(entries: readonly SubagentStatEntry[]): number {
    const total = totalSubagentStats(entries);
    return Math.max(0, total.durationMs - total.toolDurationMs);
}

/** Narrow an untrusted `_subagentStats` payload coming from serialized state. */
export function parseSubagentStatEntries(value: unknown): SubagentStatEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: SubagentStatEntry[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const agentId = typeof record.agentId === 'string' ? record.agentId : '';
        if (!agentId) continue;
        entries.push({
            agentId,
            name: typeof record.name === 'string' && record.name ? record.name : agentId,
            status: subagentStatStatus(record.status),
            durationMs: nonNegative(record.durationMs),
            queueWaitMs: nonNegative(record.queueWaitMs),
            toolDurationMs: nonNegative(record.toolDurationMs),
            toolCalls: Math.trunc(nonNegative(record.toolCalls)),
        });
    }
    return entries;
}

function nonNegative(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Narrow an untrusted `_toolStats` payload coming from serialized state. */
export function parseToolStatEntries(value: unknown): ToolStatEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: ToolStatEntry[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.name !== 'string' || !record.name) continue;
        const calls = typeof record.calls === 'number' && Number.isFinite(record.calls)
            ? Math.max(1, Math.trunc(record.calls))
            : 1;
        const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
            ? Math.max(0, record.durationMs)
            : 0;
        entries.push({ name: record.name, calls, durationMs });
    }
    return entries;
}
