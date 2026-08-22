import { describe, expect, it } from 'vitest';

import { orderDisplayMessages } from '../../../webview/display-order';

const displayEverything = () => true;

function assistant(timestamp: number, text: string): any {
    return { role: 'assistant', timestamp, content: [{ type: 'text', text }] };
}

function toolResult(timestamp: number, toolName: string): any {
    return { role: 'toolResult', timestamp, toolName };
}

function notification(timestamp: number, name: string, finishedAt?: number): any {
    return {
        role: 'custom',
        customType: 'pi-code.subagent-notification',
        timestamp,
        details: { name, ...(finishedAt !== undefined ? { finishedAt } : {}) },
    };
}

function names(items: Array<{ msg: any }>): string[] {
    return items.map((item) => item.msg.details?.name
        ?? item.msg.toolName
        ?? item.msg.content?.[0]?.text
        ?? item.msg.role);
}

describe('chat display ordering', () => {
    it('places a subagent that finished mid-turn before the final report', () => {
        // The notification is appended at agent_end (t=500) even though the
        // child settled at t=250 — exactly the shape the session produces.
        const items = orderDisplayMessages([
            toolResult(100, 'subagent'),
            toolResult(300, 'bash'),
            assistant(400, 'final report'),
            notification(500, 'read-smoke-test', 250),
        ], displayEverything);

        expect(names(items)).toEqual(['subagent', 'read-smoke-test', 'bash', 'final report']);
    });

    it('keeps a child that really outlived the turn below the report', () => {
        const items = orderDisplayMessages([
            toolResult(100, 'subagent'),
            assistant(400, 'final report'),
            notification(500, 'slow-child', 480),
        ], displayEverything);

        expect(names(items)).toEqual(['subagent', 'final report', 'slow-child']);
    });

    it('orders several children by when each one finished', () => {
        const items = orderDisplayMessages([
            toolResult(100, 'subagent'),
            assistant(400, 'final report'),
            notification(500, 'third', 380),
            notification(501, 'first', 150),
            notification(502, 'second', 200),
        ], displayEverything);

        expect(names(items)).toEqual(['subagent', 'first', 'second', 'third', 'final report']);
    });

    it('leaves a notification without a completion time where it was appended', () => {
        const items = orderDisplayMessages([
            toolResult(100, 'subagent'),
            assistant(400, 'final report'),
            notification(500, 'legacy-child'),
        ], displayEverything);

        expect(names(items)).toEqual(['subagent', 'final report', 'legacy-child']);
    });

    it('still hoists compaction summaries to their own position', () => {
        const items = orderDisplayMessages([
            assistant(100, 'before'),
            assistant(300, 'after'),
            { role: 'compactionSummary', timestamp: 200 },
        ], displayEverything);

        expect(items.map((item) => item.msg.role))
            .toEqual(['assistant', 'compactionSummary', 'assistant']);
        expect(items[1].msg._latestCompaction).toBe(true);
    });

    it('marks only the newest compaction as latest', () => {
        const items = orderDisplayMessages([
            assistant(100, 'a'),
            { role: 'compactionSummary', timestamp: 150 },
            assistant(200, 'b'),
            { role: 'compactionSummary', timestamp: 250 },
        ], displayEverything);

        const compactions = items.filter((item) => item.msg.role === 'compactionSummary');
        expect(compactions.map((item) => item.msg._latestCompaction)).toEqual([false, true]);
    });

    it('reports the original transcript index after repositioning', () => {
        const items = orderDisplayMessages([
            toolResult(100, 'subagent'),
            assistant(400, 'final report'),
            notification(500, 'read-smoke-test', 250),
        ], displayEverything);

        expect(items.map((item) => item.sourceIndex)).toEqual([0, 2, 1]);
    });

    it('drops messages the chat does not display', () => {
        const items = orderDisplayMessages([
            assistant(100, 'shown'),
            { role: 'internal', timestamp: 200 },
        ], (msg) => msg.role !== 'internal');

        expect(names(items)).toEqual(['shown']);
    });
});
