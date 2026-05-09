import { describe, it, expect } from 'vitest';
import { replayFromBranch, isTaskDetails } from '../../../../pi/todo/replay';
import type { TaskDetails } from '../../../../pi/todo/types';

// Fabricate a Pi-style branch entry — we only model the fields replay
// looks at, intentionally loose so this test does not depend on Pi SDK
// type declarations.
function toolResultEntry(toolName: string, details: unknown, opts: { isError?: boolean } = {}) {
    return {
        type: 'message',
        id: Math.random().toString(36).slice(2),
        message: {
            role: 'toolResult',
            toolName,
            details,
            isError: opts.isError ?? false,
            timestamp: Date.now(),
        },
    };
}

function userEntry(text: string) {
    return {
        type: 'message',
        id: Math.random().toString(36).slice(2),
        message: { role: 'user', content: text, timestamp: Date.now() },
    };
}

const validDetails = (tasks: TaskDetails['tasks'], nextId: number): TaskDetails => ({
    action: 'list',
    params: {},
    tasks,
    nextId,
});

describe('replay: empty / no-match cases', () => {
    it('empty branch → empty state', () => {
        const result = replayFromBranch([]);
        expect(result).toEqual({ tasks: [], nextId: 1 });
    });

    it('branch with no todo entries → empty state', () => {
        const branch = [userEntry('hi'), toolResultEntry('bash', { stdout: '' })];
        const result = replayFromBranch(branch);
        expect(result).toEqual({ tasks: [], nextId: 1 });
    });

    it('skips entries with type !== "message"', () => {
        const branch = [
            { type: 'compaction', summary: 'old stuff' },
            { type: 'thinking_level_change', thinkingLevel: 'high' },
        ];
        const result = replayFromBranch(branch);
        expect(result).toEqual({ tasks: [], nextId: 1 });
    });
});

describe('replay: last-write-wins', () => {
    it('takes the latest todo tool-result snapshot', () => {
        const earlier = validDetails([{ id: 1, subject: 'old', status: 'pending' }], 2);
        const later = validDetails(
            [
                { id: 1, subject: 'old', status: 'completed' },
                { id: 2, subject: 'new', status: 'in_progress' },
            ],
            3,
        );
        const branch = [toolResultEntry('todo', earlier), toolResultEntry('todo', later)];
        const result = replayFromBranch(branch);
        expect(result.tasks).toHaveLength(2);
        expect(result.nextId).toBe(3);
        expect(result.tasks[0]).toMatchObject({ id: 1, status: 'completed' });
    });

    it('ignores other tools interleaved between todo snapshots', () => {
        const snapshot = validDetails([{ id: 1, subject: 'A', status: 'pending' }], 2);
        const branch = [
            toolResultEntry('todo', snapshot),
            toolResultEntry('bash', { stdout: 'unrelated' }),
            toolResultEntry('read', { content: 'unrelated' }),
        ];
        const result = replayFromBranch(branch);
        expect(result.tasks).toHaveLength(1);
        expect(result.nextId).toBe(2);
    });

    it('produces a defensive copy — mutating the result does not change subsequent replays', () => {
        const snapshot = validDetails([{ id: 1, subject: 'A', status: 'pending' }], 2);
        const branch = [toolResultEntry('todo', snapshot)];
        const r1 = replayFromBranch(branch);
        r1.tasks[0]!.subject = 'mutated';
        const r2 = replayFromBranch(branch);
        expect(r2.tasks[0]?.subject).toBe('A');
    });
});

describe('replay: defensive against malformed data', () => {
    it('skips todo entries with missing details', () => {
        const branch = [
            toolResultEntry('todo', undefined),
            toolResultEntry('todo', validDetails([{ id: 1, subject: 'A', status: 'pending' }], 2)),
            toolResultEntry('todo', null),
        ];
        const result = replayFromBranch(branch);
        // Last valid wins; the trailing null entry is skipped.
        expect(result.tasks).toHaveLength(1);
    });

    it('skips todo entries with details missing required fields', () => {
        const branch = [
            toolResultEntry('todo', { tasks: 'not-an-array', nextId: 5 }),
            toolResultEntry('todo', { tasks: [], nextId: 'not-a-number' }),
        ];
        const result = replayFromBranch(branch);
        expect(result).toEqual({ tasks: [], nextId: 1 });
    });

    it('skips errored todo tool calls', () => {
        const valid = validDetails([{ id: 1, subject: 'A', status: 'pending' }], 2);
        const errored = validDetails([{ id: 99, subject: 'should-be-ignored', status: 'pending' }], 100);
        const branch = [
            toolResultEntry('todo', valid),
            toolResultEntry('todo', errored, { isError: true }),
        ];
        const result = replayFromBranch(branch);
        expect(result.nextId).toBe(2);
        expect(result.tasks[0]?.subject).toBe('A');
    });
});

describe('isTaskDetails guard', () => {
    it('accepts well-formed details', () => {
        expect(isTaskDetails({ tasks: [], nextId: 1 })).toBe(true);
    });

    it('rejects null / undefined / primitives', () => {
        expect(isTaskDetails(null)).toBe(false);
        expect(isTaskDetails(undefined)).toBe(false);
        expect(isTaskDetails('string')).toBe(false);
        expect(isTaskDetails(42)).toBe(false);
    });

    it('rejects when tasks is not an array', () => {
        expect(isTaskDetails({ tasks: 'x', nextId: 1 })).toBe(false);
    });

    it('rejects when nextId is not a number', () => {
        expect(isTaskDetails({ tasks: [], nextId: '1' })).toBe(false);
    });
});
