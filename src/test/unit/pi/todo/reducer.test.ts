import { describe, it, expect } from 'vitest';
import { applyTaskMutation } from '../../../../pi/todo/reducer';
import { EMPTY_STATE, type TaskState } from '../../../../pi/todo/types';

function emptyState(): TaskState {
    return { tasks: [], nextId: EMPTY_STATE.nextId };
}

describe('reducer: create', () => {
    it('creates a pending task with auto-incrementing id', () => {
        const before = emptyState();
        const { state, op } = applyTaskMutation(before, 'create', { subject: 'Research X' });
        expect(op).toEqual({ kind: 'create', taskId: 1 });
        expect(state.tasks).toHaveLength(1);
        expect(state.tasks[0]).toMatchObject({ id: 1, subject: 'Research X', status: 'pending' });
        expect(state.nextId).toBe(2);
    });

    it('rejects empty / whitespace subject', () => {
        const { op } = applyTaskMutation(emptyState(), 'create', { subject: '   ' });
        expect(op.kind).toBe('error');
    });

    it('preserves description, activeForm, blockedBy', () => {
        let state = emptyState();
        state = applyTaskMutation(state, 'create', { subject: 'A' }).state;
        const { state: s2, op } = applyTaskMutation(state, 'create', {
            subject: 'B',
            description: 'long detail',
            activeForm: 'working on B',
            blockedBy: [1],
        });
        expect(op.kind).toBe('create');
        expect(s2.tasks[1]).toMatchObject({
            id: 2,
            subject: 'B',
            description: 'long detail',
            activeForm: 'working on B',
            blockedBy: [1],
        });
    });

    it('rejects blockedBy referencing missing task', () => {
        const { op } = applyTaskMutation(emptyState(), 'create', {
            subject: 'X',
            blockedBy: [99],
        });
        expect(op.kind).toBe('error');
    });

    it('rejects blockedBy referencing deleted task', () => {
        let state = emptyState();
        state = applyTaskMutation(state, 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'delete', { id: 1 }).state;
        const { op } = applyTaskMutation(state, 'create', { subject: 'B', blockedBy: [1] });
        expect(op.kind).toBe('error');
    });
});

describe('reducer: update / state machine', () => {
    function withOneTask(): TaskState {
        return applyTaskMutation(emptyState(), 'create', { subject: 'A' }).state;
    }

    it('legal transition pending → in_progress', () => {
        const before = withOneTask();
        const { state, op } = applyTaskMutation(before, 'update', { id: 1, status: 'in_progress' });
        expect(op).toEqual({ kind: 'update', id: 1, fromStatus: 'pending', toStatus: 'in_progress' });
        expect(state.tasks[0].status).toBe('in_progress');
    });

    it('legal transition in_progress → completed', () => {
        let state = withOneTask();
        state = applyTaskMutation(state, 'update', { id: 1, status: 'in_progress' }).state;
        state = applyTaskMutation(state, 'update', { id: 1, status: 'completed' }).state;
        expect(state.tasks[0].status).toBe('completed');
    });

    it('rejects illegal transition completed → in_progress', () => {
        let state = withOneTask();
        state = applyTaskMutation(state, 'update', { id: 1, status: 'completed' }).state;
        const { op } = applyTaskMutation(state, 'update', { id: 1, status: 'in_progress' });
        expect(op.kind).toBe('error');
    });

    it('completed → deleted is the only legal exit from completed', () => {
        let state = withOneTask();
        state = applyTaskMutation(state, 'update', { id: 1, status: 'completed' }).state;
        const { state: s2, op } = applyTaskMutation(state, 'update', { id: 1, status: 'deleted' });
        expect(op.kind).toBe('update');
        expect(s2.tasks[0].status).toBe('deleted');
    });

    it('idempotent same-status update is allowed', () => {
        const before = withOneTask();
        const { state, op } = applyTaskMutation(before, 'update', { id: 1, status: 'pending' });
        expect(op.kind).toBe('update');
        expect(state.tasks[0].status).toBe('pending');
    });

    it('rejects update without any mutable field', () => {
        const { op } = applyTaskMutation(withOneTask(), 'update', { id: 1 });
        expect(op.kind).toBe('error');
    });

    it('rejects update for missing id', () => {
        const { op } = applyTaskMutation(withOneTask(), 'update', { id: 999, status: 'completed' });
        expect(op.kind).toBe('error');
    });
});

describe('reducer: blockedBy add/remove', () => {
    function withTwoTasks(): TaskState {
        let state = emptyState();
        state = applyTaskMutation(state, 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'create', { subject: 'B' }).state;
        return state;
    }

    it('addBlockedBy is additive — does not replace', () => {
        let state = withTwoTasks();
        state = applyTaskMutation(state, 'create', { subject: 'C' }).state;
        state = applyTaskMutation(state, 'update', { id: 3, addBlockedBy: [1] }).state;
        state = applyTaskMutation(state, 'update', { id: 3, addBlockedBy: [2] }).state;
        expect(state.tasks[2].blockedBy).toEqual([1, 2]);
    });

    it('removeBlockedBy filters', () => {
        let state = withTwoTasks();
        state = applyTaskMutation(state, 'create', { subject: 'C', blockedBy: [1, 2] }).state;
        state = applyTaskMutation(state, 'update', { id: 3, removeBlockedBy: [1] }).state;
        expect(state.tasks[2].blockedBy).toEqual([2]);
    });

    it('rejects self-block', () => {
        const state = withTwoTasks();
        const { op } = applyTaskMutation(state, 'update', { id: 1, addBlockedBy: [1] });
        expect(op.kind).toBe('error');
    });

    it('detects 2-cycle: A blocks B, then trying B blocks A', () => {
        let state = withTwoTasks();
        state = applyTaskMutation(state, 'update', { id: 1, addBlockedBy: [2] }).state;
        const { op } = applyTaskMutation(state, 'update', { id: 2, addBlockedBy: [1] });
        expect(op.kind).toBe('error');
        expect((op as any).message).toMatch(/cycle/);
    });

    it('detects 3-cycle through transitive deps', () => {
        let state = emptyState();
        state = applyTaskMutation(state, 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'create', { subject: 'B', blockedBy: [1] }).state;
        state = applyTaskMutation(state, 'create', { subject: 'C', blockedBy: [2] }).state;
        const { op } = applyTaskMutation(state, 'update', { id: 1, addBlockedBy: [3] });
        expect(op.kind).toBe('error');
    });

    it('rejects addBlockedBy referencing deleted task', () => {
        let state = withTwoTasks();
        state = applyTaskMutation(state, 'delete', { id: 1 }).state;
        const { op } = applyTaskMutation(state, 'update', { id: 2, addBlockedBy: [1] });
        expect(op.kind).toBe('error');
    });

    it('clears blockedBy field when last dep is removed', () => {
        let state = withTwoTasks();
        state = applyTaskMutation(state, 'create', { subject: 'C', blockedBy: [1] }).state;
        state = applyTaskMutation(state, 'update', { id: 3, removeBlockedBy: [1] }).state;
        expect(state.tasks[2].blockedBy).toBeUndefined();
    });
});

describe('reducer: delete keeps tombstone', () => {
    it('delete sets status=deleted but keeps the task in the list', () => {
        let state = applyTaskMutation(emptyState(), 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'delete', { id: 1 }).state;
        expect(state.tasks).toHaveLength(1);
        expect(state.tasks[0].status).toBe('deleted');
    });

    it('rejects double-delete', () => {
        let state = applyTaskMutation(emptyState(), 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'delete', { id: 1 }).state;
        const { op } = applyTaskMutation(state, 'delete', { id: 1 });
        expect(op.kind).toBe('error');
    });

    it('historic blockedBy still resolves to tombstoned task', () => {
        let state = applyTaskMutation(emptyState(), 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'create', { subject: 'B', blockedBy: [1] }).state;
        state = applyTaskMutation(state, 'delete', { id: 1 }).state;
        // Task #2 still has blockedBy: [1] pointing at the tombstone.
        expect(state.tasks[1].blockedBy).toEqual([1]);
        // The tombstone is still findable by id.
        expect(state.tasks.find((t) => t.id === 1)?.status).toBe('deleted');
    });
});

describe('reducer: list / get / clear', () => {
    function withMixed(): TaskState {
        let state = emptyState();
        state = applyTaskMutation(state, 'create', { subject: 'A' }).state;
        state = applyTaskMutation(state, 'create', { subject: 'B' }).state;
        state = applyTaskMutation(state, 'update', { id: 1, status: 'in_progress' }).state;
        state = applyTaskMutation(state, 'delete', { id: 2 }).state;
        return state;
    }

    it('list does not mutate state', () => {
        const before = withMixed();
        const { state } = applyTaskMutation(before, 'list', {});
        expect(state).toBe(before);
    });

    it('get returns the task on success', () => {
        const { op } = applyTaskMutation(withMixed(), 'get', { id: 1 });
        expect(op.kind).toBe('get');
        expect((op as any).task.subject).toBe('A');
    });

    it('get errors for missing id', () => {
        const { op } = applyTaskMutation(withMixed(), 'get', { id: 999 });
        expect(op.kind).toBe('error');
    });

    it('clear empties tasks and resets nextId', () => {
        const { state, op } = applyTaskMutation(withMixed(), 'clear', {});
        expect(op).toEqual({ kind: 'clear', count: 2 });
        expect(state.tasks).toEqual([]);
        expect(state.nextId).toBe(1);
    });
});
