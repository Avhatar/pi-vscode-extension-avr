// Tool registration. The `description` + `promptGuidelines` are what
// the model sees in its system prompt — when the tool is in the active
// set, this copy goes into context; when removed via setActiveToolsByName,
// it disappears entirely (verified against
// pi-coding-agent/agent-session.js:631 _rebuildSystemPrompt).
//
// The seven guidelines below are adopted from @juicesharp/rpiv-todo
// (MIT, by juicesharp). They have ~10K downloads/month of real-world
// validation and converge with Claude Code's TodoWrite. Do not soften
// them without evidence — the imperative voice ("mark in_progress
// BEFORE", "never batch") is what makes the model use the tool with
// discipline instead of as decoration.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { applyTaskMutation } from './reducer';
import { buildToolResult } from './response-envelope';
import type { TodoStore } from './store';
import {
    type TaskMutationParams,
    TOOL_LABEL,
    TOOL_NAME,
    type TodoParams,
    TodoParamsSchema,
} from './types';

const TOOL_DESCRIPTION =
    'Manage a task list for tracking multi-step progress. Actions: ' +
    'create (new task), update (change status/fields/dependencies), ' +
    'list (all tasks, optionally filtered by status), get (single task ' +
    'details), delete (tombstone), clear (reset all). Status: pending ' +
    '→ in_progress → completed, plus deleted tombstone. Use this to ' +
    'plan and track multi-step work like research, design, and ' +
    'implementation.';

const TOOL_PROMPT_SNIPPET = 'Manage a task list to track multi-step progress';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.',
    'When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.',
    'Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.',
    'Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. "researching existing tool") when marking in_progress.',
    'Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.',
    'list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.',
    'Subject must be short and imperative (e.g. "Research existing tool"); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.',
];

export function registerTodoTool(api: ExtensionAPI, store: TodoStore): void {
    api.registerTool({
        name: TOOL_NAME,
        label: TOOL_LABEL,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: TodoParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as TodoParams;
            const result = applyTaskMutation(
                store.getState(),
                typed.action,
                typed as TaskMutationParams,
            );
            store.commit(result.state);
            return buildToolResult(typed.action, typed as TaskMutationParams, result.state, result.op);
        },
    });
}
