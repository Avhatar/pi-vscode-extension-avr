# Persistent ToDo per chat

A roadmap document for adding a per-tab, opt-in todo list that survives
conversation compaction by replaying the latest tool-result snapshot from
the session branch — no external file storage.

> **Start date:** 2026-05-09
> **Current version:** 0.12.1
> **Target version after feature lands:** 0.13.0 (minor — visible new UX,
> backward compatible)

The design is heavily informed by [`@juicesharp/rpiv-todo`](https://pi.dev/packages/@juicesharp/rpiv-todo)
(MIT). We are not bundling that package — it depends on the
`@earendil-works` Pi fork which is incompatible with our `@mariozechner`
runtime — but we adopt its core trick (persistence by branch replay) and
its battle-tested tool description / promptGuidelines copy. See depth-4
notes in `x:/Projects/pi-packages-research/packages.json` for the
incompatibility detail.

---

## 1. Goal and motivation

LLM coding agents lose track of multi-step plans when:

1. The conversation hits the context window and Pi runs `/compact`,
   collapsing earlier turns into a summary.
2. The user reloads the session.
3. The user closes and reopens VS Code.

A persistent todo list lets the model record the plan once and rely on it
across these events. Following Claude Code's TodoWrite and rpiv-todo, we
expect this to materially reduce drift on tasks of 5+ steps.

The feature is **opt-in per chat**. A new chat starts without it, the
model has zero knowledge of todos. Toggling the per-tab switch enables
the tool surface and reveals a sidebar panel.

---

## 2. Locked-in decisions

| #  | Question                                                | Decision                                                                                                       | Locked on  |
| -- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| D1 | State persistence model                                 | **Branch replay**: tool returns full snapshot in `details`; replay walks branch and takes latest `todo` entry. | 2026-05-09 |
| D2 | External storage                                        | None. State lives entirely in the conversation.                                                                | 2026-05-09 |
| D3 | Per-tab vs global                                       | Per-tab (each `PiSessionManager` has its own branch and own store).                                            | 2026-05-09 |
| D4 | Default state for new tabs                              | Toggle OFF. Model must not know about todo until user opts in.                                                 | 2026-05-09 |
| D5 | Tool registration                                       | **Static** — the tool is registered with Pi at session-init, always.                                           | 2026-05-09 |
| D6 | Visibility to model when toggle OFF                     | Tool is hidden from the model via `session.setActiveTools(...)` — it is registered but not in the active set.  | 2026-05-09 |
| D7 | System-prompt injection                                 | None. The tool description + promptGuidelines are the only ToDo-related context shown to the model.            | 2026-05-09 |
| D8 | Behaviour on toggle OFF                                 | Hide sidebar panel. State is **not** wiped — re-enable restores it.                                            | 2026-05-09 |
| D9 | Sidebar panel visibility                                | Only when there is an active session. Empty launcher state → no panel.                                         | 2026-05-09 |
| D10 | Toggle behaviour during streaming                      | Toggle UI is disabled (greyed out) between `agent_start` and `agent_end`. Click is ignored.                    | 2026-05-09 |
| D11 | Schema scope for v1                                    | Adopt rpiv-todo schema **minus** `metadata` and `owner`. Add later if there is real demand.                    | 2026-05-09 |

---

## 3. Architecture summary

### Persistence by branch replay

Every successful `todo` tool call returns:

```jsonc
{
  "content": [{ "type": "text", "text": "Created #3: Research X (pending)" }],
  "details": {
    "action": "create",
    "params": { ... },
    "tasks": [ /* full snapshot */ ],
    "nextId": 4
  }
}
```

The `details.tasks` array is the **complete current state**, not a diff.
On `session_start`, `session_compact`, or branch switch, we walk
`session.sessionManager.getEntries()` (or whatever Pi exposes on the
branch), find the last entry with `toolName === "todo"`, and
`replaceState(entry.details)` into our in-memory store. If there is no
matching entry, state starts empty.

This gives compaction-survival, branch-switch-survival, and
VS-Code-restart-survival as a single mechanism. Pi SDK already persists
session entries to `~/.pi/agent/sessions/*.jsonl`, so tool-results
survive across restarts; we just need to replay them.

### Visibility gating

Tool is registered statically when the session is created. Visibility is
controlled per-session via `session.setActiveTools(tools)`:

- Toggle OFF (default): `setActiveTools(allTools.filter(t => t !== 'todo'))`.
  The model never sees the tool description, never knows it exists.
- Toggle ON: `setActiveTools(allTools)`. Model sees the tool with full
  description + promptGuidelines.

> ⚠️ **Verification needed before PR4**: confirm `setActiveTools` actually
> hides the tool on the next turn after a mid-conversation call. If the
> tool list is cached or computed only at create-time, fall back to
> recreating the `AgentSession` with a different `allowedToolNames`.

### Sidebar UI

Per-tab state in `TabState`:

```ts
interface TabState {
    // existing fields...
    todoEnabled: boolean;     // default false; persisted in workspaceState
    todos?: TaskState;        // last snapshot, pushed from extension host
}
```

The sidebar webview renders a collapsible "ToDo (N)" section between the
chat header and the History panel — only when:

- there is an active session in this tab, **and**
- `todoEnabled === true` for the active tab.

Status glyphs (HTML equivalents of rpiv-todo's `STATUS_GLYPH`):

- `○` pending (dim)
- `◐` in_progress (warning, optional pulse animation)
- `✓` completed (success, strikethrough)
- `⊘` deleted (muted, only when `includeDeleted:true` requested by the
  model — usually not shown in the panel)

---

## 4. Implementation plan

Four PRs, sized so each is independently shippable and reviewable. Boxes
get ticked as work lands.

### PR 1 — Core: reducer + replay + types + tests ✅
**Goal:** pure algorithm, isolated, no Pi-session integration. Lays the
foundation everything else builds on.

- [x] Add `typebox: ^1.1.33` to `dependencies` (production — used at
      runtime by `pi.registerTool`). Verify hoisted version matches.
- [x] `src/pi/todo/types.ts` — `Task`, `TaskStatus`, `TaskAction`,
      `TaskState`, `TaskDetails`, `TaskMutationParams`, `TodoParamsSchema`
      (TypeBox). LLM-facing copy stays English.
- [x] `src/pi/todo/invariants.ts` — `VALID_TRANSITIONS` table and
      `isTransitionValid()`.
- [x] `src/pi/todo/task-graph.ts` — `detectCycle()`, `deriveBlocks()`.
- [x] `src/pi/todo/reducer.ts` — `applyTaskMutation(state, action,
      params): { state, op }`. Pure function, copy of rpiv-todo's
      reducer minus `metadata` and `owner`.
- [x] `src/pi/todo/replay.ts` — `replayFromBranch(branchEntries)`. ~30
      lines, defensive against malformed entries.
- [x] `src/test/unit/pi/todo/reducer.test.ts` — golden cases per action,
      transition legality, cycle detection. **26 tests, all green.**
- [x] `src/test/unit/pi/todo/replay.test.ts` — fixture branches.
      **13 tests, all green.**
- [x] `npm run test:unit` green. Full suite: **64/64 passed**, no
      regressions.
- [x] `npm run compile` green (esbuild end-to-end).

### PR 2 — Tool registration + lifecycle wiring ✅
**Goal:** the tool becomes callable by the model end-to-end. No UI yet.

- [x] `src/pi/todo/store.ts` — per-`PiSessionManager` `TodoStore` class
      with `getState()`, `replaceState()`, `commit()`, plus `subscribe`
      / `notify` for change notifications.
- [x] `src/pi/todo/response-envelope.ts` — `formatContent(op, state)`
      and `buildToolResult(...)`. Adopted from rpiv-todo.
- [x] `src/pi/todo/tool.ts` — `registerTodoTool(api, store)`: registers
      the tool with description + 7 promptGuidelines (adopted verbatim
      from rpiv-todo with attribution comment). `execute()` runs the
      reducer, commits to the store, returns `{content, details}`.
- [x] `src/pi/todo/extension.ts` — `createTodoExtension(store)` factory
      returning a `(pi: ExtensionAPI) => void`. Wires:
      - `session_start`: `replay → replaceState`.
      - `session_compact`: same.
      - `session_tree`: same (for branch switching).
      Mirrors `src/pi/codex-monitor.ts:18` pattern.
- [x] `src/pi/session.ts`: instantiate `TodoStore` as
      `PiSessionManager.todoStore`, plug `createTodoExtension` into the
      extension factory list passed into `DefaultResourceLoader`.
- [x] **Default-OFF visibility**: added `setTodoVisibility(visible)`
      method on `PiSessionManager`. Called once with `false` after
      session create — the tool is registered but excluded from the
      active set, so the model sees no schema and no promptGuidelines
      until PR4 wires the toggle.
- [x] `npm run compile` green.
- [x] `npm run test:unit` green (64/64, no regressions).
- [x] CHANGELOG entry added under `[Unreleased] → Added`.

> **PR-2 verification gate (verified 2026-05-09):**
> `AgentSession.setActiveToolsByName` mutates `agent.state.tools` and
> rebuilds the system prompt with the new tool set's `promptSnippet` +
> `promptGuidelines`. Doc comment promises "Changes take effect on the
> next agent turn." See `agent-session.js:552`. No session recreate
> needed.

### PR 3 — Sidebar panel + protocol + per-tab snapshot push ✅
**Goal:** the panel exists, lives above History in the launcher
sidebar, updates in real time. Toggle does not yet work — visibility
is gated only by "is there an active panel"; PR4 adds the per-tab
toggle.

> Architecture note: the panel lives in the **launcher** webview
> (`src/webview/launcher.ts`), not in per-tab chat panels. The launcher
> already shows whatever belongs to the active tab and pushes its full
> state on every change, so adding the todo snapshot to `LauncherState`
> avoids inventing a new push channel.

- [x] `src/shared/protocol.ts`: added `TaskStatus`, `TaskInfo`,
      `TodoSnapshot` as cross-boundary types; added optional
      `todos?: TodoSnapshot` to `LauncherState`. No new message types
      needed — the existing `launcherState` push carries it.
- [x] `src/pi/todo/types.ts`: re-export `TaskStatus` / `TodoSnapshot`
      from protocol so internal modules import from one place. Tests
      still green.
- [x] `src/controllers/chat-controller.ts`:
      - `_subscribeTab`: subscribe to `tab.session.todoStore.subscribe(...)`,
        fire `_onLauncherStateChanged` when the active tab's store
        changes.
      - `computeLauncherState`: read active tab's `todoStore.getState()`
        and include it as `todos`. Surface only when the tab has an
        open editor panel (matches the rest of `LauncherState` —
        bare placeholder tabs do not appear).
- [x] `src/webview/launcher.ts`:
      - Render `ToDo` section between toolbar and History when
        `state.todos` is present.
      - Status glyphs `○ ◐ ✓` (mirror of rpiv-todo's `STATUS_GLYPH`).
      - Display order: in_progress → pending → completed; tombstones
        hidden.
      - Empty-state: "No tasks yet."
      - Scroll cap: `max-height: 240px` so the section never starves
        History.
- [x] `src/webview/styles/launcher.css`: `todo-section` / `todo-list` /
      `todo-row` / `todo-glyph` / `todo-blocked` rules. All colours via
      VS Code CSS variables (`--vscode-charts-yellow`,
      `--vscode-charts-green`, `--vscode-descriptionForeground`,
      `--vscode-list-hoverBackground` …). No hardcoded values.
- [x] `npm run compile` green.
- [x] `npm run test:unit` green (64/64).

> **Smoke testing:** because PR2 left the tool default-OFF (model never
> sees it), the panel will render "No tasks yet." until PR4 wires the
> toggle. Visual end-to-end testing happens in PR4.

### PR 4 — Toggle, gating, streaming guard, persistence ✅
**Goal:** the five locked-in behaviours go live.

- [x] **Verification gate** for `setActiveTools` mid-session — done in
      PR2 prep. See section 6.
- [x] Per-tab toggle state, persisted in
      `vscode.ExtensionContext.workspaceState` keyed by `sessionPath`
      (matches the existing tab-persistence key). Default `false`.
- [x] On `_subscribeTab` (initial tab + every `_createTab` +
      `restorePersistedTabs`): read persisted value, call
      `tab.session.setTodoVisibility(true)` if the tab was previously
      enabled. Sessions where the tool was OFF stay OFF — the model
      sees no schema and no promptGuidelines until the user opts in.
- [x] On toggle flip from the launcher: persist the new value, call
      `setTodoVisibility(...)` to update the active-tools surface for
      the next turn, fire `_onLauncherStateChanged` so the launcher
      re-renders.
- [x] State (in-memory `TaskState`) is left alone on toggle OFF —
      the snapshot keeps living in the conversation branch, and
      toggling ON later restores it via the same replay path.
- [x] Sidebar webview (`launcher.ts`):
      - Toggle (small VS Code-themed switch) inside the ToDo section
        heading, pushed to the right.
      - List body visible only when `todoEnabled === true`. When OFF,
        only the heading + toggle render — preserving "section visible
        as long as there is an active panel" without leaking task
        content.
      - Whole section hidden when there is no active panel
        (`state.todos === undefined`).
      - Toggle greyed (`opacity: 0.55`, `cursor: not-allowed`,
        `disabled` attribute set) while the active tab is streaming
        or compacting. Click ignored both in the webview handler and
        in the controller (`_isTabBusy` guard in
        `setActiveTabTodoEnabled`).
      - Tooltips: enable / disable / "wait for the agent to finish".
- [x] Protocol: `LauncherClientMessage` gains
      `{ type: 'setTodoEnabled'; enabled: boolean }`. `LauncherState`
      gains `todoEnabled?: boolean` and `todoToggleDisabled?: boolean`,
      both surfaced only when there is an active panel.
- [x] `npm run compile` green.
- [x] `npm run test:unit` green (64/64).
- [x] CHANGELOG entry under `[Unreleased]` → `Added`.

> **Known v1 limitation**: if the user toggles ToDo ON for a brand-new
> chat *before sending the first message*, then closes VS Code, the
> toggle state is lost on restart. Reason: persistence is keyed by
> session-file path, which doesn't exist until the SDK creates the
> file (after the first prompt). One click to re-enable on restart.
> Acceptable for v1.

---

## 5. Out-of-scope for this initiative

- Slash commands like `/todos`, `/todo-clear`. Our webview does not
  currently surface `session.getCommands()` and the panel covers the
  same UX need.
- Localization of the panel UI. English-only for v1.
- Per-task `metadata` field. Skipped per D11; revisit if needed.
- Per-task `owner`. Skipped per D11; only relevant in multi-agent
  scenarios (subagents) which are not yet bundled.
- Cross-tab linking ("task #3 in tab A blocks task #1 in tab B"). Each
  tab is a fully isolated todo space.

---

## 6. Open risks and watch items

- ~~**`setActiveTools` mid-session behaviour**~~ — **verified ✅**
  (2026-05-09). `AgentSession.setActiveToolsByName(toolNames)` mutates
  `agent.state.tools` and rebuilds the base system prompt with the new
  tool set's `promptSnippet` + `promptGuidelines`. Doc comment promises
  "Changes take effect on the next agent turn." See
  `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:552`.
  No session recreate needed. Triplet `getActiveToolNames()` /
  `getAllTools()` / `setActiveToolsByName()` is all on the public
  `AgentSession` surface.
- **Pi SDK upstream may rename `getBranch()`** — already happens
  inconsistently in the SDK. Replay code must defensively handle missing
  methods and return `EMPTY_STATE`.
- **Branch replay cost** is O(messages) per lifecycle event. Microseconds
  for normal sessions but worth a benchmark if a user reports slowness
  with very long sessions.
- **Tool description budget**: the description + 7 promptGuidelines add
  ~300 tokens to every turn the tool is active. Acceptable, but worth
  watching the average token-per-turn metric after rollout.
