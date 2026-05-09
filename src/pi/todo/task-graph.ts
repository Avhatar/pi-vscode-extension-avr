import type { Task } from './types';

// Detect whether adding `proposedBlockedBy` as the `blockedBy` set of
// task `subjectId` would create a cycle in the dependency graph.
//
// A cycle exists when, starting from any of `proposedBlockedBy` and
// following existing `blockedBy` edges, we reach `subjectId`.
export function detectCycle(
    tasks: readonly Task[],
    subjectId: number,
    proposedBlockedBy: readonly number[],
): boolean {
    if (proposedBlockedBy.length === 0) return false;
    const byId = new Map<number, Task>();
    for (const task of tasks) byId.set(task.id, task);

    const visited = new Set<number>();
    const stack: number[] = [...proposedBlockedBy];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === subjectId) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        const task = byId.get(current);
        if (!task?.blockedBy) continue;
        for (const dep of task.blockedBy) stack.push(dep);
    }
    return false;
}

// For each task id, the list of task ids that are blocked by it.
// Inverse of `blockedBy`. Used by the `get` action to surface what work
// would unblock when this task completes.
export function deriveBlocks(tasks: readonly Task[]): Map<number, number[]> {
    const result = new Map<number, number[]>();
    for (const task of tasks) {
        if (!task.blockedBy?.length) continue;
        for (const dep of task.blockedBy) {
            const list = result.get(dep);
            if (list) list.push(task.id);
            else result.set(dep, [task.id]);
        }
    }
    return result;
}
