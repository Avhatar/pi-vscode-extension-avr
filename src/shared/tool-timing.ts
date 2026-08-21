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

const UNKNOWN_TOOL_NAME = 'Unknown tool';

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
