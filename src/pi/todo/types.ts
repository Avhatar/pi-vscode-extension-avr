// Tool / command identity. The tool name "todo" doubles as the persistence
// key for branch replay (filtering `toolResult.toolName === "todo"`) — never
// rename without a migration plan for existing session files.
//
// Schema and prompt copy adopted from @juicesharp/rpiv-todo (MIT, by
// juicesharp). The persistence-by-replay approach and the seven
// promptGuidelines are theirs; we trimmed `metadata` / `owner` because v1
// does not need them.

import { type Static, Type } from 'typebox';
import type { TaskInfo, TaskStatus, TodoSnapshot } from '../../shared/protocol';

// Re-export cross-boundary types so internal modules import from one place.
export type { TaskStatus, TodoSnapshot } from '../../shared/protocol';
export type Task = TaskInfo;

export const TOOL_NAME = 'todo';
export const TOOL_LABEL = 'Todo';

export type TaskAction = 'create' | 'update' | 'list' | 'get' | 'delete' | 'clear';

// In-memory state cell. Identical shape to `TodoSnapshot`, but kept as a
// distinct alias so future host-only fields (e.g. dirty markers, last
// commit timestamp) can be added without touching the wire protocol.
export interface TaskState {
    tasks: TaskInfo[];
    nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

// Persistence + replay snapshot. Every successful tool call returns this
// shape under `details`; `replay.ts` reads the latest one from the branch
// to reconstruct module state.
export interface TaskDetails {
    action: TaskAction;
    params: Record<string, unknown>;
    tasks: Task[];
    nextId: number;
    error?: string;
}

// Open-shape input bag the reducer accepts. Stays an interface so the
// runtime can pass `Static<typeof TodoParamsSchema>` through without casts.
export interface TaskMutationParams {
    [key: string]: unknown;
    subject?: string;
    description?: string;
    activeForm?: string;
    status?: TaskStatus;
    blockedBy?: number[];
    addBlockedBy?: number[];
    removeBlockedBy?: number[];
    id?: number;
    includeDeleted?: boolean;
}

// TypeBox parameter schema. Every `description` string here doubles as
// LLM-facing prompt copy — keep it tight and English.

const StatusEnum = Type.Union(
    [
        Type.Literal('pending'),
        Type.Literal('in_progress'),
        Type.Literal('completed'),
        Type.Literal('deleted'),
    ],
    { description: 'Target status (update) or list filter (list)' },
);

const ActionEnum = Type.Union([
    Type.Literal('create'),
    Type.Literal('update'),
    Type.Literal('list'),
    Type.Literal('get'),
    Type.Literal('delete'),
    Type.Literal('clear'),
]);

export const TodoParamsSchema = Type.Object({
    action: ActionEnum,
    subject: Type.Optional(Type.String({ description: 'Task subject line (required for create)' })),
    description: Type.Optional(Type.String({ description: 'Long-form task description' })),
    activeForm: Type.Optional(
        Type.String({
            description:
                "Present-continuous label shown while status is in_progress (e.g. 'writing tests')",
        }),
    ),
    status: Type.Optional(StatusEnum),
    blockedBy: Type.Optional(
        Type.Array(Type.Number(), { description: 'Initial blockedBy ids (create only)' }),
    ),
    addBlockedBy: Type.Optional(
        Type.Array(Type.Number(), {
            description: 'Task ids to add to blockedBy (update only, additive merge)',
        }),
    ),
    removeBlockedBy: Type.Optional(
        Type.Array(Type.Number(), {
            description: 'Task ids to remove from blockedBy (update only, additive merge)',
        }),
    ),
    id: Type.Optional(
        Type.Number({ description: 'Task id (required for update, get, delete)' }),
    ),
    includeDeleted: Type.Optional(
        Type.Boolean({
            description:
                'If true, list action returns deleted (tombstoned) tasks as well. Default: false.',
        }),
    ),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
