import type { TaskStatus } from './types';

// Allowed forward transitions per source status. `completed` is one-way to
// `deleted` (never back to `in_progress`); `deleted` is terminal. This
// blocks the model from accidentally un-completing a task.
//
// Idempotent same → same is checked separately in `isTransitionValid`.
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
    pending: new Set<TaskStatus>(['in_progress', 'completed', 'deleted']),
    in_progress: new Set<TaskStatus>(['pending', 'completed', 'deleted']),
    completed: new Set<TaskStatus>(['deleted']),
    deleted: new Set<TaskStatus>(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
    if (from === to) return true;
    return VALID_TRANSITIONS[from].has(to);
}
