# chat-panel-provider

## Stance

A chat panel is a webview + a sink + a connection. The **panel** owns the `vscode.WebviewPanel`, its HTML, its dispose lifecycle. The **sink** implements `ChatViewSink` and registers with the shared `ChatController` so state updates for this tab flow to *this* panel. The **connection** frames every inbound / outbound envelope with `AgentEventSequencer` and enforces a strict `getState` handshake before any other request is honored. Splitting the three keeps state routing (which tab does this message belong to?) separate from wire framing (has recovery happened?) separate from VS Code lifecycle (was the panel closed?).

## Role

[`ChatPanel`](../../../../src/providers/chat-panel.ts#L23) implements `ChatViewSink` and `vscode.Disposable`:

- Constructor takes the VS Code panel + tabId + the ChatController; registers as a sink filtered by tabId, sends the initial `ready` message, calls `sendStateSync`.
- `tabFilter` getter returns `this._tabId` so the controller routes only this tab's `ServerMessage`s here.
- `post(message: ServerMessage)` delegates to [`ChatPanelConnection.publish()`](../../../../src/providers/chat-panel-connection.ts#L24).
- `dispose()` unregisters the sink and cleans up listeners.
- `_getHtml()` [chat-panel.ts:116](../../../../src/providers/chat-panel.ts#L116) generates the panel HTML: `data-mode="panel"`, `data-tab-id="<tabId>"` on `#app`; loads `main.js` + `main.css` from `out/webview/`; injects the user's `pi-code.userMessageGlowColor` / `Opacity` as inline CSS.

[`ChatPanelConnection`](../../../../src/providers/chat-panel-connection.ts#L24) is the wire adapter:

- `receive(value)` [chat-panel-connection.ts:24](../../../../src/providers/chat-panel-connection.ts#L24) — validates `AgentRequestEnvelope`, dispatches to the controller. Enforces two invariants: (a) **first request must be `getState`** — a handshake so the client and host agree on identity before anything mutating; (b) **tab mismatch is fatal** — if the envelope claims a different tabId than the panel owns, respond with an error.
- `publish(message)` [chat-panel-connection.ts:24](../../../../src/providers/chat-panel-connection.ts#L24) — buffers up to 100 messages while `sequencer` is not yet initialized (before the handshake); once ready, wraps each in an `AgentEventEnvelope` via `AgentEventSequencer.create()` and `postMessage`s to the webview.

[`ChatPanelSerializer`](../../../../src/providers/chat-panel-serializer.ts#L16) restores panels across `Reload Window`:

- `deserializeWebviewPanel(panel, state)` reads the persisted `{ tabId?, sessionPath? }`.
- If `sessionPath` maps to an existing tab, reuse its id. If not, create the tab from history using `sessionPath`. If both fail, fall back to `activeTabId`.
- Never trusts the persisted `tabId` blindly — tabs may have been removed, renamed, or recreated with a different id since the last save.

## Keywords

**Types — panel:**
- `ChatPanel` — class [chat-panel.ts:23](../../../../src/providers/chat-panel.ts#L23); implements `ChatViewSink` and `vscode.Disposable`
- `ChatViewSink` — interface [chat-controller.ts:84](../../../../src/controllers/chat-controller.ts#L84)

**Types — connection:**
- `ChatPanelConnection` — class [chat-panel-connection.ts:24](../../../../src/providers/chat-panel-connection.ts#L24)
- `AgentEventSequencer` — from [Part II § protocol-runtime](../../02-shared-protocol-and-contracts/protocol-runtime/protocol-runtime.md)

**Types — serializer:**
- `ChatPanelSerializer` — class [chat-panel-serializer.ts:16](../../../../src/providers/chat-panel-serializer.ts#L16); implements `vscode.WebviewPanelSerializer`
- `CHAT_PANEL_VIEW_TYPE` — constant `'pi-code.chatPanel'`

**Methods — panel:**
- `post(message)` — [chat-panel.ts](../../../../src/providers/chat-panel.ts); receives from `ChatController`, forwards to connection
- `dispose()` — unregisters sink, cleans up
- `_getHtml()` — [chat-panel.ts:116](../../../../src/providers/chat-panel.ts#L116); panel HTML template

**Methods — connection:**
- `receive(value)` — [chat-panel-connection.ts:24](../../../../src/providers/chat-panel-connection.ts#L24)
- `publish(message)` — same file; buffered when `sequencer` not yet installed
- Buffer cap: 100 (defensive; drops beyond)

**Methods — serializer:**
- `deserializeWebviewPanel(panel, state)` — [chat-panel-serializer.ts:16](../../../../src/providers/chat-panel-serializer.ts#L16)

**Attributes / markers:**
- Persisted `state`: `{ tabId?: string, sessionPath?: string }` — minimal pointer
- Handshake: **first envelope must be `getState`**; any other type before the handshake is rejected
- Tab mismatch: envelope `tabId !== panel._tabId` is a fatal error response

**Namespaces:**
- [src/providers/chat-panel.ts](../../../../src/providers/chat-panel.ts)
- [src/providers/chat-panel-connection.ts](../../../../src/providers/chat-panel-connection.ts)
- [src/providers/chat-panel-serializer.ts](../../../../src/providers/chat-panel-serializer.ts)

## Lifecycle edges

**Depends on:**
- [webview-architecture](../webview-architecture/webview-architecture.md) — the panel loads the chat webview bundle described there.
- [Part I § activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) — `ChatPanelSerializer` and the `openOrFocusPanel` command are registered from `activate()`.
- [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — the `ChatController` this panel registers with owns the tab / session state.
- [Part II § protocol-runtime](../../02-shared-protocol-and-contracts/protocol-runtime/protocol-runtime.md) — `AgentEventSequencer` and envelope guards used by the connection.

**Used by:**
- [slash-commands-and-skills-menu](../slash-commands-and-skills-menu/slash-commands-and-skills-menu.md) — the slash menu only exists inside the chat panel.

## See also

- **Rule — one panel per tab.** Never share a `ChatPanel` between tabs. The sink's `tabFilter` is what makes multi-tab routing safe; violating it will mix state across chats.
- **Rule — handshake first.** A webview must send `getState` before anything else. This lets the extension host validate its `clientId` claim and set up the sequencer before mutations start.
- **Pattern — persisted state is a pointer.** `{ tabId?, sessionPath? }` — nothing else. The tab's actual serialized state comes from the controller after restoration.
- **Pattern — buffer during handshake.** `publish` calls before the sequencer is installed go into a bounded buffer, then flush once the sequencer exists. Do not drop messages while waiting for the handshake.
- **Pitfall — do not trust the persisted tabId.** Tabs can be closed / recreated between reloads; the serializer falls back through `sessionPath` → active tab → new tab.
- **Pitfall — cross-tab envelope is not a hint, it's an error.** If a panel bound to tab A receives an envelope claiming tab B, do not "route it correctly" — reject. That mismatch means state got confused somewhere and rerouting would mask the bug.
- **Pattern — CSS glow is inlined into the HTML.** `userMessageGlowColor` / `Opacity` are user config; the panel injects them at HTML-render time rather than passing through as messages, because they must be present before the first paint.
