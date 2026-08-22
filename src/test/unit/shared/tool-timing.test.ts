import { describe, expect, it } from 'vitest';
import {
    accumulateToolStat,
    formatToolDurationSeconds,
    isDelegationToolName,
    mergeToolStats,
    parseSubagentStatEntries,
    parseToolStatEntries,
    sortSubagentStats,
    subagentNonToolTime,
    subagentStatStatus,
    toolStatDisplayName,
    toolStatEntries,
    totalSubagentStats,
    totalToolStats,
    type SubagentStatEntry,
    type ToolStatEntry,
} from '../../../shared/tool-timing';

function subagentStat(overrides: Partial<SubagentStatEntry> = {}): SubagentStatEntry {
    return {
        agentId: 'a1',
        name: 'Explorer',
        status: 'completed',
        durationMs: 1000,
        queueWaitMs: 0,
        toolDurationMs: 400,
        toolCalls: 2,
        ...overrides,
    };
}

describe('tool timing display names', () => {
    it('title-cases plain tool names and spaces out identifier underscores', () => {
        expect(toolStatDisplayName('grep')).toBe('Grep');
        expect(toolStatDisplayName('read')).toBe('Read');
        expect(toolStatDisplayName('web_search')).toBe('Web search');
        expect(toolStatDisplayName('find_references')).toBe('Find references');
    });

    it('keeps MCP calls separated by server and remote tool', () => {
        expect(toolStatDisplayName('mcp', { server: 'unity', tool: 'read_log' }))
            .toBe('MCP unity.read_log');
        expect(toolStatDisplayName('MCP', { tool: 'read_log' })).toBe('MCP read_log');
        expect(toolStatDisplayName('mcp', { server: 'unity' })).toBe('MCP unity');
        expect(toolStatDisplayName('mcp', { action: 'search' })).toBe('MCP');
        expect(toolStatDisplayName('mcp', 'not-an-object')).toBe('MCP');
    });

    it('falls back to a stable label for a missing name', () => {
        expect(toolStatDisplayName('')).toBe('Unknown tool');
        expect(toolStatDisplayName(undefined)).toBe('Unknown tool');
        expect(toolStatDisplayName(42)).toBe('Unknown tool');
    });
});

describe('tool timing aggregation', () => {
    it('sums repeated calls per display name and orders the slowest first', () => {
        const target = new Map<string, ToolStatEntry>();
        accumulateToolStat(target, { name: 'Grep', durationMs: 300_000 });
        accumulateToolStat(target, { name: 'MCP unity.read_log', durationMs: 30_000 });
        accumulateToolStat(target, { name: 'Grep', durationMs: 152_000 });
        accumulateToolStat(target, { name: 'Read', durationMs: 601_000 });

        expect(toolStatEntries(target)).toEqual([
            { name: 'Read', calls: 1, durationMs: 601_000 },
            { name: 'Grep', calls: 2, durationMs: 452_000 },
            { name: 'MCP unity.read_log', calls: 1, durationMs: 30_000 },
        ]);
        expect(totalToolStats(toolStatEntries(target)))
            .toEqual({ calls: 4, durationMs: 1_083_000 });
    });

    it('breaks duration ties by name so the order stays stable across renders', () => {
        const target = new Map<string, ToolStatEntry>();
        accumulateToolStat(target, { name: 'Write', durationMs: 1000 });
        accumulateToolStat(target, { name: 'Edit', durationMs: 1000 });

        expect(toolStatEntries(target).map((entry) => entry.name)).toEqual(['Edit', 'Write']);
    });

    it('clamps unusable durations to zero instead of poisoning the total', () => {
        const target = new Map<string, ToolStatEntry>();
        accumulateToolStat(target, { name: 'Grep', durationMs: Number.NaN });
        accumulateToolStat(target, { name: 'Grep', durationMs: -5 });

        expect(toolStatEntries(target)).toEqual([{ name: 'Grep', calls: 2, durationMs: 0 }]);
    });
});

describe('tool breakdown merging', () => {
    it('sums matching rows across breakdowns and re-sorts the result', () => {
        expect(mergeToolStats(
            [{ name: 'Grep', calls: 1, durationMs: 2000 }],
            [
                { name: 'Grep', calls: 2, durationMs: 17_000 },
                { name: 'Read', calls: 1, durationMs: 500 },
            ],
        )).toEqual([
            { name: 'Grep', calls: 3, durationMs: 19_000 },
            { name: 'Read', calls: 1, durationMs: 500 },
        ]);
    });

    it('passes a single breakdown through and tolerates empty ones', () => {
        const only = [{ name: 'Grep', calls: 1, durationMs: 2000 }];
        expect(mergeToolStats(only, [])).toEqual(only);
        expect(mergeToolStats()).toEqual([]);
        expect(mergeToolStats([], [])).toEqual([]);
    });

    it('recognises only the delegation wrapper as delegation', () => {
        expect(isDelegationToolName('subagent')).toBe(true);
        expect(isDelegationToolName(' Subagent ')).toBe(true);
        for (const name of ['grep', 'read', 'mcp', 'subagents', '', undefined, 42]) {
            expect(isDelegationToolName(name)).toBe(false);
        }
    });
});

describe('tool duration formatting', () => {
    it('reports seconds, with one decimal below ten seconds', () => {
        expect(formatToolDurationSeconds(2400)).toBe('2.4s');
        expect(formatToolDurationSeconds(9999)).toBe('10.0s');
        expect(formatToolDurationSeconds(30_000)).toBe('30s');
        expect(formatToolDurationSeconds(452_400)).toBe('452s');
    });

    it('bounds sub-decisecond calls rather than rounding them away', () => {
        expect(formatToolDurationSeconds(40)).toBe('<0.1s');
        expect(formatToolDurationSeconds(100)).toBe('0.1s');
    });

    it('renders nothing measurable as a plain zero', () => {
        expect(formatToolDurationSeconds(0)).toBe('0s');
        expect(formatToolDurationSeconds(-1)).toBe('0s');
        expect(formatToolDurationSeconds(Number.NaN)).toBe('0s');
    });
});

describe('delegated run statistics', () => {
    it('treats every non-terminal run lifecycle state as still active', () => {
        expect(subagentStatStatus('completed')).toBe('completed');
        expect(subagentStatStatus('failed')).toBe('failed');
        expect(subagentStatStatus('cancelled')).toBe('cancelled');
        for (const status of [
            'queued', 'starting', 'running', 'waiting_for_permission', 'retrying', '', undefined,
        ]) {
            expect(subagentStatStatus(status)).toBe('active');
        }
    });

    it('orders the longest run first without mutating the input', () => {
        const entries = [
            subagentStat({ agentId: 'a1', name: 'Explorer', durationMs: 1000 }),
            subagentStat({ agentId: 'a2', name: 'Implementer', durationMs: 9000 }),
            subagentStat({ agentId: 'a3', name: 'Auditor', durationMs: 9000 }),
        ];

        expect(sortSubagentStats(entries).map((entry) => entry.agentId))
            .toEqual(['a3', 'a2', 'a1']);
        expect(entries.map((entry) => entry.agentId)).toEqual(['a1', 'a2', 'a3']);
    });

    it('counts failed, cancelled, and still-running work alongside the totals', () => {
        const total = totalSubagentStats([
            subagentStat({ agentId: 'a1', durationMs: 1000, toolDurationMs: 400, toolCalls: 2 }),
            subagentStat({ agentId: 'a2', status: 'failed', durationMs: 3000, toolDurationMs: 100, toolCalls: 1 }),
            subagentStat({ agentId: 'a3', status: 'cancelled', durationMs: 500, toolDurationMs: 0, toolCalls: 0 }),
            subagentStat({ agentId: 'a4', status: 'active', durationMs: 200, toolDurationMs: 50, toolCalls: 1 }),
        ]);

        expect(total).toEqual({
            runs: 4,
            durationMs: 4700,
            toolDurationMs: 550,
            toolCalls: 4,
            queueWaitMs: 0,
            active: 1,
            failed: 1,
            cancelled: 1,
        });
    });

    it('reports delegated wall clock that was not tool execution', () => {
        // A child that thinks for eight seconds and runs `ls` for 40ms.
        expect(subagentNonToolTime([
            subagentStat({ durationMs: 8800, toolDurationMs: 40 }),
        ])).toBe(8760);
        expect(subagentNonToolTime([
            subagentStat({ agentId: 'a1', durationMs: 8800, toolDurationMs: 40 }),
            subagentStat({ agentId: 'a2', durationMs: 7900, toolDurationMs: 60 }),
        ])).toBe(16_600);
    });

    it('never reports negative non-tool time when a duration snapshot lags', () => {
        // A background run whose tool events landed after its last run sync.
        expect(subagentNonToolTime([
            subagentStat({ durationMs: 100, toolDurationMs: 5000 }),
        ])).toBe(0);
        expect(subagentNonToolTime([])).toBe(0);
    });

    it('repairs serialized rows and drops the ones without an agent id', () => {
        expect(parseSubagentStatEntries([
            { agentId: 'a1', name: 'Explorer', status: 'failed', durationMs: 3000, toolDurationMs: 1, toolCalls: 1 },
            { agentId: 'a2' },
            { name: 'orphan' },
            null,
        ])).toEqual([
            {
                agentId: 'a1',
                name: 'Explorer',
                status: 'failed',
                durationMs: 3000,
                queueWaitMs: 0,
                toolDurationMs: 1,
                toolCalls: 1,
            },
            {
                agentId: 'a2',
                name: 'a2',
                status: 'active',
                durationMs: 0,
                queueWaitMs: 0,
                toolDurationMs: 0,
                toolCalls: 0,
            },
        ]);
        expect(parseSubagentStatEntries(undefined)).toEqual([]);
    });
});

describe('serialized tool statistics parsing', () => {
    it('keeps well-formed rows and repairs missing counters', () => {
        expect(parseToolStatEntries([
            { name: 'Grep', calls: 2, durationMs: 452_000 },
            { name: 'Read' },
        ])).toEqual([
            { name: 'Grep', calls: 2, durationMs: 452_000 },
            { name: 'Read', calls: 1, durationMs: 0 },
        ]);
    });

    it('drops anything without a usable name', () => {
        expect(parseToolStatEntries([null, 'Grep', { name: '' }, { calls: 3 }])).toEqual([]);
        expect(parseToolStatEntries(undefined)).toEqual([]);
        expect(parseToolStatEntries({ name: 'Grep' })).toEqual([]);
    });
});
