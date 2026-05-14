// Tool registration. The `description` + `promptGuidelines` are what
// the model sees in its system prompt — when the tool is in the active
// set, this copy goes into context; when removed via setActiveToolsByName,
// it disappears entirely (verified against
// pi-coding-agent/agent-session.js:631 _rebuildSystemPrompt).
//
// The default guidelines below are derived from @juicesharp/rpiv-todo
// (MIT, by juicesharp), tightened so the agent uses the tool for every
// actionable request rather than self-judging "complex enough". Users
// can override them via the `pi-code.todo.promptGuidelines` setting,
// which is read in `_buildResourceLoader` and forwarded into
// `createTodoExtension` → `registerTodoTool`.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
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
    'plan and track every actionable request, even single-step ones.';

const TOOL_PROMPT_SNIPPET = 'Manage a task list to track every actionable request';

/**
 * Default guidelines injected into the system prompt when the user has
 * not overridden them via `pi-code.todo.promptGuidelines`. Kept here as
 * the canonical source so `tool.ts` has a sane fallback even if the
 * setting somehow returns an empty string. Mirror the package.json
 * default verbatim.
 */
export const DEFAULT_TODO_PROMPT_GUIDELINES: readonly string[] = [
    'ALWAYS create a `todo` for every actionable request before starting work — even single-step tasks. Skip only for purely conversational replies that produce no code, files, or commands.',
    'Mark in_progress BEFORE doing the work, completed IMMEDIATELY when done. Exactly one task in_progress at a time; never batch completions.',
    'Don\'t mark completed when tests fail, work is partial, or errors are unresolved — keep it in_progress and add a new task for the blocker.',
    'Use `blockedBy` for dependencies (cycles are rejected).',
    'Subject must be short and imperative (e.g. "Research existing tool"); put long detail in `description`; pass `activeForm` (present-continuous, e.g. "researching existing tool") when marking in_progress.',
];

/** Convert the raw setting value (a multiline string) into a guideline
 *  array. Lines are trimmed, blanks dropped. Empty input falls back to
 *  the built-in defaults so a misconfiguration cannot silently strip
 *  the prompt. */
export function parseTodoPromptGuidelines(raw: string | undefined): string[] {
    const lines = (raw ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : [...DEFAULT_TODO_PROMPT_GUIDELINES];
}

export function registerTodoTool(
    api: ExtensionAPI,
    store: TodoStore,
    guidelines: readonly string[] = DEFAULT_TODO_PROMPT_GUIDELINES,
): void {
    api.registerTool({
        name: TOOL_NAME,
        label: TOOL_LABEL,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...guidelines],
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
