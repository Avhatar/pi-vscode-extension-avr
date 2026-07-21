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
- `retainTerminalRun(agentId)` [manager.ts:575](../../../../src/pi/subagents/manager.ts#L575) — setTimeout for `terminalRetentionMs` (default 10 min); LRU eviction at `maxRetainedTerminalRuns` (default 20).

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
2. `factory.create(spec)` (or `factory.resume(runId)` for transcript replay) → `ChildSessionHandle`.
3. Subscribe to child events; on `tool-started` / `tool-ended`, emit `onMutationEvent` with namespaced tool-call ids so parent-level file tracking sees them.
4. Enforce timeout via `AbortController`.
5. On completion, populate `SubagentRun.result`, retain terminally, persist.

`SubagentRun` [types.ts:135](../../../../src/pi/subagents/types.ts#L135) — the durable record:

- `agentId`, `parentSessionId`, `parentTabId`
- `name`, `status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'timed-out'`
- `model` (resolved), `turnCount`
- Timing: `queuedAt`, `startedAt`, `finishedAt`
- `currentTool`, `activity`, `error`, `result`

[`SubagentRunStore`](../../../../src/pi/subagents/persistence.ts#L8) — persists to disk under `<storageRoot>/subagents/records` and `<storageRoot>/subagents/transcripts`. Version 1. Cleanup wired into `deleteHistorySession` via `_subagentStore.deleteByParentSessionPath`.

Mutation routing [mutations.ts:1](../../../../src/pi/subagents/mutations.ts#L1) — `routeSubagentMutation`: if `isolationPath` is set (worktree mode), returns `'worktree'` code; else calls `sink.handleExternalToolEvent()` for shared-workspace mode. This is how the parent's diff / checkpoint manager sees the child's edits.

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
- `ChildSessionFactory` — [runtime.ts:36](../../../../src/pi/subagents/runtime.ts#L36); `.create()` + optional `.resume()`

**Methods — manager:**
- `runForeground(invocation)` — [manager.ts:134](../../../../src/pi/subagents/manager.ts#L134)
- `runBackground(invocation)` — [manager.ts:161](../../../../src/pi/subagents/manager.ts#L161)
- `retainTerminalRun(agentId)` — [manager.ts:575](../../../../src/pi/subagents/manager.ts#L575)
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
- Default terminal retention: 10 minutes, 20-slot LRU
- Default maxTurns: `30`, default timeoutMinutes: `10`
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
- **Pattern — coordinator signal composition.** `schedule(op, signal)` combines the caller's abort signal with the coordinator's shutdown signal — either abort cancels the operation cleanly.
- **Pitfall — abort mid-execution races persistence.** The `persist()` chain [manager.ts:599](../../../../src/pi/subagents/manager.ts#L599) is serialized in a Promise tail; aborting during a persist call does not corrupt the file. Do not add "fast abort" shortcuts.
- **Pitfall — `runBackground` returns before spawning.** The caller gets the persistent agentId; the actual spawn happens async. If the parent needs to serialize on child spawn, wait on the state transition to `running`, not on the function return.
- **Pattern — `SubagentRunStore` cleanup rides `deleteHistorySession`.** When the parent session is deleted, its subagent records are wiped by `deleteByParentSessionPath`. Do not add a separate garbage collector.
