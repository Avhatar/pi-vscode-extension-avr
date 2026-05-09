import { isTransitionValid } from './invariants';
import { detectCycle } from './task-graph';
import type { Task, TaskAction, TaskMutationParams, TaskState, TaskStatus } from './types';

// Reducer outcome. Closed tagged union — adding a new action requires
// extending this union AND the response-envelope's switch (compiler
// enforces exhaustiveness via the closed switch in `formatContent`).
//
// `error` carries the message in-band so callers can pattern-match on
// `op.kind === 'error'` without a side-channel boolean.
export type Op =
    | { kind: 'create'; taskId: number }
    | { kind: 'update'; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
    | { kind: 'delete'; id: number; subject: string }
    | { kind: 'list'; statusFilter?: TaskStatus; includeDeleted: boolean }
    | { kind: 'get'; task: Task }
    | { kind: 'clear'; count: number }
    | { kind: 'error'; message: string };

export interface ApplyResult {
    state: TaskState;
    op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
    return { state, op: { kind: 'error', message } };
}

// Pure reducer: (state, action, params) → (state, op).
//
// Validation is in-line: structural guards (subject required, id required,
// at least one mutable field) plus state-aware checks (transition legality,
// dangling/deleted blockedBy, self-block, cycles).
export function applyTaskMutation(
    state: TaskState,
    action: TaskAction,
    params: TaskMutationParams,
): ApplyResult {
    switch (action) {
        case 'create': {
            if (!params.subject || !params.subject.trim()) {
                return errorResult(state, 'subject required for create');
            }
            if (params.blockedBy?.length) {
                for (const dep of params.blockedBy) {
                    const depTask = state.tasks.find((t) => t.id === dep);
                    if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
                    if (depTask.status === 'deleted') {
                        return errorResult(state, `blockedBy: #${dep} is deleted`);
                    }
                }
            }
            const newTask: Task = {
                id: state.nextId,
                subject: params.subject,
                status: 'pending',
            };
            if (params.description) newTask.description = params.description;
            if (params.activeForm) newTask.activeForm = params.activeForm;
            if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];

            return {
                state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
                op: { kind: 'create', taskId: newTask.id },
            };
        }

        case 'update': {
            if (params.id === undefined) return errorResult(state, 'id required for update');
            const idx = state.tasks.findIndex((t) => t.id === params.id);
            if (idx === -1) return errorResult(state, `#${params.id} not found`);
            const current = state.tasks[idx]!;

            const hasMutation =
                params.subject !== undefined ||
                params.description !== undefined ||
                params.activeForm !== undefined ||
                params.status !== undefined ||
                (params.addBlockedBy && params.addBlockedBy.length > 0) ||
                (params.removeBlockedBy && params.removeBlockedBy.length > 0);
            if (!hasMutation) {
                return errorResult(state, 'update requires at least one mutable field');
            }

            let newStatus = current.status;
            if (params.status !== undefined) {
                if (!isTransitionValid(current.status, params.status)) {
                    return errorResult(
                        state,
                        `illegal transition ${current.status} → ${params.status}`,
                    );
                }
                newStatus = params.status;
            }

            let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
            if (params.removeBlockedBy?.length) {
                const toRemove = new Set(params.removeBlockedBy);
                newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
            }
            if (params.addBlockedBy?.length) {
                for (const dep of params.addBlockedBy) {
                    if (dep === current.id) {
                        return errorResult(state, `cannot block #${current.id} on itself`);
                    }
                    const depTask = state.tasks.find((t) => t.id === dep);
                    if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
                    if (depTask.status === 'deleted') {
                        return errorResult(state, `addBlockedBy: #${dep} is deleted`);
                    }
                    if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
                }
                if (detectCycle(state.tasks, current.id, newBlockedBy)) {
                    return errorResult(
                        state,
                        'addBlockedBy would create a cycle in the blockedBy graph',
                    );
                }
            }

            const updated: Task = { ...current, status: newStatus };
            if (params.subject !== undefined) updated.subject = params.subject;
            if (params.description !== undefined) updated.description = params.description;
            if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
            if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
            else delete updated.blockedBy;

            const newTasks = [...state.tasks];
            newTasks[idx] = updated;
            return {
                state: { tasks: newTasks, nextId: state.nextId },
                op: {
                    kind: 'update',
                    id: updated.id,
                    fromStatus: current.status,
                    toStatus: newStatus,
                },
            };
        }

        case 'list': {
            return {
                state,
                op: {
                    kind: 'list',
                    includeDeleted: params.includeDeleted === true,
                    ...(params.status !== undefined ? { statusFilter: params.status } : {}),
                },
            };
        }

        case 'get': {
            if (params.id === undefined) return errorResult(state, 'id required for get');
            const task = state.tasks.find((t) => t.id === params.id);
            if (!task) return errorResult(state, `#${params.id} not found`);
            return { state, op: { kind: 'get', task } };
        }

        case 'delete': {
            if (params.id === undefined) return errorResult(state, 'id required for delete');
            const idx = state.tasks.findIndex((t) => t.id === params.id);
            if (idx === -1) return errorResult(state, `#${params.id} not found`);
            const current = state.tasks[idx]!;
            if (current.status === 'deleted') {
                return errorResult(state, `#${current.id} is already deleted`);
            }
            const updated: Task = { ...current, status: 'deleted' };
            const newTasks = [...state.tasks];
            newTasks[idx] = updated;
            return {
                state: { tasks: newTasks, nextId: state.nextId },
                op: { kind: 'delete', id: updated.id, subject: updated.subject },
            };
        }

        case 'clear': {
            const count = state.tasks.length;
            return {
                state: { tasks: [], nextId: 1 },
                op: { kind: 'clear', count },
            };
        }
    }
}
