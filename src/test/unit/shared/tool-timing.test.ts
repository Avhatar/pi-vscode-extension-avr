import { describe, expect, it } from 'vitest';
import {
    accumulateToolStat,
    formatToolDurationSeconds,
    parseToolStatEntries,
    toolStatDisplayName,
    toolStatEntries,
    totalToolStats,
    type ToolStatEntry,
} from '../../../shared/tool-timing';

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
