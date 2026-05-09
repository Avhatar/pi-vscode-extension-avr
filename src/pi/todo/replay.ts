import { EMPTY_STATE, type Task, type TaskDetails, type TaskState, TOOL_NAME } from './types';

// Discriminator for `details` envelopes that match the persisted shape.
// Defensive — branch entries from older or corrupt sessions are skipped
// silently rather than crashing replay.
export function isTaskDetails(value: unknown): value is TaskDetails {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return Array.isArray(v.tasks) && typeof v.nextId === 'number';
}

// Minimal shape of a Pi session branch entry that we care about. Kept
// open-shaped so this module does not depend on the Pi SDK type
// declarations and the tests can fabricate fixtures freely.
interface BranchEntryLike {
    type?: string;
    message?: {
        role?: string;
        toolName?: string;
        details?: unknown;
        isError?: boolean;
    };
}

// Walk the branch in chronological order; the LAST `toolResult` whose
// `toolName === 'todo'` and whose `details` shape matches `TaskDetails`
// wins (last-write-wins). When no matching entry exists, returns an
// independent copy of `EMPTY_STATE`.
//
// This is the entire persistence story — no file IO, no external store.
// Tool results live in the conversation; compaction keeps the most
// recent ones; replay rebuilds state from whatever survived.
export function replayFromBranch(entries: Iterable<unknown>): TaskState {
    let result: TaskState = { tasks: [], nextId: EMPTY_STATE.nextId };
    for (const entry of entries) {
        const e = entry as BranchEntryLike;
        if (e.type !== 'message') continue;
        const msg = e.message;
        if (!msg || msg.role !== 'toolResult' || msg.toolName !== TOOL_NAME) continue;
        // Errored tool calls still persist a snapshot, but we treat them
        // as informational only — the reducer never produces a snapshot
        // for an error case (it returns the unchanged state). Skipping
        // here is belt-and-braces.
        if (msg.isError) continue;
        if (!isTaskDetails(msg.details)) continue;
        result = {
            tasks: msg.details.tasks.map((t: Task) => ({ ...t })),
            nextId: msg.details.nextId,
        };
    }
    return result;
}
