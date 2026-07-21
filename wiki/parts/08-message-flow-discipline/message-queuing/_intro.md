# Chapter: message-queuing

Users type faster than agents respond. When a message is submitted while the agent is streaming, Pi Code queues it in the tab's `queuedMessages` array and dispatches automatically when the current turn *settles*. Not when it ends — settlement is a distinct SDK event that fires after `agent_end` and after any post-turn housekeeping (compaction, background writes) completes. Dispatching earlier would be rejected by the SDK's own busy check, so the queue would silently drop the message.

## Article roster

- [message-queuing](message-queuing.md) — `queuedMessages` state on `TabRuntime`, `applyQueueControl` command handler, `reserveQueuedDispatch` / `dispatchNextQueued` gates, and the `agent_settled` invariant.

## Reader task

The reader arrives here to answer one of:

- "What happens if I type three messages while the agent is streaming?"
- "Can I edit or remove a queued message before it dispatches?"
- "Why is the queue tied to `agent_settled`, not `agent_end`?"
- "What's the difference between queuing and steering?"

## Neighborhood

- **The turn lifecycle** — start / stream / end / settle — is documented in [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md) and [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
- **Steering** — mid-stream injection — is the sibling chapter [steering](../steering/steering.md); the two mechanisms coexist but do different things.
- **Event classification** that gates queue dispatch on terminal events is [Part III § chat-event-policy](../../03-portable-chat-core/chat-event-policy/chat-event-policy.md).

## Non-goals

- Message ordering across tabs — each tab has its own queue; there is no global ordering.
- Retry policy for network failures at the SDK level — that's the SDK's concern.
- Undo / redo of queued messages — the user can remove or edit, but there is no history stack.
