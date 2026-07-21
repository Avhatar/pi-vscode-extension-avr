# Chapter: event-router

Between the SDK's single `AgentSession.subscribe(listener)` seat and the many objects that need to react to session events (chat service, tab runtime, checkpoint manager, diff tracker, raw recorder) sits [`EventRouter`](../../../../src/pi/events.ts). It's a small pub/sub layer with two capabilities the raw SDK listener lacks: **listener fan-out** (many handlers can share one session), and **wildcard subscription** (a listener that sees every event, useful for the raw recorder and the launcher state updater).

## Article roster

- [event-router](event-router.md) — `EventRouter` API surface, dispatch semantics, exception isolation, and the pattern of consuming it via `asSessionListener()`.

## Reader task

The reader arrives here to answer one of:

- "Where do I subscribe to just `agent_end` events across all sessions?"
- "What happens if one of the listeners throws?"
- "Why isn't this just the SDK's own event API?"

## Neighborhood

- The **owner** of the router is [`PiSessionManager`](../session-lifecycle/session-lifecycle.md).
- **Event classifiers** in the chat core (`chat-event-policy`) run downstream of this router.
- The **raw recorder** ([Part XI § raw-mode](../../../index.md#part-xi--auxiliary-systems)) uses `onAll` to persist every event.

## Non-goals

- Event type declarations (the specific `AgentSessionEvent` shape) live in the Pi SDK; the router is agnostic to payload.
- Persistence of events is not this router's job — it hands them to subscribers and forgets.
- Backpressure / batching is out of scope; the router dispatches synchronously in order.
