# Chapter: agent-connection-client

The extension has three transports that all carry the same messages: the VS Code webview `postMessage` bridge, an Electron IPC channel used by the standalone desktop host, and a development transport used by tests. They share one client — [`AgentConnectionClient`](../../../../src/shared/agent-connection-client.ts) — that turns a plain `send(value)` + `subscribe(listener)` pair into a request/response API with timeouts, epoch-aware event correlation, and reconciliation after a disconnect.

Nothing in this chapter is host-specific. The VS Code webview adapter (`src/webview/vscode-agent-connection.ts`) is a thin wrapper; the desktop renderer has its own equivalent. Both extend the same client and reuse the same recovery logic.

## Article roster

- [agent-connection-client](agent-connection-client.md) — the transport-neutral client, its request map, epoch / sequence handling, `TypedEventEmitter` primitive, and the VS Code webview transport adapter.

## Reader task

The reader arrives here to answer one of:

- "How does the webview detect that the extension host restarted?"
- "Where do I hook a listener for server-pushed events across every transport?"
- "What happens to a pending request if the transport closes mid-flight?"
- "Why is `TypedEventEmitter` its own thing and not `EventEmitter` from Node?"

## Neighborhood

- The **envelope schemas and guards** the client relies on are documented in [protocol-runtime](../protocol-runtime/protocol-runtime.md).
- The **VS Code-specific transport** is the browser-only adapter in [src/webview/vscode-agent-connection.ts](../../../../src/webview/vscode-agent-connection.ts); the analogous **Electron renderer transport** is documented in [Part X § desktop-ipc-contract](../../../index.md#part-x--standalone-desktop-host).
- The **extension-host side that produces the events** (fires state changes, publishes stream chunks) lives in Parts III / V. That side is not the client's problem — the client only *consumes* what the host produces.

## Non-goals

- Reconnection policy (should we auto-reconnect? with what backoff?) is up to the transport implementation.
- Session-lock semantics, credentials, and other host-facing side effects of a reconnect are not this client's concern.
- Producing envelopes on the host side lives in whichever host-specific bridge module owns that transport.
