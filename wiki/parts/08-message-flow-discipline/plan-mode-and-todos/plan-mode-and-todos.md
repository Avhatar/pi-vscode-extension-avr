# plan-mode-and-todos

## Stance

Both features are **stateless in the extension host** — every source of truth is external. Plan Mode's "is it on for this session" state lives in VS Code `workspaceState` under a session-path-keyed prefix; the preamble is prepended to prompt text on the way to the SDK. ToDo state lives in the session JSONL as a chain of tool-result entries; the `TodoStore` reconstructs it via replay on `session_start`, `session_compact`, `session_tree`. This means neither feature needs a separate persistence file — the workspace state is trivial, and the ToDo state rides on transcript integrity.

## Role — Plan Mode

Persistence key prefix: `pi-code.planModeEnabled.<sessionPath>` [chat-preferences.ts:10](../../../../src/core/chat/chat-preferences.ts#L10).

- Default at `_planModeDefaultEnabled` [chat-controller.ts:1237](../../../../src/controllers/chat-controller.ts#L1237) — reads the `pi-code.planMode.defaultEnabled` setting.
- Per-tab query `_isPlanModeEnabledFor(tab)` [chat-controller.ts:1243](../../../../src/controllers/chat-controller.ts#L1243) — reads workspace state, falls back to default.
- Preamble constant: `PLAN_MODE_INSTRUCTIONS` [chat-preferences.ts:15](../../../../src/core/chat/chat-preferences.ts#L15).
- Decoration function: `decorateDirectPrompt(text, planModeEnabled)` [chat-preferences.ts:119](../../../../src/core/chat/chat-preferences.ts#L119) — prepends the preamble when enabled; used in [`dispatchDirectPrompt`](../../../../src/core/chat/chat-service.ts) and in queued-message dispatch [chat-controller.ts:1183](../../../../src/controllers/chat-controller.ts#L1183).
- UI state: `SerializedAgentState.controls.planModeEnabled` and `planModeToggleDisabled` [protocol.ts:255](../../../../src/shared/protocol.ts#L255).

## Role — ToDo

Files under [src/pi/todo/](../../../../src/pi/todo/):

- [extension.ts](../../../../src/pi/todo/extension.ts) — extension factory; hooks `session_start`, `session_compact`, `session_tree`.
- [store.ts](../../../../src/pi/todo/store.ts) — `TodoStore` class; in-memory state cell with pub-sub.
- [types.ts](../../../../src/pi/todo/types.ts) — `TaskState`, `TaskAction`, `TaskDetails`, `TaskInfo`, `TaskStatus`.
- [tool.ts](../../../../src/pi/todo/tool.ts) — tool registration + default guidelines.
- [reducer.ts](../../../../src/pi/todo/reducer.ts) — pure mutation logic (create / update / delete / list / get / clear).
- [task-graph.ts](../../../../src/pi/todo/task-graph.ts) — cycle detection, dependency inversion.
- [replay.ts](../../../../src/pi/todo/replay.ts) — branch replay to reconstruct state from transcript.
- [invariants.ts](../../../../src/pi/todo/invariants.ts) — status transition rules.
- [response-envelope.ts](../../../../src/pi/todo/response-envelope.ts) — tool-result formatting.

Key functions:

- [`createTodoExtension(store, guidelines)`](../../../../src/pi/todo/extension.ts#L21) — factory returning the Pi extension callback. Registers `session_start / session_compact / session_tree` handlers, each calling `store.replaceState(replayFromBranch(...))`.
- [`TodoStore`](../../../../src/pi/todo/store.ts#L12) — `getState()`, `replaceState()`, `commit()`, `subscribe()`.
- [`replayFromBranch(entries)`](../../../../src/pi/todo/replay.ts#L33) — scans conversation chronologically, extracts the last successful `toolResult` with `toolName === 'todo'`, reconstructs `TaskState`.
- [`buildToolResult(...)`](../../../../src/pi/todo/response-envelope.ts#L72) — packages the reducer's output plus a `TaskDetails` snapshot into a `ToolResultEnvelope`.
- [`DEFAULT_TODO_PROMPT_GUIDELINES`](../../../../src/pi/todo/tool.ts#L43) — injected into system prompt; user-overrideable via `pi-code.todo.promptGuidelines`.
- [`parseTodoPromptGuidelines()`](../../../../src/pi/todo/tool.ts#L55) — reads the setting, falls back to default if empty.

Persistence model: **no separate file**. `TaskState` is rebuilt from the last tool result in the transcript. `session_compact` triggers a re-replay because compaction rewrites the entry list.

## Role — how they interact

They don't, directly. Plan Mode decorates the *prompt text*; the ToDo tool is available regardless. Enabling Plan Mode does not disable ToDo, and using ToDo does not force Plan Mode. The two features happen to be surfaced together in the launcher because both are per-session toggles.

## Keywords

**Types — Plan Mode:**
- `PLAN_MODE_KEY_PREFIX = 'pi-code.planModeEnabled.'` — [chat-preferences.ts:10](../../../../src/core/chat/chat-preferences.ts#L10)
- `PLAN_MODE_INSTRUCTIONS` — [chat-preferences.ts:15](../../../../src/core/chat/chat-preferences.ts#L15)

**Types — ToDo:**
- `TaskState`, `TaskInfo`, `TaskStatus`, `TaskAction`, `TaskDetails` — [src/pi/todo/types.ts](../../../../src/pi/todo/types.ts)
- `TodoStore` — class [store.ts:12](../../../../src/pi/todo/store.ts#L12)
- `TodoSnapshot` — [protocol.ts:135](../../../../src/shared/protocol.ts#L135)

**Methods — Plan Mode:**
- `decorateDirectPrompt(text, planModeEnabled)` — [chat-preferences.ts:119](../../../../src/core/chat/chat-preferences.ts#L119)
- `_planModeDefaultEnabled()` — [chat-controller.ts:1237](../../../../src/controllers/chat-controller.ts#L1237)
- `_isPlanModeEnabledFor(tab)` — [chat-controller.ts:1243](../../../../src/controllers/chat-controller.ts#L1243)

**Methods — ToDo:**
- `createTodoExtension(store, guidelines)` — [extension.ts:21](../../../../src/pi/todo/extension.ts#L21)
- `replayFromBranch(entries)` — [replay.ts:33](../../../../src/pi/todo/replay.ts#L33)
- `buildToolResult(...)` — [response-envelope.ts:72](../../../../src/pi/todo/response-envelope.ts#L72)
- `parseTodoPromptGuidelines()` — [tool.ts:55](../../../../src/pi/todo/tool.ts#L55)
- Reducer entry points: `createTask`, `updateTask`, `deleteTask`, `listTasks`, `getTask`, `clearTasks` — [reducer.ts](../../../../src/pi/todo/reducer.ts)

**Attributes / markers:**
- Plan Mode workspace-state key: `pi-code.planModeEnabled.<sessionPath>`
- ToDo persistence: reconstructed via replay from transcript, no separate file
- Session events triggering replay: `session_start`, `session_compact`, `session_tree`

**Namespaces:**
- [src/core/chat/chat-preferences.ts](../../../../src/core/chat/chat-preferences.ts) — Plan Mode preamble + decoration
- [src/pi/todo/](../../../../src/pi/todo/) — the whole ToDo subsystem

## Lifecycle edges

**Depends on:**
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `pi-code.planMode.defaultEnabled`, `pi-code.todo.promptGuidelines`, `pi-code.todo.defaultEnabled` settings.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — the ToDo extension is one of the factories handed to the resource loader.
- [Part VI § launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md) — launcher renders the ToDo list.
- [steering](../steering/steering.md) — Plan Mode decoration is skipped for steer / followUp; documented there.
## See also

- **Rule — Plan Mode preamble is prompt-only.** Do not extend `decorateDirectPrompt` to also wrap `steer` or `followUp`. The mode is set at the start of a turn; injecting the preamble mid-turn would double-prime the agent.
- **Rule — ToDo state is derived, not stored.** The store's in-memory copy is transient; the source of truth is the transcript. Do not add a separate serialization; you would just have to keep it in sync.
- **Pattern — replay on three events.** `session_start` covers window reload / new session; `session_compact` covers post-compaction; `session_tree` covers subtree switches. Adding a new event that mutates the transcript must also trigger replay or the ToDo state will drift.
- **Pattern — task-graph invariants catch cycles.** [`task-graph.ts`](../../../../src/pi/todo/task-graph.ts) refuses dependencies that would form a cycle. The tool returns an error rather than corrupting the graph.
- **Pitfall — `pi-code.todo.promptGuidelines` empty means "use default", not "no guidelines".** `parseTodoPromptGuidelines` falls back to `DEFAULT_TODO_PROMPT_GUIDELINES` when the user config is empty. Users who really want to remove guidelines must set the string to something like `disabled` — currently there is no explicit "no guidelines" mode.
- **Pitfall — Plan Mode is per-session, not per-tab.** The key is prefixed with `sessionPath`; two tabs open to the same session share the mode. Two tabs on different sessions do not.
- **Pattern — the ToDo tool result carries the whole state snapshot.** Every mutation returns the full `TaskDetails` so the UI can rehydrate without a separate query. This is why replay can reconstruct state from any single successful tool result — you don't need the delta chain.
