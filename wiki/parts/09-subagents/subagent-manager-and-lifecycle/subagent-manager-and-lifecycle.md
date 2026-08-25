# subagent-manager-and-lifecycle

## Stance

Three concurrency gates protect the system. **Per-parent maxConcurrentRuns** (default 2) prevents a single parent from monopolizing child slots. **Global `SubagentCoordinator`** (default 4) prevents a burst of parents from oversubscribing the machine. **Bounded terminal retention** (default 10 minutes, 20 slots LRU) keeps recent finished runs visible so the user can inspect them without letting the accumulation grow without bound. All three are configurable via `pi-code.subagents.*` settings.

## Role

[`SubagentManager`](../../../../src/pi/subagents/manager.ts#L52) is the top-level orchestrator:

- Tracks `runs: Map<agentId, SubagentRun>` and `activeRuns: Map<agentId, AbortController>`.
- Default `maxConcurrentRuns = 2` per parent (see `pi-code.subagents.maxConcurrentPerChat`).
- `runForeground(invocation)` [manager.ts:134](../../../../src/pi/subagents/manager.ts#L134) — creates `agentId` via `createAgentId()`, records status `queued`, calls `launchRun()` when scheduling permits.
- `runBackground(invocation)` [manager.ts:161](../../../../src/pi/subagents/manager.ts#L161) — returns the persistent agentId immediately, spawns async with `onBackgroundSettled` callback so the parent can flush a notification.
- `scheduleParent()` + `pumpParentQueue()` [manager.ts:517](../../../../src/pi/subagents/manager.ts#L517) — parent-level rate limiting; abort-signal aware.
- `retainTerminalRun(agentId, enforceCap?)` [manager.ts:680](../../../../src/pi/subagents/manager.ts#L680) — setTimeout for `terminalRetentionMs` (default 10 min); LRU eviction at `maxRetainedTerminalRuns` (default 20). `enforceCap: false` arms only the timer, for a row rehydrated from storage.
- `resolveRun(agentId)` [manager.ts:221](../../../../src/pi/subagents/manager.ts#L221) — returns a run from memory, or pulls its record back through the `loadRun` option and re-adopts it. Every lifecycle action resolves through here.

[`SubagentCoordinator`](../../../../src/pi/subagents/coordinator.ts#L8) — global gate:

- `maxConcurrency = 4` default (see `pi-code.subagents.maxConcurrentGlobal`).
- `schedule(op, signal)` [coordinator.ts:28](../../../../src/pi/subagents/coordinator.ts#L28) — acquires a slot, combines external + shutdown signals, runs `op()`, releases.
- `acquire()` [coordinator.ts:53](../../../../src/pi/subagents/coordinator.ts#L53) — synchronous slot grant if room, else enqueue Promise.

[`ChildSessionHandle`](../../../../src/pi/subagents/runtime.ts#L22) — the contract the manager holds against a live child:

- `subscribe(listener)` — child event stream (turn-ended, tool-started/ended, retrying, permission-wait, completion).
- `prompt(text)`, `steer(text)`, `abort()`.
- `getCompletion()`, `getLastAssistantText()` — final result access.

Executing a run [manager.ts:323](../../../../src/pi/subagents/manager.ts#L323):

1. Prepare write lease via [`WriteIsolationManager`](../../../../src/pi/subagents/write-isolation.ts).
2. `factory.create(spec)` (or `factory.resume(spec, transcriptPath, context)` to continue an existing child) → `ChildSessionHandle`.
3. Subscribe to child events; on `tool-started` / `tool-ended`, emit `onMutationEvent` with namespaced tool-call ids so parent-level file tracking sees them. The same channel carries the child's tool wall-clock time to the parent's turn accounting.
4. Enforce timeout via `AbortController`.
5. On completion, populate `SubagentRun.result`, retain terminally, persist.

Turn-budget handling [manager.ts:364](../../../../src/pi/subagents/manager.ts#L364) is a two-stage wind-down, because a hard stop at the ceiling used to discard the whole run:

- **One turn left** — when `spec.maxTurns - turnCount === 1` and the child is still calling tools, the manager steers it once with `windDownMessage(...)` [manager.ts:26](../../../../src/pi/subagents/manager.ts#L26): stop investigating, call `complete_subagent` now with whatever you have. `ActiveRun.windDownSent` keeps it to a single nudge. The child cannot see its own turn accounting, so without this it has no way to know it is about to be cut off.
- **Budget spent** — the run is aborted with reason `max-turns`. The resulting `SubagentRunError` carries `partialResult` (the child's last assistant text), and [`describeSubagentFailure`](../../../../src/pi/subagents/runtime.ts#L106) appends it to the parent-facing failure so a stranded child's work is recoverable instead of being re-run from scratch. Every termination reason — `timeout`, `cancelled`, `runtime-error`, `incomplete` — carries the same salvage, not only `max-turns`.

`describeSubagentFailure` is the single formatter for both delivery paths: `withSalvagedPartial` [tool.ts:205](../../../../src/pi/subagents/tool.ts#L205) rethrows the described failure for foreground `spawn` / `resume` / lifecycle calls, and `_deliverBackgroundSubagentNotification` uses it for the notification body when a background child settles as failed. The salvaged tail is bounded by `PARTIAL_RESULT_LIMIT` (8000 chars) so a stranded child cannot flood the parent context with its transcript. When there is nothing to salvage the function returns `error.message` unchanged, which is how `withSalvagedPartial` knows to rethrow the original error object rather than wrap it.

[`describeSubagentResult`](../../../../src/pi/subagents/runtime.ts#L134) is its success-path counterpart, and it exists because `SubagentToolDetails` is invisible to the model. A finished child's `agentId` and preserved worktree used to live only in the tool call's `details`, which the chat UI renders but the model never reads — so the parent was told to call `review` before `apply` while having no sanctioned way to learn either the id to pass or that an isolated checkout existed at all. The observed failure mode was a parent that located worktrees by hand and dispatched shared-workspace writers into a sibling's checkout. The formatter appends a short `Subagent handle:` trailer naming `agentId`, model, and turn count, and for an isolated child additionally names the worktree, states that its edits are not in the workspace yet, and points at `review` → `apply` → `cleanup`. It is applied on foreground `spawn` [tool.ts:197](../../../../src/pi/subagents/tool.ts#L197) and on `resume` [session.ts:1330](../../../../src/pi/session.ts#L1330); the background notification carries the same worktree lines inline, which matters most there because write-capable background children are *required* to run isolated. The trailer is deliberately two to four lines: it is paid for on every delegation.

`SubagentForegroundResult.isolationPath` [runtime.ts:53](../../../../src/pi/subagents/runtime.ts#L53) is what carries the worktree out of the manager to make that possible — the manager copies it from `SubagentRun.isolationPath` when building the result [manager.ts:512](../../../../src/pi/subagents/manager.ts#L512).

`resumeForeground` [manager.ts:263](../../../../src/pi/subagents/manager.ts#L263) is how a parent continues an existing child instead of paying a fresh one to rediscover everything, and it reuses the child's *own session* rather than replaying a transcript into a new one: `PiChildSessionFactory.resume` calls `SessionManager.open(transcriptPath)`, so the child keeps its accumulated conversation and the follow-up task arrives as the next user message. The spec is reused verbatim [manager.ts:277](../../../../src/pi/subagents/manager.ts#L277) — same model, instructions, tools, and `maxTurns`; only `task` changes, and a `maxTurns` passed on the resume call itself is ignored. **The turn budget starts over** (`turnCount: 0` [manager.ts:291](../../../../src/pi/subagents/manager.ts#L291)), which makes resume the sanctioned answer to a child that hit `max-turns`: it gets a full budget back with everything it had worked out intact. The terminal retention timer is cleared [manager.ts:293](../../../../src/pi/subagents/manager.ts#L293), so each resume also renews the row's retention window.

Resume does not depend on that window. `resumeForeground` and `_executeSubagentControl` both resolve the id through `resolveRun`, which falls back to the `loadRun` option — `SubagentRunStore.get` — when the row has already been evicted from memory. This matters because the two lifetimes were never reconciled: a child may run for 30 minutes by default while a *finished* sibling's row is dropped after 10, so any `implementer → long reviewer → resume implementer` chain outlived its own handle and failed with `Unknown or stale subagent id`. Since the record carries the run and its `definitionSnapshot`, nothing was actually lost — it was being looked for in the wrong place. Rehydration normalises a stored status that still claims to be active (only a dead host can leave one), refuses a `dismissed` record, and re-arms the retention timer with `enforceCap: false` so the LRU sweep, which orders by `finishedAt`, cannot evict the older row the caller just asked for.

For a write-capable worktree child the recorded `SubagentRun.isolationPath` is passed through the resume context so the runtime *reattaches* that worktree instead of rebuilding it. Preconditions, each failing explicitly: the run and its spec must be resolvable from memory or durable storage, `run.transcriptPath` must be set, the run must not already be active, the factory must implement `resume`, and any recorded worktree must pass the strict reattachment checks. Resume is foreground-only — there is no background resume — and restored records repopulate `runs` and `runSpecs` in the constructor [manager.ts:114](../../../../src/pi/subagents/manager.ts#L114), while `resolveRun` rehydrates a row after its in-memory retention window, so resumability is bounded by the stored record rather than the cache.

The completion is read *before* the abort is honoured [manager.ts:466](../../../../src/pi/subagents/manager.ts#L466). A child that called `complete_subagent` on its final turn has already delivered, and the budget abort or a user stop can land in the same tick; checking the abort first would fail a finished run.

`SubagentRun` [types.ts:135](../../../../src/pi/subagents/types.ts#L135) — the durable record:

- `agentId`, `parentSessionId`, `parentTabId`
- `name`, `status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'timed-out'`
- `model` (resolved), `turnCount`
- Timing: `queuedAt`, `startedAt`, `finishedAt`
- `currentTool`, `activity`, `error`, `result`

[`SubagentRunStore`](../../../../src/pi/subagents/persistence.ts#L8) — persists to disk under `<storageRoot>/subagents/records` and `<storageRoot>/subagents/transcripts`. Version 1. Cleanup wired into `deleteHistorySession` via `_subagentStore.deleteByParentSessionPath`.

Mutation routing [mutations.ts:1](../../../../src/pi/subagents/mutations.ts#L1) — `routeSubagentMutation`: if `isolationPath` is set (worktree mode), returns `'worktree'`; otherwise it calls `sink.handleExternalToolEvent()` for shared-workspace mode. Timing is a second, unconditional consumer of the same event: `ChatController` calls `ChatService.recordSubagentToolEvent` for every child tool event regardless of isolation mode, then routes the mutation. `DiffManager` preserves the child `agentId` as `FileChangeInfo.subagentAgentId`, keeping the edit available in File Undo View while the parent chat suppresses per-child inline diff cards.

`namespaceChildToolCallId(agentId, toolCallId)` [manager.ts:623](../../../../src/pi/subagents/manager.ts#L623) — concatenates so parent-level tracking distinguishes children's tool calls.

## Keywords

**Types — manager:**
- `SubagentManager` — class [manager.ts:52](../../../../src/pi/subagents/manager.ts#L52)
- `SubagentRun` — [types.ts:135](../../../../src/pi/subagents/types.ts#L135)
- `SubagentRunStore` — [persistence.ts:8](../../../../src/pi/subagents/persistence.ts#L8)

**Types — coordinator:**
- `SubagentCoordinator` — class [coordinator.ts:8](../../../../src/pi/subagents/coordinator.ts#L8)

**Types — runtime:**
- `ChildSessionEvent` — union [runtime.ts:14](../../../../src/pi/subagents/runtime.ts#L14)
- `ChildSessionHandle` — [runtime.ts:22](../../../../src/pi/subagents/runtime.ts#L22)
- `ChildSessionFactory` — [runtime.ts:36](../../../../src/pi/subagents/runtime.ts#L36); `.create()` + optional `.resume()`, whose context carries `isolationPath?` for worktree reattachment
- `SubagentForegroundResult` — [runtime.ts:47](../../../../src/pi/subagents/runtime.ts#L47); carries `agentId`, `model`, `turnCount`, `truncated`, `isolationPath?`
- `SubagentRunError` — [runtime.ts:78](../../../../src/pi/subagents/runtime.ts#L78); carries `reason`, `agentId`, `partialResult`
- `describeSubagentFailure(error)` — [runtime.ts:108](../../../../src/pi/subagents/runtime.ts#L108); shared salvage formatter
- `describeSubagentResult(result)` — [runtime.ts:134](../../../../src/pi/subagents/runtime.ts#L134); success-path handle formatter (`agentId` + worktree into model-visible text)
- `PARTIAL_RESULT_LIMIT` — [runtime.ts:93](../../../../src/pi/subagents/runtime.ts#L93)

**Methods — manager:**
- `runForeground(invocation)` — [manager.ts:134](../../../../src/pi/subagents/manager.ts#L134)
- `runBackground(invocation)` — [manager.ts:161](../../../../src/pi/subagents/manager.ts#L161)
- `retainTerminalRun(agentId, enforceCap?)` — [manager.ts:680](../../../../src/pi/subagents/manager.ts#L680)
- `resolveRun(agentId)` — [manager.ts:221](../../../../src/pi/subagents/manager.ts#L221)
- `namespaceChildToolCallId(agentId, toolCallId)` — [manager.ts:623](../../../../src/pi/subagents/manager.ts#L623)

**Methods — coordinator:**
- `schedule(op, signal)` — [coordinator.ts:28](../../../../src/pi/subagents/coordinator.ts#L28)
- `acquire()` / release semantics — [coordinator.ts:53](../../../../src/pi/subagents/coordinator.ts#L53)

**Methods — mutation routing:**
- `routeSubagentMutation(event, sink)` — [mutations.ts:1](../../../../src/pi/subagents/mutations.ts#L1)

**Methods — launcher projection:**
- `projectSubagentLauncherSnapshot(snapshot)` — [launcher-state.ts:16](../../../../src/pi/subagents/launcher-state.ts#L16)

**Attributes / markers:**
- Default global concurrency: `4` (`pi-code.subagents.maxConcurrentGlobal`)
- Default per-parent concurrency: `2` (`pi-code.subagents.maxConcurrentPerChat`)
- Default terminal retention: 10 minutes, 20-slot LRU — an in-memory cache policy only; a handle stays usable for the stored record's 30 days
- Default maxTurns: `60` (no host ceiling), default timeoutMinutes: `30` (host ceiling `120`)
- One turn is one child assistant step, counted per `turn-ended` — a tool call costs a turn
- Wind-down steer fires once, one turn before the budget is spent; every failure reason carries `partialResult`
- Salvaged tail bound: `PARTIAL_RESULT_LIMIT` = 8000 chars, then `… salvaged output truncated …`
- Status values: `queued | running | completed | failed | aborted | timed-out`

**Namespaces:**
- [src/pi/subagents/manager.ts](../../../../src/pi/subagents/manager.ts)
- [src/pi/subagents/coordinator.ts](../../../../src/pi/subagents/coordinator.ts)
- [src/pi/subagents/runtime.ts](../../../../src/pi/subagents/runtime.ts)
- [src/pi/subagents/persistence.ts](../../../../src/pi/subagents/persistence.ts)
- [src/pi/subagents/mutations.ts](../../../../src/pi/subagents/mutations.ts)
- [src/pi/subagents/launcher-state.ts](../../../../src/pi/subagents/launcher-state.ts)

## Lifecycle edges

**Depends on:**
- [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md) — spec resolution feeds the manager.
- [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md) — write lease is prepared before child creation.
- [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md) — child tool factories, model refs, gating.
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `pi-code.subagents.*` settings.
- [Part VI § launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md) — launcher renders `LauncherSubagentSnapshot`.

**Used by:**
- [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md) — the consumer of `resolveAgentSpec` output.
- [launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md) — subagent snapshots surfaced in the launcher.
- [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md) — the manager instantiates these pieces.
- [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md) — `prepare()` is called before child creation; `release()` is called on child settlement.

## See also

- **Rule — background writes require worktree isolation.** [`write-isolation.ts:45`](../../../../src/pi/subagents/write-isolation.ts#L45) throws otherwise. Background = the parent doesn't see the child's edits in real time; without a worktree, races become invisible.
- **Rule — terminal retention is bounded.** Do not remove the setTimeout or the LRU cap; unbounded retention will grow the runs Map until the launcher renders slowly.
- **Pattern — namespaced tool-call ids.** `<agentId>:<toolCallId>` keeps parent-level tracking (DiffManager, CheckpointManager) from confusing sibling children's edits. Do not shorten.
- **Pattern — the parent turn summary reports delegated time separately.** The parent books its own `subagent` tool call, which for a foreground spawn covers the child's run and for a background spawn covers almost nothing. Per-run wall clock, outcome, and child tool time therefore live in their own section of the turn breakdown rather than being merged into the parent tool rows. See [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md).
- **Pattern — aggregate foreground waiting in chat.** Once the parent has no other tool running, pending foreground `spawn` and `resume` calls are counted into one terminal "Waiting for N subagents" indicator; background spawns and lifecycle controls are excluded. Individual child activity remains in the launcher, and child edits remain reviewable without becoming inline chat noise.
- **Pattern — coordinator signal composition.** `schedule(op, signal)` combines the caller's abort signal with the coordinator's shutdown signal — either abort cancels the operation cleanly.
- **Pitfall — a turn ceiling that hard-aborts throws away the whole run.** Before the wind-down, ~96% of observed child failures were `max-turns`, every one at `turnCount === maxTurns + 1` (the abort is async, so one further `turn_end` still lands). The parent got a one-line reason and no output, and re-spawned the same task with a bigger number. Keep the wind-down steer and `partialResult` salvage together — either alone leaves the expensive half of the problem in place.
- **Pitfall — a new failure-delivery path silently loses the salvage.** `withSalvagedPartial` only wraps the synchronous tool call, which for a background spawn returns the moment the run is queued; the real failure arrives much later through `onBackgroundSettled`. That path carried only `error.message` until `describeSubagentFailure` was applied to it as well, so the parent was told why a background child stopped but not what it had already produced. Any future settle, resume-notification, or cross-window delivery route must run the error through the same formatter — `SubagentRunError.partialResult` is not part of `message` and is dropped by anything that reads only the message.
- **Pitfall — abort mid-execution races persistence.** The `persist()` chain [manager.ts:599](../../../../src/pi/subagents/manager.ts#L599) is serialized in a Promise tail; aborting during a persist call does not corrupt the file. Do not add "fast abort" shortcuts.
- **Pattern — background completion notifications are buffered, then re-ordered for display.** `_deliverBackgroundSubagentNotification` [session.ts:1375](../../../../src/pi/session.ts#L1375) appends a `pi-code.subagent-notification` custom message whose body is the delivered result, or the salvaged failure description for a failed child, but only when the parent is idle; while the parent streams they queue in `_pendingBackgroundNotifications` and flush on `agent_end`. That buffering is mandatory — the entry participates in the LLM context and would otherwise split an assistant message from its tool results. The cost is that a child which settled mid-turn is appended after the parent's final message, so the notification carries `details.finishedAt` and the chat places the card by that time instead. See [Part VI § webview-architecture](../../06-ui-surfaces-webview/webview-architecture/webview-architecture.md).
- **Pitfall — `runBackground` returns before spawning.** The caller gets the persistent agentId; the actual spawn happens async. If the parent needs to serialize on child spawn, wait on the state transition to `running`, not on the function return.
- **Pattern — `SubagentRunStore` cleanup rides `deleteHistorySession`.** When the parent session is deleted, its subagent records are wiped by `deleteByParentSessionPath`. Do not add a separate garbage collector.
