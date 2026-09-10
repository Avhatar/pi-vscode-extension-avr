# message-queuing

## Stance

The queue's whole job is to hold user prompts across the streaming boundary. Two rules make it safe: **dispatch on settlement, never on `agent_end`**, and **retry local dispatch failures exactly once, then surface**. The first rule matches the SDK's own busy semantics — the session is still doing work after `agent_end` (background writes, compaction) and rejects new prompts until it fully settles. Settlement means `agent_settled` for anything that ran inside a turn, plus `compaction_end` for a compaction that ran outside one, which no `agent_settled` ever follows. The second protects against transient dispatch errors in the extension host itself, without spinning into an infinite retry loop that could silently spam the SDK.

The queue is also the fallback for a prompt that arrives too early. The client decides between a direct prompt and a queued one from published state that lags the session by at least one event, so `dispatchDirectPrompt` re-checks session busyness itself and queues rather than letting the SDK reject the message.

## Role

State lives on `TabRuntime`:

- `queuedMessages: string[]` [tab-runtime.ts:60](../../../../src/core/chat/tab-runtime.ts#L60) — FIFO queue.
- `queuedRetryHead?: string` [tab-runtime.ts:61](../../../../src/core/chat/tab-runtime.ts#L61) — the text of the message currently being retried; cleared when the head changes.
- `queuedRetryAttempts: number` [tab-runtime.ts:62](../../../../src/core/chat/tab-runtime.ts#L62) — retry counter; capped at 1 (single retry).

Initialization at [tab-runtime.ts:95](../../../../src/core/chat/tab-runtime.ts#L95): `queuedMessages = []`, `queuedRetryAttempts = 0`. Reset [tab-runtime.ts:150](../../../../src/core/chat/tab-runtime.ts#L150) clears both.

`ChatService.applyQueueControl(tab, command)` [chat-service.ts:402](../../../../src/core/chat/chat-service.ts#L402) is the sole mutation entry point. Command types:

- `queueMessage(text)` [chat-service.ts:408](../../../../src/core/chat/chat-service.ts#L408) — appends to `queuedMessages`.
- `editQueuedMessage(index, text)` [chat-service.ts:412](../../../../src/core/chat/chat-service.ts#L412) — in-place edit; if the head changed, reset retry state.
- `removeQueuedMessage(index)` [chat-service.ts:423](../../../../src/core/chat/chat-service.ts#L423) — splice; reset retry state if the head changed.
- `cancelQueue()` [chat-service.ts:431](../../../../src/core/chat/chat-service.ts#L431) — empties the array.

`ChatCommandService.dispatch` [chat-command-service.ts:98](../../../../src/core/chat/chat-command-service.ts#L98) routes all four to `applyQueueControl`, then publishes state via callback.

Dispatch gates:

- `reserveQueuedDispatch(tab): boolean` [chat-service.ts:443](../../../../src/core/chat/chat-service.ts#L443) — if the queue is non-empty and no dispatch is in flight, sets `isStreamingLocal = true` and returns true. Prevents concurrent dispatches racing on the same head.
- `dispatchNextQueued(tab, callbacks)` [chat-service.ts:449](../../../../src/core/chat/chat-service.ts#L449) — pops the head, handles local commands (`/compact`), invokes the agent. On failure, if `queuedRetryAttempts < 1`, increments and reschedules; else surfaces the error to the user and drops the head.

The settlement gate: [chat-event-policy.ts:67](../../../../src/core/chat/chat-event-policy.ts#L67) — `shouldDispatchQueueAfterTerminal(eventType, state)` returns true for `agent_settled` with `!isStreamingLocal`, and for `compaction_end` when neither the tab nor the session is streaming. The chat host's event handler [chat-host.ts:439](../../../../src/core/chat/chat-host.ts#L439) uses this predicate before calling `reserveQueuedDispatch` + `dispatchNextQueued`.

The pre-flight gate: [`dispatchDirectPrompt`](../../../../src/core/chat/chat-service.ts) calls `callbacks.isSessionBusy()` — in the VS Code host, `tab.session.isStreaming || tab.isCompacting` — and diverts the prompt into `applyQueueControl` when the session cannot accept it. `/compact` is exempt (the SDK aborts the open run and compacts anyway); attachments are refused, because the queue holds text only.

## Keywords

**Types:**
- `QueueControlCommand` — union of `queueMessage | editQueuedMessage | removeQueuedMessage | cancelQueue` [chat-service.ts](../../../../src/core/chat/chat-service.ts)
- `QueueControlResult` — `{ mutated, headChanged }` return shape

**Methods — mutation:**
- `applyQueueControl(tab, command)` — [chat-service.ts:402](../../../../src/core/chat/chat-service.ts#L402)

**Methods — dispatch:**
- `reserveQueuedDispatch(tab)` — [chat-service.ts:443](../../../../src/core/chat/chat-service.ts#L443)
- `dispatchNextQueued(tab, callbacks)` — [chat-service.ts:449](../../../../src/core/chat/chat-service.ts#L449)

**Methods — gating:**
- `shouldDispatchQueueAfterTerminal(eventType, state)` — [chat-event-policy.ts:67](../../../../src/core/chat/chat-event-policy.ts#L67)
- `isSessionBusy()` — `DirectPromptCallbacks` member consulted by `dispatchDirectPrompt` before starting a turn
- `decideInputSubmit(context)` — client-side send/queue/steer routing [input-submit-policy.ts](../../../../src/webview/input-submit-policy.ts)

**Attributes / markers:**
- `queuedMessages: string[]` — [tab-runtime.ts:60](../../../../src/core/chat/tab-runtime.ts#L60)
- `queuedRetryHead?: string` — head text under retry
- `queuedRetryAttempts: number` — capped at `1`
- Terminal events triggering dispatch: **`agent_settled`**, plus **`compaction_end`** outside a run (never `agent_end`)
- FIFO ordering — no priority queue

**Namespaces:**
- [src/core/chat/tab-runtime.ts](../../../../src/core/chat/tab-runtime.ts) — state fields
- [src/core/chat/chat-service.ts](../../../../src/core/chat/chat-service.ts) — mutation + dispatch
- [src/core/chat/chat-command-service.ts](../../../../src/core/chat/chat-command-service.ts) — command routing
- [src/core/chat/chat-event-policy.ts](../../../../src/core/chat/chat-event-policy.ts) — settlement gate

## Lifecycle edges

**Depends on:**
- [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — the reducer that owns the queue.
- [Part III § chat-event-policy](../../03-portable-chat-core/chat-event-policy/chat-event-policy.md) — the terminal-event predicate.
- [Part III § chat-command-service](../../03-portable-chat-core/chat-command-service/chat-command-service.md) — routes user messages into queue commands.
- [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md) — the `agent_settled` event that unlocks dispatch.

**Used by:**
- [steering](../steering/steering.md) — orthogonal message-flow chapter.

## See also

- **Rule — dispatch on `agent_settled`, not `agent_end`.** From [AGENTS.md](../../../../AGENTS.md): "the SDK still reports the session as busy until settlement, so a normal prompt will be rejected and lost." Bypassing the gate = message dropped.
- **Rule — busy is wider than "streaming" as the client sees it.** `isStreamingLocal` clears at `agent_end`, but the SDK's `isStreaming` (its `_isAgentRunActive`) stays true until settlement, and a manual `/compact` keeps the session busy with `isStreaming` false. Anything deciding "prompt or queue?" must treat compaction and the post-`agent_end` tail as busy; otherwise the user sees the SDK's raw `streamingBehavior` error and loses the message.
- **Pitfall — attachments cannot be queued.** `queuedMessages` is `string[]`. A prompt that carries images or files while the session is busy is refused with an explanation, both client-side and in `dispatchDirectPrompt`. Widening the queue to carry attachments would also mean persisting their payloads.
- **Rule — retry cap is 1.** Set `queuedRetryAttempts = 1`; more attempts are indistinguishable from being stuck and can DoS the SDK. If a message fails twice in a row, surface the error and drop.
- **Pattern — FIFO with in-place edits.** Users can edit or remove any queued message, but ordering is preserved. Do not sort by "importance" or add priorities — users expect what they typed first to run first.
- **Pattern — the retry state is scoped to the current head.** Changing the head (by removing / editing at index 0) clears `queuedRetryHead` and resets attempts. Otherwise a message that failed once could accidentally inherit the retry-used state from a completely different message.
- **Pitfall — `reserveQueuedDispatch` returning false must not enqueue a follow-up.** The gate exists to prevent two dispatches racing; ignoring a false return would violate the invariant.
- **Pitfall — queue survives session compaction but not session reload.** Queue lives on `TabRuntime`, which is disposed on tab close. Persistence across window reload would need a separate mechanism (not currently implemented).
- **Pattern — steering is orthogonal.** See the sibling chapter [steering](../steering/steering.md); steering injects into the *current* turn, queuing adds to *future* turns.
