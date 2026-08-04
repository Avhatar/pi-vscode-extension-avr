# tab-registry-and-runtime

## Stance

`TabRegistry` is a two-column table: an ordered map of `id → tab` plus a nullable pointer to the active id. It does not own tab instances, does not enforce a minimum size, and does not construct or dispose anything — its whole surface is CRUD + activation. `TabRuntime` is the opposite: it owns everything a tab needs while alive (the session, the diff / checkpoint managers, timers, queues, subscriptions) and knows how to dispose them in the right order. Splitting the two lets the host reason about "the tab list" without touching per-tab plumbing, and lets tests instantiate a runtime without needing a registry at all.

## Role

[`TabRegistry<T>`](../../../../src/core/chat/tab-registry.ts#L13) exports:

- Read: `size`, `activeId`, `active`, `has(id)`, `get(id)`, `keys()`, `values()`, `entries()`, `list()`, `find(pred)` — insertion order preserved via `Map`.
- Write: `register(tab)` (does not activate), `activate(id)` (returns success bool; no-op if already active), `remove(id)` (returns `TabRemovalResult`: `{ tab, wasActive, activeId }` where `activeId` becomes the first remaining tab if the removed tab was active, else the pointer stays).

Invariants: **deterministic insertion order**; **at most one active tab**; **no ownership**. The last point matters: removing a tab from the registry does *not* dispose the underlying resources — the host is expected to do that (typically through `ChatApplication.remove`, see below).

[`TabRuntime<TSession, TDiff, TCheckpoint>`](../../../../src/core/chat/tab-runtime.ts#L38) is the per-tab state bag:

- Identity: `id`, `name`.
- Managers: `session`, `diffManager`, `checkpointManager`.
- Turn accounting: `turnCounter`, `suspendedMessages`, `streamingText`, `streamingThinking`, `isThinking`, `thinkingStartTime`, `streamingThinkingDuration`.
- Timing: `agentStartTime`, `totalTurnDurationMs`, `lastTurnEndAt`, `maxIdleGapMs`.
- Queue: `queuedMessages[]`, `queuedRetryHead`, `queuedRetryAttempts`.
- Streaming flags: `isStreamingLocal`, `isCompacting`, `errorReportedThisRun`, `hasNotification`.
- Metadata: `messageMeta: Map<ordinal, TabMessageMeta>`, `turnNotificationGate`, `pendingTools: Map<callId, PendingToolInfo>`, Codex account-window baselines, the DeepSeek session-cost baseline, `projectToolDefault`.
- Cache: `cacheEffective`.

Two lifecycle methods matter. [`addSubscription(unsub)`](../../../../src/core/chat/tab-runtime.ts#L107) collects callbacks (session listeners, diff listeners); [`unsubscribe()`](../../../../src/core/chat/tab-runtime.ts#L111) runs all of them and rethrows the first error so a single bad listener doesn't silently skip its peers. [`disposeResources()`](../../../../src/core/chat/tab-runtime.ts#L157) is the top-level teardown: unsubscribe, then dispose `session`, `diffManager`, `checkpointManager` in that order; each disposal is guarded so a failure in one doesn't skip the next.

`resetSessionProjection(projectToolDefault?, initialTurnCounter?)` at [tab-runtime.ts:131](../../../../src/core/chat/tab-runtime.ts#L131) clears streaming buffers, pending tools, message meta — used when the tab loads a different session without a full rebuild.

[`ChatApplication<TTab>`](../../../../src/core/chat/chat-application.ts#L22) is the thin coupling glue:

- `register(tab, options?)` — delegates to `tabs.register`; activates if requested.
- `activate(tabId, options?)` — delegates to `tabs.activate`; optionally clears the `hasNotification` flag.
- `remove(tabId)` — calls `tab.disposeResources()` first, then `tabs.remove`. This is the important ordering: dispose *before* dropping from the registry, so anything that needs to observe the disposal sees the tab still present.
- `isBusy(tab)` — `isStreamingLocal || isCompacting`.
- `getTabInfos()` — projects registered tabs to `TabInfo[]` for `SerializedAgentState.tabs`.

The `ApplicationTab` interface at [chat-application.ts:4](../../../../src/core/chat/chat-application.ts#L4) is the structural minimum: `id`, `name`, `hasNotification`, `isStreamingLocal`, `isCompacting`, `disposeResources(): Promise<void>`. Any concrete tab type must satisfy it.

## Keywords

**Types — registry:**
- `TabRegistry<T>` — [tab-registry.ts:13](../../../../src/core/chat/tab-registry.ts#L13)
- `TabRemovalResult<T>` — same file

**Types — runtime:**
- `TabRuntime<TSession, TDiff, TCheckpoint>` — [tab-runtime.ts:38](../../../../src/core/chat/tab-runtime.ts#L38)
- `TabMessageMeta` — same file; `thinkingDurationSec`, `messageEndTime`, `codexTurn?`, `deepSeekTurn?`, `turnDurationMs?`, `totalTurnDurationMs?`
- `PendingToolInfo` — [src/shared/agent-protocol.ts:107](../../../../src/shared/agent-protocol.ts#L107)
- `TurnNotificationGate` — [chat/turn-notification-gate.ts](../../../../src/core/chat/turn-notification-gate.ts)

**Types — application:**
- `ChatApplication<TTab>` — [chat-application.ts:22](../../../../src/core/chat/chat-application.ts#L22)
- `ApplicationTab` — [chat-application.ts:4](../../../../src/core/chat/chat-application.ts#L4)

**Methods — registry:**
- `register`, `activate`, `remove`, `has`, `get`, `keys`, `values`, `entries`, `list`, `find` — [tab-registry.ts](../../../../src/core/chat/tab-registry.ts)

**Methods — runtime:**
- `addSubscription(unsub)` — [tab-runtime.ts:107](../../../../src/core/chat/tab-runtime.ts#L107)
- `unsubscribe()` — [tab-runtime.ts:111](../../../../src/core/chat/tab-runtime.ts#L111)
- `resetSessionProjection(projectToolDefault?, initialTurnCounter?)` — [tab-runtime.ts:131](../../../../src/core/chat/tab-runtime.ts#L131)
- `disposeResources()` — [tab-runtime.ts:157](../../../../src/core/chat/tab-runtime.ts#L157)

**Methods — application:**
- `register(tab, options?)`, `activate(tabId, options?)`, `remove(tabId)`, `isBusy(tab)`, `getTabInfos()` — [chat-application.ts:22](../../../../src/core/chat/chat-application.ts#L22)

**Attributes / markers:**
- Insertion order preserved by `Map`; do NOT switch to `Set` or an unordered structure.
- `activeId` may legally be `undefined` when the last tab is closed.

**Namespaces:**
- [src/core/chat/tab-registry.ts](../../../../src/core/chat/tab-registry.ts)
- [src/core/chat/tab-runtime.ts](../../../../src/core/chat/tab-runtime.ts)
- [src/core/chat/chat-application.ts](../../../../src/core/chat/chat-application.ts)

## Lifecycle edges

**Depends on:**
- [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — the host constructs and manages the registry and per-tab runtimes; the service reads / mutates them per event.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — `TabRuntime.session` is a `PiSessionManager` whose disposal semantics originate there.
- [Part VII § file-change-tracking](../../07-safety-and-reversibility/file-change-tracking/file-change-tracking.md) — `TabRuntime.diffManager` and `TabRuntime.checkpointManager` are declared there.

**Used by:**
- [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — the tab structures the host and service operate on.

## See also

- **Rule — dispose before drop.** `ChatApplication.remove` calls `disposeResources()` *before* `tabs.remove`. Reversing the order means anything that iterates the registry during disposal (a listener listing sibling tabs, say) sees the tab already gone. Do not restructure.
- **Rule — `unsubscribe()` rethrows the first error.** Do not swallow. If one subscription's disposal fails, subsequent ones still run, but the caller learns about it. Swallowing masks resource leaks.
- **Pattern — insertion order is the canonical presentation order.** UI code that renders tabs (launcher, tab bar) should iterate `entries()` and trust the ordering. Do not re-sort at the UI layer.
- **Pattern — `resetSessionProjection` is not `disposeResources`.** It clears transient state so the same tab can host a different session (e.g. `loadSession` from history). The managers (`session`, `diffManager`, `checkpointManager`) are recreated externally by the host after this call; the runtime does not.
- **Pitfall — do not race active-tab pointer changes with UI updates.** The active pointer may transiently become `undefined` between `remove` and the next `activate`. UI code must handle the null case.
- **Pattern — every `Map`-backed field starts empty and grows only within one tab.** No cross-tab sharing. Never introduce a static map indexed by session path.
