# Chapter: steering

Steering is **mid-turn injection**. Where a normal `prompt` starts a new turn (user speaks, agent responds), and a `followUp` sequences another user turn after settlement, `steer` slips a new instruction into the *currently active* turn so the agent absorbs it while still streaming. The SDK exposes this as [`AgentSession.steer(text)`](../../../../src/pi/session.ts); the chat command service routes to it as a `StreamingCommand`.

## Article roster

- [steering](steering.md) — `StreamingCommand` union, `PiSession.steer / followUp / prompt` distinction, and the chat-service `dispatchStreamingCommand` router.

## Reader task

The reader arrives here to answer one of:

- "What's the difference between `prompt`, `steer`, and `followUp`?"
- "What happens if I steer while the agent is not streaming?"
- "Is there a persisted marker distinguishing a steer from a regular message?"
- "Does Plan Mode's preamble apply to steer messages?"

## Neighborhood

- **Queuing** — the sibling chapter [message-queuing](../message-queuing/message-queuing.md) covers messages that arrive *while* streaming and defer to the *next* turn; steering covers messages that go into *this* turn.
- **Session methods** — `PiSessionManager.prompt / steer / followUp` — are documented in [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
- **Plan Mode decoration** — which prepends analysis instructions — applies to new prompts only; steer / followUp bypass it. See [plan-mode-and-todos](../plan-mode-and-todos/plan-mode-and-todos.md).

## Non-goals

- The SDK's actual steer semantics (how it inserts the message into the model's context) is a Pi SDK internal.
- Provider-specific behavior (Anthropic vs. OpenAI mid-turn injection) is not documented here — provider-agnostic surface only.
- Persistence of the steer marker in JSONL — there is no marker; the SDK writes the injection as a normal transcript entry.
