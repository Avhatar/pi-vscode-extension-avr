# steering

## Stance

`prompt`, `steer`, and `followUp` are three distinct SDK operations, not variations on a theme. The chat command service routes each to a different session method; the choice happens client-side and cannot be corrected downstream. A UI that presents "just send my message" as one button but internally routes to `steer` when streaming is confusing users into thinking their message will start a new turn — it won't. The current design surfaces three intents explicitly: `prompt` starts a new turn (blocked while streaming), `steer` injects into the current turn (only while streaming), `followUp` sequences a new turn after settlement (only after settlement).

## Role

`StreamingCommand` [chat-service.ts:101](../../../../src/core/chat/chat-service.ts#L101) is a discriminated union carrying `abort | steer | followUp` — the three operations valid while the agent is streaming or transitioning.

`StreamingCommandCallbacks` [chat-service.ts:106](../../../../src/core/chat/chat-service.ts#L106) — the host-supplied hooks: `logPrompt(kind: 'steer' | 'followUp')`, `steer(text, images, files)`, `followUp(text, images, files)`.

`ChatService.dispatchStreamingCommand(command, callbacks)` [chat-service.ts:383](../../../../src/core/chat/chat-service.ts#L383) is the router:

- `command.type === 'abort'` → call session `abort()`.
- `command.type === 'steer'` → `await callbacks.steer(text, images, files)`.
- `command.type === 'followUp'` → `await callbacks.followUp(text, images, files)`.

The `ChatCommandService` [chat-command-service.ts:88](../../../../src/core/chat/chat-command-service.ts#L88) dispatches `prompt / steer / followUp / abort` messages through `dispatchStreamingCommand` — `prompt` bottoms out at `dispatchDirectPrompt` (starts a new turn), the others at `dispatchStreamingCommand`.

`PiSessionManager` exposes the three SDK-facing methods:

- [`prompt(text, images?, files?)`](../../../../src/pi/session.ts#L680) — new user turn. Fails if the session is busy.
- [`steer(text, images?, files?)`](../../../../src/pi/session.ts#L692) — mid-turn injection. Valid only while streaming.
- [`followUp(text, images?, files?)`](../../../../src/pi/session.ts#L698) — sequential prompt sharing the turn lifecycle. Valid after settlement.

No persistence marker distinguishes the three at the transcript level — the SDK writes each into the session JSONL as an ordinary entry. The distinction lives in the API call itself; consumers of history cannot recover the intent.

Plan Mode interaction: `decorateDirectPrompt(text, planModeEnabled)` [chat-preferences.ts:119](../../../../src/core/chat/chat-preferences.ts#L119) wraps `text` with the Plan Mode preamble when `planModeEnabled === true`. This decoration is applied only in `dispatchDirectPrompt` — steer and followUp do *not* get the preamble, because they piggyback on an already-started turn where the mode has already been set.

## Keywords

**Types:**
- `StreamingCommand` — union [chat-service.ts:101](../../../../src/core/chat/chat-service.ts#L101)
- `StreamingCommandCallbacks` — interface [chat-service.ts:106](../../../../src/core/chat/chat-service.ts#L106)
- `DirectPromptCallbacks` — separate type used by `dispatchDirectPrompt`

**Methods — chat-service:**
- `dispatchStreamingCommand(command, callbacks)` — [chat-service.ts:383](../../../../src/core/chat/chat-service.ts#L383)
- `dispatchDirectPrompt(tab, request, callbacks)` — [chat-service.ts:346](../../../../src/core/chat/chat-service.ts#L346) (new-turn path)

**Methods — session:**
- `PiSessionManager.prompt(text, images?, files?)` — [session.ts:680](../../../../src/pi/session.ts#L680)
- `PiSessionManager.steer(text, images?, files?)` — [session.ts:692](../../../../src/pi/session.ts#L692)
- `PiSessionManager.followUp(text, images?, files?)` — [session.ts:698](../../../../src/pi/session.ts#L698)

**Methods — command routing:**
- `ChatCommandService.dispatch` [chat-command-service.ts:74](../../../../src/core/chat/chat-command-service.ts#L74) — routes `prompt` → direct, `steer/followUp/abort` → streaming

**Attributes / markers:**
- Preconditions:
  - `prompt` requires session not busy
  - `steer` requires session actively streaming
  - `followUp` requires post-settlement
- No persisted marker distinguishing the three on disk

**Namespaces:**
- [src/core/chat/chat-service.ts](../../../../src/core/chat/chat-service.ts)
- [src/core/chat/chat-command-service.ts](../../../../src/core/chat/chat-command-service.ts)
- [src/pi/session.ts](../../../../src/pi/session.ts) — SDK wrapper

## Lifecycle edges

**Depends on:**
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — `PiSessionManager` exposes the three SDK operations.
- [Part III § chat-command-service](../../03-portable-chat-core/chat-command-service/chat-command-service.md) — the router that picks which operation to invoke.
- [message-queuing](../message-queuing/message-queuing.md) — orthogonal message-flow chapter.

**Used by:**
- [plan-mode-and-todos](../plan-mode-and-todos/plan-mode-and-todos.md) — Plan Mode decoration is skipped for steer / followUp; documented there.

## See also

- **Rule — three operations, three call sites.** `prompt`, `steer`, `followUp` are not interchangeable. The command service picks based on the client message type; do not "smart-route" based on session state.
- **Rule — Plan Mode preamble is only for new turns.** `decorateDirectPrompt` is applied in `dispatchDirectPrompt`. Applying it to steer would double-prime the current turn and confuse the agent.
- **Pattern — the SDK validates preconditions.** Sending a steer while the session is not streaming throws — surface that error rather than silently converting to a prompt.
- **Pattern — abort is a streaming command.** Aborting is only meaningful mid-stream; the SDK handles the no-op case, but the UI should hide the abort button when nothing is streaming.
- **Pitfall — the persisted JSONL cannot tell you what was steered vs. prompted.** If auditability of intent matters, add a custom entry type (like the interrupted-turn marker); the SDK will not record it for you.
- **Pitfall — steer with images / files is provider-dependent.** Some providers do not support multimodal mid-turn; the SDK returns an error rather than silently dropping. Handle that error in the UI, don't retry as a prompt.
- **Pattern — followUp preserves the turn lifecycle bookkeeping.** `TabRuntime.turnCounter` and the notification gate are aware; a followUp does not increment the counter the way a fresh prompt does.
