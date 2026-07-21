# event-router

## Stance

`EventRouter` exists because the SDK exposes one subscription seat per session and Pi Code needs many. Rather than layering listeners through cascading callbacks (fragile, hard to unwind), the router accepts N handlers and dispatches to all of them per event. Two properties are important. **Exception isolation**: one broken listener must not prevent delivery to peers. **Global vs. typed subscription**: some consumers (raw recorder, launcher projection) want every event; others want a specific event type; the router serves both.

## Role

The class in [src/pi/events.ts:5](../../../../src/pi/events.ts#L5) is tiny:

- `on(eventType, handler)` [events.ts:9](../../../../src/pi/events.ts#L9) — subscribes a handler for a specific event type; returns an unsubscribe function.
- `onAll(handler)` [events.ts:19](../../../../src/pi/events.ts#L19) — subscribes a wildcard handler that sees every event; returns an unsubscribe function.
- `dispatch(event)` [events.ts:24](../../../../src/pi/events.ts#L24) — iterates global handlers first, then the type-specific set; each call is wrapped in `try/catch` so exceptions do not block delivery to peers.
- `asSessionListener()` [events.ts:41](../../../../src/pi/events.ts#L41) — returns a listener suitable for `AgentSession.subscribe(listener)`. This is the shape that plugs into the SDK.
- `clear()` [events.ts:45](../../../../src/pi/events.ts#L45) — removes all handlers; used when the session is being disposed and the router should stop delivering to zombie subscribers.

Two internal maps back the design: `_handlers: Map<eventType, Set<Handler>>` for the typed listeners and `_globalHandlers: Set<Handler>` for the wildcard ones. Both are `Set`-backed so a handler cannot be subscribed twice by accident, and the unsubscribe function is idempotent.

`PiSessionManager` owns exactly one router per session. Wiring: on session creation, the manager calls `session.subscribe(router.asSessionListener())`; on session disposal, it clears the router. Subscribers survive across session replacements (session A disposed, session B created on the same tab) because the router lives on the manager, not on the SDK session.

Wildcard subscribers seen in the codebase: the launcher projection (fires state re-render), the raw recorder (persists every event as a JSONL row), and — inside `PiSessionManager` itself — a global handler that flushes subagent notifications when `agent_end` arrives.

## Keywords

**Types:**
- `EventRouter` — class [events.ts:5](../../../../src/pi/events.ts#L5)
- `EventHandler` — `(event: AgentSessionEvent) => void` [events.ts:3](../../../../src/pi/events.ts#L3)
- `AgentSessionEvent` — SDK-owned union; the router does not enumerate its members
- `AgentSessionEventListener` — SDK-owned; result of `asSessionListener()`

**Methods:**
- `on(eventType, handler): () => void` — [events.ts:9](../../../../src/pi/events.ts#L9)
- `onAll(handler): () => void` — [events.ts:19](../../../../src/pi/events.ts#L19)
- `dispatch(event): void` — [events.ts:24](../../../../src/pi/events.ts#L24)
- `asSessionListener(): AgentSessionEventListener` — [events.ts:41](../../../../src/pi/events.ts#L41)
- `clear(): void` — [events.ts:45](../../../../src/pi/events.ts#L45)

**Attributes / markers:**
- Event kinds recorded elsewhere: `agent_start`, `agent_end`, `agent_settled`, `stream_chunk`, `entry_appended`, `queue_update`, `compaction_start`, `compaction_end`, `auto_retry_*`, `thinking_level_changed`, `tool_execution_start`, `tool_execution_end`, `message_end`, `message_update`, `turn_end`
- `RAW_HARNESS_EVENT_KINDS`, `RAW_SESSION_ONLY_EVENT_KINDS` — enumerations in [raw-protocol.ts](../../../../src/shared/raw-protocol.ts) that the raw recorder uses to classify subscriptions

**Namespaces:**
- [src/pi/events.ts](../../../../src/pi/events.ts) — the entire module

## Lifecycle edges

**Depends on:**

*(none — leaf module)*

**Used by:**
- [file-change-tracking](../../07-safety-and-reversibility/file-change-tracking/file-change-tracking.md) — subscribes to `tool_execution_start / end`.
- [message-queuing](../../08-message-flow-discipline/message-queuing/message-queuing.md) — the `agent_settled` event that unlocks dispatch.
- [raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md) — session-only events are subscribed via `EventRouter.onAll`.
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — the manager owns an `EventRouter` and binds it into the SDK session listener.

## See also

- **Rule — exception isolation is the whole point.** Do not restructure `dispatch` to remove the try/catch. A raw recorder that fails to persist one event must not stop the chat reducer from seeing subsequent events.
- **Pattern — wildcard first, typed second.** `dispatch` iterates global handlers *before* typed ones. Consumers can rely on the order: raw recorder (wildcard) sees the event before any type-specific reducer mutates state as a side effect of consuming it.
- **Pattern — unsubscribe is the return value.** `on` and `onAll` return a function that removes the handler; the caller stores that function and calls it on disposal. Do not add a `.off(handler)` API — it invites double-removal races.
- **Pitfall — `dispatch` is synchronous.** A slow handler blocks all subsequent handlers for that event. Handlers that need to do I/O should schedule the work via `queueMicrotask` or `setImmediate` and return immediately.
- **Pitfall — `clear()` does not affect handlers registered *after* it returns.** Callers who need "no more handlers, ever" must stop calling `on` / `onAll` themselves after disposal begins. The router does not lock out re-registration.
- **Pattern — one router per session, not per tab.** Session replacement (via `PiSessionRuntime.replace`) reuses the router; only session disposal calls `clear()`.
