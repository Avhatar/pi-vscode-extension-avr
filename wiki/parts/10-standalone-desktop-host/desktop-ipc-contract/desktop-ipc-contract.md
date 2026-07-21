# desktop-ipc-contract

## Stance

The desktop's IPC contract is a **shrink-wrap around the shared `AgentConnectionClient`**. Two channels (agent + shell) instead of one; a `documentId` envelope so the main process can invalidate stale requests when a renderer reloads; a `DesktopPreloadApi` shape exposed via `contextBridge` so the renderer has a stable Node-free surface. Everything else — request/response semantics, event stream, envelope validation — reuses [Part II § protocol-runtime](../../02-shared-protocol-and-contracts/protocol-runtime/protocol-runtime.md).

## Role

Channel constants [ipc-contract.ts:1](../../../../standalone/desktop/src/ipc-contract.ts#L1):

- `DESKTOP_AGENT_REQUEST_CHANNEL` — request/response for agent operations
- `DESKTOP_AGENT_EVENT_CHANNEL` — server-pushed events
- `DESKTOP_SHELL_REQUEST_CHANNEL` — shell lifecycle (welcome, workspace pick, open, new-window)
- `DESKTOP_SHELL_EVENT_CHANNEL` — shell state updates

Envelope [ipc-contract.ts:6](../../../../standalone/desktop/src/ipc-contract.ts#L6):

- `DesktopIpcRequest` — `{ documentId, request }`. The `documentId` is a UUID per renderer document; when the renderer reloads (Cmd/Ctrl-R), it re-registers with a new id. Requests from stale documents get rejected.

Shell types [ipc-contract.ts:11](../../../../standalone/desktop/src/ipc-contract.ts#L11):

- `DesktopShellState` — union with phases `welcome | opening | ready | error`, workspace path progression, `secureStorageAvailable` capability flag.
- `DesktopShellRequest` — `getLaunchState | selectWorkspace | openWorkspace | newWindow`.
- `DesktopShellResponse` — `{ ok, state?, error? }`.

Preload API [ipc-contract.ts:46](../../../../standalone/desktop/src/ipc-contract.ts#L46) — the `DesktopPreloadApi`:

- Agent: `request(payload)`, `subscribe(listener)`.
- Shell: `getLaunchState()`, `selectWorkspace()`, `openWorkspace(path)`, `newWindow()`, `subscribeShell(listener)`.

Preload entry [preload.ts:1](../../../../standalone/desktop/src/preload.ts#L1) — a two-line file: `contextBridge.exposeInMainWorld('piCode', createDesktopPreloadApi(ipcRenderer))`. The API becomes `window.piCode` in the renderer.

Preload factory [preload-api.ts:18](../../../../standalone/desktop/src/preload-api.ts#L18) — `createDesktopPreloadApi(ipcRenderer)`:

- Generates a stable `documentId` per document via `createDocumentId()` [preload-api.ts:55](../../../../standalone/desktop/src/preload-api.ts#L55).
- Wraps every outgoing message in `{ documentId, request }` so the main process can validate.
- `subscribe(listener)` uses `ipcRenderer.on(DESKTOP_AGENT_EVENT_CHANNEL, ...)`.

Renderer connection [renderer-connection.ts:15](../../../../standalone/desktop/src/renderer-connection.ts#L15) — `DesktopAgentConnection` extends `AgentConnectionClient` with `clientIdPrefix: 'desktop'`, `transportLabel: 'Electron IPC'`, and the preload API as the transport. Everything else — request timeouts, epoch/sequence recovery — is inherited unchanged from the shared client.

Main-process handler [electron-ipc.ts:29](../../../../standalone/desktop/src/electron-ipc.ts#L29) — `registerDesktopAgentIpc`:

- Registers on `DESKTOP_AGENT_REQUEST_CHANNEL`.
- Tracks active `documentId` per sender.
- Enforces `getState` as the first message (handshake).
- Rejects cross-document mismatches and stale renderers.

IPC host [ipc-host.ts:56](../../../../standalone/desktop/src/ipc-host.ts#L56) — `DesktopIpcHost`:

- `connections: Map<senderId, ConnectionInfo>` — one entry per active renderer.
- `handle(sender, envelope)` [ipc-host.ts:76](../../../../standalone/desktop/src/ipc-host.ts#L76) — validates via `isAgentClientRequestEnvelope`, handles handshake, routes to the backend (`DesktopAgentBackend`), returns response envelope.
- `publish(message)` [ipc-host.ts:154](../../../../standalone/desktop/src/ipc-host.ts#L154) — broadcasts an `AgentServerMessage` to every connected renderer with fresh sequence numbers via `AgentEventSequencer.create()`.

Shell host [shell-ipc.ts:27](../../../../standalone/desktop/src/shell-ipc.ts#L27) — same pattern as agent host but scoped to shell lifecycle. Enforces `getLaunchState` as the first request.

## Keywords

**Types — channels:**
- `DESKTOP_AGENT_REQUEST_CHANNEL`, `DESKTOP_AGENT_EVENT_CHANNEL`, `DESKTOP_SHELL_REQUEST_CHANNEL`, `DESKTOP_SHELL_EVENT_CHANNEL` — [ipc-contract.ts:1](../../../../standalone/desktop/src/ipc-contract.ts#L1)

**Types — envelopes:**
- `DesktopIpcRequest` — [ipc-contract.ts:6](../../../../standalone/desktop/src/ipc-contract.ts#L6)
- `DesktopShellState`, `DesktopShellRequest`, `DesktopShellResponse` — [ipc-contract.ts:11](../../../../standalone/desktop/src/ipc-contract.ts#L11)
- `DesktopPreloadApi` — [ipc-contract.ts:46](../../../../standalone/desktop/src/ipc-contract.ts#L46)

**Types — implementations:**
- `DesktopAgentConnection` — class [renderer-connection.ts:15](../../../../standalone/desktop/src/renderer-connection.ts#L15); extends `AgentConnectionClient`
- `DesktopIpcHost` — class [ipc-host.ts:56](../../../../standalone/desktop/src/ipc-host.ts#L56)
- `DesktopShellIpcHost` — class [shell-ipc.ts:27](../../../../standalone/desktop/src/shell-ipc.ts#L27)
- `DesktopIpcSender` — interface [ipc-host.ts:27](../../../../standalone/desktop/src/ipc-host.ts#L27); minimal sender contract

**Methods:**
- `createDesktopPreloadApi(ipcRenderer)` — [preload-api.ts:18](../../../../standalone/desktop/src/preload-api.ts#L18)
- `createDocumentId()` — [preload-api.ts:55](../../../../standalone/desktop/src/preload-api.ts#L55)
- `registerDesktopAgentIpc(...)` — [electron-ipc.ts:29](../../../../standalone/desktop/src/electron-ipc.ts#L29)
- `registerDesktopShellIpc(...)` — [shell-ipc.ts:126](../../../../standalone/desktop/src/shell-ipc.ts#L126)
- `DesktopIpcHost.handle(sender, envelope)` — [ipc-host.ts:76](../../../../standalone/desktop/src/ipc-host.ts#L76)
- `DesktopIpcHost.publish(message)` — [ipc-host.ts:154](../../../../standalone/desktop/src/ipc-host.ts#L154)

**Attributes / markers:**
- `documentId` — per-renderer UUID; rebounded on reload; enables stale-renderer rejection
- Handshake: first agent request must be `getState`; first shell request must be `getLaunchState`
- Renderer `clientIdPrefix`: `'desktop'`; label `'Electron IPC'`
- `contextBridge.exposeInMainWorld('piCode', ...)` — the sole exposure surface

**Namespaces:**
- [standalone/desktop/src/ipc-contract.ts](../../../../standalone/desktop/src/ipc-contract.ts) — types and constants
- [standalone/desktop/src/preload-api.ts](../../../../standalone/desktop/src/preload-api.ts) — renderer-side factory
- [standalone/desktop/src/preload.ts](../../../../standalone/desktop/src/preload.ts) — entry point (2 lines)
- [standalone/desktop/src/renderer-connection.ts](../../../../standalone/desktop/src/renderer-connection.ts) — extends shared client
- [standalone/desktop/src/electron-ipc.ts](../../../../standalone/desktop/src/electron-ipc.ts) — main-process registration
- [standalone/desktop/src/ipc-host.ts](../../../../standalone/desktop/src/ipc-host.ts) — agent host implementation
- [standalone/desktop/src/shell-ipc.ts](../../../../standalone/desktop/src/shell-ipc.ts) — shell host implementation

## Lifecycle edges

**Depends on:**
- [Part II § agent-connection-client](../../02-shared-protocol-and-contracts/agent-connection-client/agent-connection-client.md) — `AgentConnectionClient` is extended, not replaced.
- [Part II § protocol-runtime](../../02-shared-protocol-and-contracts/protocol-runtime/protocol-runtime.md) — envelope guards used by the host.
- [desktop-host-lifecycle](../desktop-host-lifecycle/desktop-host-lifecycle.md) — the main-process runtime the host talks to.

**Used by:**
- [desktop-host-lifecycle](../desktop-host-lifecycle/desktop-host-lifecycle.md) — the IPC layer that renders in the window this host creates.

## See also

- **Rule — every request carries `documentId`.** Never bypass. When the renderer reloads, its document id changes; requests from the pre-reload document are dropped rather than routed to the new document's session state.
- **Rule — handshake is per channel.** Agent handshake is `getState`; shell handshake is `getLaunchState`. Do not mix.
- **Pattern — two channels, one message vocabulary.** Agent-domain messages ride on the agent channel; shell-domain messages on the shell channel. Do not multiplex.
- **Pattern — `DesktopAgentConnection` is thin.** It only sets `clientIdPrefix` and `transportLabel`. All heavy lifting stays in the shared client — bug fixes there benefit both hosts.
- **Pitfall — `contextBridge.exposeInMainWorld` is the only exposure.** Do not add ad-hoc `ipcRenderer` usage in the renderer; you break `contextIsolation: true`.
- **Pitfall — sender-id tracking assumes `isDestroyed()` is accurate.** The `DesktopIpcSender` interface [ipc-host.ts:27](../../../../standalone/desktop/src/ipc-host.ts#L27) is minimal so tests can stub it. Do not call `webContents` methods that reject on destroyed senders inside the host.
- **Pattern — `publish` broadcasts to every connection.** Different documents (multi-window) all receive the same events; per-tab filtering happens in the renderer via the sequencer's `tabId` field.
