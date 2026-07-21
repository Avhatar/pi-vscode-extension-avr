# agent-connection-client

## Stance

`AgentConnectionClient` is a state machine, not a socket. Its inputs are two callbacks — `send(value)` and `subscribe(listener)` — supplied by the transport, and its outputs are a Promise per `request()` call plus a pub/sub feed for every incoming event. Everything else (retry, sequence tracking, recovery on `epoch` bump, exception isolation between listeners) lives inside the client so every transport gets the same guarantees for free.

## Role

The class in [src/shared/agent-connection-client.ts:35](../../../../src/shared/agent-connection-client.ts#L35) implements the [`AgentConnection`](../../../../src/shared/connection-protocol.ts#L69) interface. Construction takes an `AgentConnectionTransport` (a bag of `send` and `subscribe`) plus optional options: `clientId`, `clientIdPrefix`, `tabId`, `requestTimeoutMs`, `transportLabel`. The client generates a stable client identifier at construction time (`crypto.randomUUID` when available, otherwise a random-hex fallback).

Two responsibilities dominate.

**Request/response.** [`request(message, options?)`](../../../../src/shared/agent-connection-client.ts#L62) allocates a `requestId`, wraps `message` via `createAgentRequestEnvelope`, stores a resolver in an internal map keyed by `requestId`, and calls `transport.send(envelope)`. If the transport returns a Promise, the client awaits it; if `send` throws or the returned Promise rejects, the request is rejected with `transport_error`. Each request has a timeout, defaulting to 30 s but bumped to 120 s for known long-running requests (`getSessions`, `searchWorkspaceFiles`) and disabled entirely for `confirmAction` (user might sit for hours on the confirmation).

**Event stream.** [`receive(value)`](../../../../src/shared/agent-connection-client.ts#L147) is the transport's inbound path. It first checks whether `value` matches `isAgentResponseEnvelope` — if so, look up the requestId in the pending map, resolve or reject, and delete the entry. Otherwise it validates as an event envelope: matches `clientId` (skip events for a different client), matches `tabId` if the client is tab-scoped, checks the `epoch` — on epoch increase, the client considers itself reconnected, resets the sequence baseline, and triggers a recovery `getState` request. Then it inspects the `sequence`: if it's less than or equal to the last delivered sequence, drop (deduplication); if there's a gap, mark recovery pending and issue `getState`. Delivering an event to subscribers isolates each listener's exceptions so one broken handler does not block delivery to peers.

The [`requestInitialAgentState(connection, options)`](../../../../src/shared/agent-connection-client.ts#L198) helper is used at webview boot: it issues `getState` with a retry loop tolerating `timeout`, `transport_error`, and `bridge_dispatch_failed` errors — the sort of failures a still-warming-up host may throw for a moment.

The VS Code-specific webview adapter is [`VsCodeAgentConnection`](../../../../src/webview/vscode-agent-connection.ts#L32), which extends `AgentConnectionClient` and preloads the transport with a `postMessage` sink + a `message` event listener. Its factory [`createVsCodeTransport(api, source)`](../../../../src/webview/vscode-agent-connection.ts#L46) is where the browser DOM meets the transport-neutral primitive.

[`TypedEventEmitter<T>`](../../../../src/shared/typed-event.ts#L16) is the small pub/sub primitive used across the module. It provides a `.event` field with the standard `(listener, thisArgs?, disposables?)` signature and a `.fire(...args)` method that isolates listener exceptions.

## Keywords

**Types — client:**
- `AgentConnection` — interface [connection-protocol.ts:69](../../../../src/shared/connection-protocol.ts#L69); `request / subscribe / close`
- `AgentConnectionTransport` — [agent-connection-client.ts:17](../../../../src/shared/agent-connection-client.ts#L17); `send`, `subscribe`
- `AgentConnectionClientOptions` — [agent-connection-client.ts:22](../../../../src/shared/agent-connection-client.ts#L22)
- `AgentConnectionClient` — class [agent-connection-client.ts:35](../../../../src/shared/agent-connection-client.ts#L35)
- `InitialAgentStateRequestOptions` — [agent-connection-client.ts:192](../../../../src/shared/agent-connection-client.ts#L192)
- `TypedEventEmitter<T>` — [typed-event.ts:16](../../../../src/shared/typed-event.ts#L16)
- `TypedEvent<T>` — subscription callback shape [typed-event.ts:1](../../../../src/shared/typed-event.ts#L1)
- `DisposableLike` — [typed-event.ts:1](../../../../src/shared/typed-event.ts#L1)

**Types — VS Code adapter:**
- `VsCodeAgentConnection` — class [vscode-agent-connection.ts:32](../../../../src/webview/vscode-agent-connection.ts#L32)
- `VsCodePostMessageApi` — [vscode-agent-connection.ts:14](../../../../src/webview/vscode-agent-connection.ts#L14)
- `MessageEventSource`, `ConnectionMessageListener`, `VsCodeAgentConnectionOptions` — same file

**Methods — client core:**
- `request(message, options?)` — [agent-connection-client.ts:62](../../../../src/shared/agent-connection-client.ts#L62)
- `subscribe(listener)` — [agent-connection-client.ts:126](../../../../src/shared/agent-connection-client.ts#L126)
- `close()` — [agent-connection-client.ts:132](../../../../src/shared/agent-connection-client.ts#L132)
- `receive(value)` — private inbound [agent-connection-client.ts:147](../../../../src/shared/agent-connection-client.ts#L147)

**Methods — helpers:**
- `requestInitialAgentState(connection, options)` — [agent-connection-client.ts:198](../../../../src/shared/agent-connection-client.ts#L198)
- `isRetriableInitialStateError(code)` — [agent-connection-client.ts:218](../../../../src/shared/agent-connection-client.ts#L218)
- `createClientId(prefix)` — [agent-connection-client.ts:224](../../../../src/shared/agent-connection-client.ts#L224); `crypto.randomUUID` with fallback
- `createVsCodeTransport(api, source)` — [vscode-agent-connection.ts:46](../../../../src/webview/vscode-agent-connection.ts#L46)

**Methods — TypedEventEmitter:**
- `event` — getter returning a subscription callback [typed-event.ts:20](../../../../src/shared/typed-event.ts#L20)
- `fire(...args)` — [typed-event.ts:38](../../../../src/shared/typed-event.ts#L38)
- `dispose()` — [typed-event.ts:48](../../../../src/shared/typed-event.ts#L48)

**Attributes / markers:**
- `epoch` — envelope field that identifies the current host lifetime; a bump triggers recovery
- `sequence` — envelope field carrying monotonic event ordering; gaps trigger recovery
- `recoveryPending` — internal flag preventing concurrent `getState` recovery calls

**Namespaces:**
- [src/shared/agent-connection-client.ts](../../../../src/shared/agent-connection-client.ts) — the transport-neutral client
- [src/shared/typed-event.ts](../../../../src/shared/typed-event.ts) — pub/sub primitive
- [src/webview/vscode-agent-connection.ts](../../../../src/webview/vscode-agent-connection.ts) — browser-only VS Code webview adapter

## Lifecycle edges

**Depends on:**
- [protocol-runtime](../protocol-runtime/protocol-runtime.md) — every incoming envelope is filtered through the guards declared there; timeout / envelope constants come from `connection-protocol.ts`.
- [message-protocol](../message-protocol/message-protocol.md) — the client's request and event payloads are members of those unions.

**Used by:**
- [desktop-ipc-contract](../../10-standalone-desktop-host/desktop-ipc-contract/desktop-ipc-contract.md) — `AgentConnectionClient` is extended, not replaced.
- [webview-architecture](../../06-ui-surfaces-webview/webview-architecture/webview-architecture.md) — the transport client all webviews wrap.

## See also

- **Rule — a transport is only two callbacks.** If a new host (Electron, dev bridge) needs to reuse this client, implement `AgentConnectionTransport` — `send` and `subscribe`. Do not extend the client itself.
- **Rule — never block subscribers with exceptions.** The client wraps each listener call in `try/catch` deliberately; a broken listener must not stall event delivery or state recovery. If you add a listener, keep it resilient — but the client will keep going regardless.
- **Pattern — recovery is auto-triggered by envelope metadata.** Neither the transport nor the caller needs to know reconnection happened. `epoch` bump or `sequence` gap → single `getState` request → subscribers re-hydrate from the resulting `stateSync`.
- **Pattern — `confirmAction` never times out.** It represents a user-facing confirmation dialog; imposing a timeout would race the user's attention. Any new request type that waits on human interaction should join the "undefined timeout" path in `getAgentRequestTimeoutMs`.
- **Pitfall — the pending-request map is cleared on `close()`.** Every pending request rejects with `transport_closed`. Callers must not assume a lingering resolution after their transport goes away.
- **Pitfall — `createClientId` falls back to `Math.random`.** In environments without `crypto.randomUUID` the identifier is still unique enough for a session but not cryptographically strong. Do not use it for anything but wire-level correlation.
- **Pattern — `TypedEventEmitter` is deliberately minimal.** No wildcard listener, no priority ordering, no async dispatch. It's just enough for typed subscribe/fire; deeper needs go to `EventRouter` (see [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md)).
