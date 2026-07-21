# Chapter: tab-registry-and-runtime

The portable chat core keeps tabs in two layers: [`TabRegistry`](../../../../src/core/chat/tab-registry.ts) tracks *which* tabs exist and which one is active, and [`TabRuntime`](../../../../src/core/chat/tab-runtime.ts) tracks *what* is happening inside a specific tab (streaming state, queue, message metadata, subscriptions to release).

Keeping the two separate lets the host handle multi-tab bookkeeping generically (activate, remove, reorder) while per-tab lifecycle stays adjacent to the objects that own resources — the `PiSessionManager`, the `DiffManager`, the `CheckpointManager`.

## Article roster

- [tab-registry-and-runtime](tab-registry-and-runtime.md) — `TabRegistry` insertion order and activation, `TabRuntime` fields and disposal, `ChatApplication` as the wrapper coupling them, and the `ApplicationTab` shape the host expects.

## Reader task

The reader arrives here to answer one of:

- "How do tabs remember their insertion order across `Reload Window`?"
- "What happens if the active tab is closed while another tab is streaming?"
- "Where is the per-tab pending-tools map, and who clears it?"
- "How is disposal of `PiSessionManager` chained to `disposeResources()`?"

## Neighborhood

- The **host** that iterates tabs is [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md).
- The **classifier** that consumes `pendingTools` and streaming flags is [chat-event-policy](../chat-event-policy/chat-event-policy.md).
- The **manager types** the runtime hands ownership of (`session`, `diffManager`, `checkpointManager`) come from [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) and [Part VII](../../../index.md#part-vii--safety-and-reversibility).

## Non-goals

- Serialization of tab lists for `Reload Window` restore is a host-side concern; the registry only produces / consumes deterministic ordering.
- Any assumption about how many tabs are "reasonable" — the registry does not enforce a max.
- UI-facing tab-info projection (`TabInfo`) belongs to `buildState` in the sibling chapter.
