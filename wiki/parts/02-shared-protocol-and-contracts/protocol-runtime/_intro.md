# Chapter: protocol-runtime

Compile-time type discipline is enough for one side of a boundary if the other side is authored in the same repo. It is not enough when the "other side" is an already-installed webview iframe that reconnected after a Reload Window, or an Electron renderer built from an older commit, or a Playwright integration test blasting messages faster than a real user could. Those callers need **runtime validation**: reject the malformed message before it corrupts state, correlate responses with requests, detect reconnections, and recover from dropped events.

That is the job of [src/shared/protocol-runtime.ts](../../../../src/shared/protocol-runtime.ts) and its neighbors in [src/shared/connection-protocol.ts](../../../../src/shared/connection-protocol.ts).

## Article roster

- [protocol-runtime](protocol-runtime.md) — Typebox schemas mirroring every message type, type guards for the boundary, envelope construction / validation, and the request-response and event-stream correlation primitives.

## Reader task

The reader arrives here to answer one of:

- "How is a malformed message rejected — where is the guard, what error is returned?"
- "What is the difference between an `AgentRequestEnvelope` and an `AgentEventEnvelope`?"
- "How do we detect that the extension host restarted and this webview needs to re-fetch state?"
- "Why is `interruptedTurn` gated to only appear when `isStreaming === false && isCompacting === false`?"

## Neighborhood

- The **type declarations** validated here live in the previous chapter, [message-protocol](../message-protocol/message-protocol.md).
- The **transport-neutral connection client** that produces envelopes on the fly and calls these validators lives in the next chapter, [agent-connection-client](../agent-connection-client/agent-connection-client.md).
- Both webview code and desktop-host renderer code lean on this module — see [Part X § desktop-ipc-contract](../../../index.md#part-x--standalone-desktop-host) for a second consumer.

## Non-goals

- The physical transport (VS Code postMessage vs. Electron IPC vs. dev bridge) is abstracted away by the connection interfaces; concrete transports live in adapters and not here.
- Whether a specific validation failure should be treated as fatal, a retry candidate, or a silent drop is domain policy, decided at the call site.
- Serialization format (JSON) is out of scope; envelopes are already parsed objects at this layer.
