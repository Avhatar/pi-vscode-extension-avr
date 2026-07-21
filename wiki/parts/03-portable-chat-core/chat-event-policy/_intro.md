# Chapter: chat-event-policy

Every agent event coming out of the Pi SDK is either informational (a token, a tool call, a progress update) or *terminal* (an `agent_end` marking the session as no-longer-streaming). Terminal events raise a family of policy questions the reducer must not decide in-line: was the turn actually completed or interrupted? Are there tool calls that never ended and should be surfaced as orphans? Should the queued next prompt be dispatched now?

[src/core/chat/chat-event-policy.ts](../../../../src/core/chat/chat-event-policy.ts) is the small pure-function module that answers them. Its output feeds into [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) as classification data.

## Article roster

- [chat-event-policy](chat-event-policy.md) — orphan tool sweeps, assistant-turn classification, completion outcome, and the state-sync event filter.

## Reader task

The reader arrives here to answer one of:

- "What decides whether an assistant turn is 'completed' vs. 'stopped'?"
- "Where does the code notice that a tool call never returned?"
- "Which agent events cause the extension to publish a fresh state snapshot vs. suppress?"

## Neighborhood

- **Consumers**: [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md).
- **Producers of events**: the Pi SDK; see [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md).
- **Tab-runtime fields** the classifier reads (`pendingTools`, `isStreamingLocal`, `isSessionStreaming`) live in [tab-registry-and-runtime](../tab-registry-and-runtime/tab-registry-and-runtime.md).

## Non-goals

- No side effects; every export is pure.
- No queue dispatch logic — the classifier only signals *whether* queue dispatch is legal now, not the dispatch itself.
- No UI mapping — that's the reducer's job.
