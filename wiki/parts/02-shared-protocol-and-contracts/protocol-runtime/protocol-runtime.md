# protocol-runtime

## Stance

Two things must be true at every transport boundary. **Every message is validated as it crosses the seam**, using Typebox schemas that mirror the compile-time union member-for-member — so an old webview cannot hand a new host a malformed payload and cause a `TypeError` five call stacks deep. **Every event carries enough metadata to recover from disconnection**: a `clientId`, an `epoch` incremented on reconnection, and a monotonic `sequence` so gaps are detectable. Loss of either invariant would put the client into a diverged state where it *thinks* it's up to date but the host has already moved on.

## Role

[src/shared/protocol-runtime.ts](../../../../src/shared/protocol-runtime.ts) is a wall of Typebox schemas plus a small ring of exported guards. The schemas exist so validation can run in any environment (Node, browser, tests) without pulling a compiler. Each transport partition declared in [message-protocol](../message-protocol/message-protocol.md) has a matching schema; `ClientMessageSchema` and `ServerMessageSchema` are meta-unions across the partitions.

Envelopes are separate: [src/shared/connection-protocol.ts](../../../../src/shared/connection-protocol.ts) defines the wire shapes that carry these messages. A request-response pair uses `AgentRequestEnvelope<M>` + `AgentResponseEnvelope`; a server-pushed event uses `AgentEventEnvelope<M>`. Envelopes never duplicate the message's `type` at their own top level — the guards actively reject that shape to keep the discriminator single-source.

Type guards exposed:

- `isAgentClientMessage`, `isPlatformClientMessage`, `isVsCodeClientMessage`, `isClientMessage` — partition-level and meta-level guards.
- `isAgentServerMessage`, `isVsCodeServerMessage`, `isServerMessage` — server side.
- `isAgentRequestEnvelope`, `isAgentResponseEnvelope` — for the request/response transport.
- `isAgentEventEnvelope`, `isAgentServerEventEnvelope` — for the event stream.
- `hasValidInterruptedTurnState(value)` — enforces the invariant that a `SerializedAgentState` may carry `interruptedTurn` only when `isStreaming === false && isCompacting === false`. This is a cross-field constraint Typebox cannot check alone; the guard closes the gap.

Constants in `connection-protocol.ts`:

- `AGENT_PROTOCOL_VERSION = 2` — envelope schema version. Rev when adding non-backward-compatible envelope fields.
- `LONG_RUNNING_AGENT_REQUEST_TIMEOUT_MS = 120_000` — floor for the get-sessions / search-workspace-files pattern.
- `getAgentRequestTimeoutMs(message, default)` — returns `undefined` for `confirmAction` (never times out; a user prompt may sit indefinitely), floor 120 s for the long-running ops, otherwise the caller default.

The `AgentEventSequencer` class helps hosts stamp events with monotonically increasing sequence numbers per client-tab pair; the counterpart on the client detects gaps.

## Role — validators, not policies

This module does not decide what to *do* with a validation failure. It only reports "this shape is invalid" or "this envelope's discriminator does not match its payload". Recovery (retry, close, ignore) is policy owned by the connection client, not the schemas.

## Keywords

**Types — schemas:**
- `ClientMessageSchema`, `ServerMessageSchema` — meta-unions [protocol-runtime.ts:136](../../../../src/shared/protocol-runtime.ts#L136), [:427](../../../../src/shared/protocol-runtime.ts#L427)
- `AgentClientMessageSchema`, `AgentServerMessageSchema` — [protocol-runtime.ts:50](../../../../src/shared/protocol-runtime.ts#L50), [:371](../../../../src/shared/protocol-runtime.ts#L371)
- `PlatformClientMessageSchema`, `VsCodeClientMessageSchema`, `VsCodeServerMessageSchema` — [protocol-runtime.ts:114](../../../../src/shared/protocol-runtime.ts#L114)
- Envelope schemas: `AgentRequestEnvelopeSchema` [:142](../../../../src/shared/protocol-runtime.ts#L142), `AgentResponseEnvelopeSchema` [:151](../../../../src/shared/protocol-runtime.ts#L151), `AgentEventEnvelopeSchema` [:453](../../../../src/shared/protocol-runtime.ts#L453)
- 40+ leaf schemas mirroring [message-protocol](../message-protocol/message-protocol.md) payloads: `ModelInfoSchema`, `SerializedAgentStateSchema`, `TodoSnapshotSchema`, `AgentTabControlsSchema`, `CodexUsageSnapshotSchema`, `DeepSeekUsageSnapshotSchema`, and so on

**Types — envelope:**
- `AgentRequestEnvelope<M>` — [connection-protocol.ts:14](../../../../src/shared/connection-protocol.ts#L14); protocolVersion, requestId, clientId, tabId?, type, payload
- `AgentSuccessResponse<R>`, `AgentErrorResponse`, `AgentResponseEnvelope` — [connection-protocol.ts:23](../../../../src/shared/connection-protocol.ts#L23)
- `AgentEventEnvelope<M>` — [connection-protocol.ts:44](../../../../src/shared/connection-protocol.ts#L44); with clientId, epoch, sequence, tabId
- `AgentRequestMetadata` — [connection-protocol.ts:8](../../../../src/shared/connection-protocol.ts#L8)

**Methods — guards:**
- `isAgentClientMessage`, `isPlatformClientMessage`, `isVsCodeClientMessage`, `isClientMessage` — [protocol-runtime.ts:474](../../../../src/shared/protocol-runtime.ts#L474)
- `isAgentServerMessage`, `isVsCodeServerMessage`, `isServerMessage` — [protocol-runtime.ts:520](../../../../src/shared/protocol-runtime.ts#L520)
- `isAgentClientRequestEnvelope` — [protocol-runtime.ts:490](../../../../src/shared/protocol-runtime.ts#L490)
- `isAgentRequestEnvelope`, `isAgentResponseEnvelope` — [protocol-runtime.ts:498](../../../../src/shared/protocol-runtime.ts#L498)
- `isAgentEventEnvelope`, `isAgentServerEventEnvelope` — [protocol-runtime.ts:527](../../../../src/shared/protocol-runtime.ts#L527)
- `hasValidInterruptedTurnState` — [protocol-runtime.ts:508](../../../../src/shared/protocol-runtime.ts#L508)

**Methods — envelope factories:**
- `createAgentRequestEnvelope(...)` — [connection-protocol.ts:78](../../../../src/shared/connection-protocol.ts#L78)
- `createSuccessResponse(...)`, `createErrorResponse(...)` — [connection-protocol.ts:88](../../../../src/shared/connection-protocol.ts#L88)
- `AgentEventSequencer` — class [connection-protocol.ts:119](../../../../src/shared/connection-protocol.ts#L119); `next(tabId)` returns the next monotonic sequence for a tab
- `getAgentRequestTimeoutMs(message, defaultMs)` — [connection-protocol.ts:57](../../../../src/shared/connection-protocol.ts#L57)

**Attributes / markers:**
- `AGENT_PROTOCOL_VERSION = 2` — [connection-protocol.ts:4](../../../../src/shared/connection-protocol.ts#L4); envelope schema version
- `LONG_RUNNING_AGENT_REQUEST_TIMEOUT_MS = 120_000` — [connection-protocol.ts:6](../../../../src/shared/connection-protocol.ts#L6)
- `StrictObject = { additionalProperties: false }` — [protocol-runtime.ts:19](../../../../src/shared/protocol-runtime.ts#L19); every schema forbids extra fields to catch drift

**Namespaces:**
- [src/shared/protocol-runtime.ts](../../../../src/shared/protocol-runtime.ts) — schemas + guards
- [src/shared/connection-protocol.ts](../../../../src/shared/connection-protocol.ts) — envelope shapes + version constants

## Lifecycle edges

**Depends on:**
- [message-protocol](../message-protocol/message-protocol.md) — schemas are declared against those message types; any drift is caught here at build time.

**Used by:**
- [agent-connection-client](../agent-connection-client/agent-connection-client.md) — every incoming envelope is filtered through the guards declared there; timeout / envelope constants come from `connection-protocol.ts`.
- [chat-panel-provider](../../06-ui-surfaces-webview/chat-panel-provider/chat-panel-provider.md) — `AgentEventSequencer` and envelope guards used by the connection.
- [desktop-ipc-contract](../../10-standalone-desktop-host/desktop-ipc-contract/desktop-ipc-contract.md) — envelope guards used by the host.

## See also

- **Rule — cross the boundary only through guards.** A raw `postMessage` payload is `unknown`. Cast it through `isAgentEventEnvelope` (or the appropriate guard) *before* reading discriminators. Anywhere else is a type-safety hole.
- **Rule — `additionalProperties: false` on every schema.** New fields are additive at the union level, not at the object level. When you extend a message, add the new field to the schema in the same commit; forgetting causes `Check(schema, value)` to reject legitimate traffic silently.
- **Pattern — envelope carries transport metadata; payload carries domain data.** `requestId`, `clientId`, `tabId`, `epoch`, `sequence` are envelope fields. The domain `type` discriminator lives inside `payload.type` — never at both levels. `isAgentClientRequestEnvelope` explicitly rejects payloads that duplicate `type` outside the payload.
- **Pattern — `interruptedTurn` invariant is cross-field.** `SerializedAgentState.interruptedTurn` is legal only when neither `isStreaming` nor `isCompacting` is true. Typebox cannot express that; `hasValidInterruptedTurnState` enforces it in code. Adding new mutually-exclusive fields to `SerializedAgentState` should follow the same guard pattern.
- **Pitfall — bump `AGENT_PROTOCOL_VERSION` when you break envelope compatibility.** Non-backward-compatible envelope changes will produce silent mismatches; a version bump surfaces them as explicit error responses from the connection client.
- **Pitfall — the 120 s floor exists because `getSessions` scans disk.** Do not drop it; long-running platform ops legitimately need that budget.
