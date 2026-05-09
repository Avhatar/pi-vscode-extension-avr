// Tool response shaping. The `details` envelope is the persistence +
// replay snapshot — `replay.ts` reads this exact shape back.
//
// Adopted from @juicesharp/rpiv-todo (MIT). The `formatContent` switch
// stays exhaustive: adding a new `Op` variant fails to compile until a
// branch is added here.

import type { Op } from './reducer';
import { deriveBlocks } from './task-graph';
import type {
    Task,
    TaskAction,
    TaskDetails,
    TaskMutationParams,
    TaskState,
} from './types';

function formatListLine(t: Task): string {
    const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(',')}` : '';
    const form = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : '';
    return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
}

function formatGetLines(task: Task, state: TaskState): string {
    const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
    const lines = [`#${task.id} [${task.status}] ${task.subject}`];
    if (task.description) lines.push(`  description: ${task.description}`);
    if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
    if (task.blockedBy?.length) {
        lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(', ')}`);
    }
    if (blocks.length) {
        lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(', ')}`);
    }
    return lines.join('\n');
}

export function formatContent(op: Op, state: TaskState): string {
    switch (op.kind) {
        case 'create': {
            const t = state.tasks.find((x) => x.id === op.taskId);
            if (!t) return `Created #${op.taskId}`;
            return `Created #${t.id}: ${t.subject} (pending)`;
        }
        case 'update': {
            const transition =
                op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : '';
            return `Updated #${op.id}${transition}`;
        }
        case 'delete':
            return `Deleted #${op.id}: ${op.subject}`;
        case 'clear':
            return `Cleared ${op.count} tasks`;
        case 'list': {
            let view = state.tasks;
            if (!op.includeDeleted) view = view.filter((t) => t.status !== 'deleted');
            if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
            return view.length === 0 ? 'No tasks' : view.map(formatListLine).join('\n');
        }
        case 'get':
            return formatGetLines(op.task, state);
        case 'error':
            return `Error: ${op.message}`;
    }
}

export interface ToolResultEnvelope {
    content: Array<{ type: 'text'; text: string }>;
    details: TaskDetails;
}

export function buildToolResult(
    action: TaskAction,
    params: TaskMutationParams,
    state: TaskState,
    op: Op,
): ToolResultEnvelope {
    const text = formatContent(op, state);
    const details: TaskDetails = {
        action,
        params: params as Record<string, unknown>,
        tasks: state.tasks,
        nextId: state.nextId,
        ...(op.kind === 'error' ? { error: op.message } : {}),
    };
    return { content: [{ type: 'text', text }], details };
}
