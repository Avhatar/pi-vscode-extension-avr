# chat-event-policy

## Stance

Classification is a decision, not a mutation. This module returns tagged unions and boolean predicates; every consumer (the reducer, the host, the queue dispatcher) reads the return value and decides what to do about it. Colocating the decisions here means the reducer stays a straight-line switch and the queue logic never has to duplicate "is this really terminal?" checks.

## Role

Five exported functions and a couple of types cover the whole surface.

- [`findLastAssistantMessage(messages)`](../../../../src/core/chat/chat-event-policy.ts#L15) — reverse-scans an entry list, returns the last message with `role === 'assistant'`. Building block for the classifier below.
- [`classifyAssistantTurnIssue(message)`](../../../../src/core/chat/chat-event-policy.ts#L22) — inspects `stopReason` on the last assistant message. Returns a `TurnIssue`: `{ kind: 'provider-error', message }` for `stopReason === 'error'` or for empty responses (no text, no thinking, no tool call) with a diagnostic string covering the usual suspects (missing key, quota, region); `{ kind: 'notice', severity: 'warning', message }` for `stopReason === 'length'`; other `stopReason` values yield informational notices.
- [`turnCompletionOutcome(message)`](../../../../src/core/chat/chat-event-policy.ts#L48) — maps the same message to a `TurnCompletionOutcome`: `'completed' | 'stopped' | 'failed' | 'truncated'`.
- [`collectOrphanedTools(pendingTools, now)`](../../../../src/core/chat/chat-event-policy.ts#L56) — sweeps the pending-tools map, computes `elapsedMs` for each, returns an `OrphanedToolInfo[]`. This is the "the session ended but tool X never reported completion" case.
- [`shouldDispatchQueueAfterTerminal(eventType, state)`](../../../../src/core/chat/chat-event-policy.ts#L67) — true when the event is `agent_end` with `!isSessionStreaming`, OR `agent_settled` with `!isStreamingLocal`. The two-phase check exists because the SDK reports session-level and local-tab-level streaming separately.
- [`shouldSyncStateForEvent(eventType)`](../../../../src/core/chat/chat-event-policy.ts#L85) — membership test against the `STATE_SYNC_EVENTS` set: `agent_start`, `agent_end`, `message_end`, `turn_end`, `compaction_start`, `compaction_end`. Anything else is either purely streaming (tokens) or an internal signal that would waste bandwidth to broadcast.

## Keywords

**Types:**
- `TurnIssue` — `{ kind: 'provider-error' | 'notice'; message: string; severity?: 'warning' | 'info' }`
- `TurnCompletionOutcome` — `'completed' | 'stopped' | 'failed' | 'truncated'`
- `OrphanedToolInfo` — `{ id: string; name: string; elapsedMs: number }`

**Methods:**
- `findLastAssistantMessage(messages)` — [chat-event-policy.ts:15](../../../../src/core/chat/chat-event-policy.ts#L15)
- `classifyAssistantTurnIssue(message)` — [chat-event-policy.ts:22](../../../../src/core/chat/chat-event-policy.ts#L22)
- `turnCompletionOutcome(message)` — [chat-event-policy.ts:48](../../../../src/core/chat/chat-event-policy.ts#L48)
- `collectOrphanedTools(pendingTools, now)` — [chat-event-policy.ts:56](../../../../src/core/chat/chat-event-policy.ts#L56)
- `shouldDispatchQueueAfterTerminal(eventType, state)` — [chat-event-policy.ts:67](../../../../src/core/chat/chat-event-policy.ts#L67)
- `shouldSyncStateForEvent(eventType)` — [chat-event-policy.ts:85](../../../../src/core/chat/chat-event-policy.ts#L85)

**Attributes / markers:**
- `STATE_SYNC_EVENTS` — const set of event types that warrant re-publishing state
- `stopReason` — assistant-message field the classifier keys off; values include `'error'`, `'length'`, `'stop'`, and provider-specific extensions

**Namespaces:**
- [src/core/chat/chat-event-policy.ts](../../../../src/core/chat/chat-event-policy.ts) — the entire module

## Lifecycle edges

**Depends on:**

*(none — pure helpers)*

**Used by:**
- [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — reduce path applies classification (orphan sweeps, completion outcome).
- [message-queuing](../../08-message-flow-discipline/message-queuing/message-queuing.md) — the terminal-event predicate.

## See also

- **Rule — pure functions only.** No I/O, no `Date.now()` inside classification (the `now` argument to `collectOrphanedTools` is passed explicitly precisely so tests can pin a clock). Adding a side effect here defeats the purpose of the split.
- **Pattern — outcome vs. issue is asymmetric.** Every turn has exactly one `TurnCompletionOutcome`; not every turn has a `TurnIssue`. If the classifier returns `undefined` for the issue, the UI shows nothing extra beyond the usual message; if it returns a `provider-error`, the reducer surfaces the diagnostic text.
- **Pattern — two-phase terminal detection.** The SDK reports `agent_end` when the tool stops streaming *for that tab*, but the underlying session may still be busy (compaction, background writes). `shouldDispatchQueueAfterTerminal` distinguishes; queue dispatch waits for the settle event.
- **Pitfall — empty-response provider errors are common in the field.** Users typically hit them when a key is misconfigured, when a region does not support the requested model, or when a provider quota is exhausted. The diagnostic string emitted by `classifyAssistantTurnIssue` mentions all three because the difference matters at debug time.
- **Pitfall — do not extend `STATE_SYNC_EVENTS` casually.** Adding an event here means every state sync fires on that event across every open tab; if the event is high-frequency (per-token), the extension will drown itself in `stateSync` traffic. Prefer targeted patches for high-frequency events.
- **Pattern — `collectOrphanedTools` is called at `agent_end`.** The reducer takes the snapshot before clearing `pendingTools`. Tools that finished normally were already removed by their `tool_execution_end` handler.
