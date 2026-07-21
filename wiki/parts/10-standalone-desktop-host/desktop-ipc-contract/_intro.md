# Chapter: desktop-ipc-contract

The standalone desktop app is Electron. The renderer runs the same webview bundle as VS Code (browser IIFE), but the transport underneath is **Electron IPC**, not `vscode.postMessage`. This chapter documents the contract: two channels (agent + shell), typed envelopes, document-id validation, and how the renderer's `AgentConnectionClient` plugs into `contextBridge.exposeInMainWorld('piCode', ...)`.

## Article roster

- [desktop-ipc-contract](desktop-ipc-contract.md) — channel constants, `DesktopIpcRequest` envelope, `DesktopShellState` union, preload API, `DesktopAgentConnection` extension of the shared client, and the request/response host in the main process.

## Reader task

The reader arrives here to answer one of:

- "Where do the IPC channel names come from?"
- "How does the main process know which renderer window a request came from?"
- "What's the difference between the agent channel and the shell channel?"
- "How does the desktop reuse the same message types as VS Code?"

## Neighborhood

- **Transport-neutral client** — `AgentConnectionClient` — is [Part II § agent-connection-client](../../02-shared-protocol-and-contracts/agent-connection-client/agent-connection-client.md).
- **The webview bundle** the renderer loads is the same as VS Code's — see [Part VI § webview-architecture](../../06-ui-surfaces-webview/webview-architecture/webview-architecture.md).
- **Host lifecycle** — activation, session storage, ChatHost wiring — is the sibling chapter [desktop-host-lifecycle](../desktop-host-lifecycle/desktop-host-lifecycle.md).

## Non-goals

- Electron's own IPC internals (Chromium message serialization) are not documented here.
- The renderer's DOM code is identical to the VS Code webview and covered there.
- Cross-platform packaging (Windows / macOS installers) is out of scope for the wiki.
