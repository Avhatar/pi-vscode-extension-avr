# Chapter: session-lifecycle

Every chat tab in Pi Code is backed by exactly one Pi SDK session. The mediator is [`PiSessionManager`](../../../../src/pi/session.ts) — a class the tab owns, which in turn owns the SDK `AgentSession` handle, the resource loader that told the SDK where to find bundled extensions, and the auth / model / claude-compat / raw-recorder wiring that makes a session useful.

This chapter is where the "prompt / steer / follow-up" flow bottoms out. It's also where session locks are acquired, where SDK dynamic-import gymnastics happen, and where every downstream chapter in Part V connects.

## Article roster

- [session-lifecycle](session-lifecycle.md) — `PiSessionManager` and the smaller `PiSessionRuntime` inside it, resource-loader construction, the prompt / steer / settlement contract, tool-selection guarding, session-lock acquisition, and dynamic SDK loading.

## Reader task

The reader arrives here to answer one of:

- "What happens between the user pressing Enter and the SDK receiving `session.prompt(...)`?"
- "Where does the tab's session get the list of bundled Pi extensions from?"
- "How does turn interruption detection work — the marker inside message history?"
- "Why is `await import(...)` used for the SDK instead of a top-level import?"

## Neighborhood

- **Events** produced by the SDK travel through [event-router](../event-router/event-router.md) into the chat core.
- **Models and auth** the session uses are in [models-and-auth](../models-and-auth/models-and-auth.md).
- **Bundled Pi extensions** the resource loader is fed are documented in [bundled-pi-packages](../bundled-pi-packages/bundled-pi-packages.md).
- **Claude compatibility extensions** that hook `beforeAgentStart` / `beforeToolCall` / `afterToolCall` are in [claude-sdk-compat](../claude-sdk-compat/claude-sdk-compat.md).
- **Subagents** — invoked as tools inside a running session — are covered in [Part IX](../../../index.md#part-ix--subagents).

## Non-goals

- The SDK's own internals are opaque; this chapter documents what we *hand* it, not what it does with them.
- File-change tracking is downstream of this chapter and belongs to [Part VII § file-change-tracking](../../07-safety-and-reversibility/file-change-tracking/file-change-tracking.md).
- Storage of message history is a Pi SDK concern (JSONL under `.pi/sessions/`); the extension does not touch that format directly.
