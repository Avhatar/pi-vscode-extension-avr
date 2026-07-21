# Chapter: chat-panel-provider

The user-visible surface of a chat is a VS Code `WebviewPanel` — an editor-area tab containing the chat webview bundle. [`ChatPanel`](../../../../src/providers/chat-panel.ts) is one such panel per chat tab; it wires the webview to the extension-host `ChatController` as a view sink, and its serializer restores the panel across `Reload Window` using a small `{ tabId, sessionPath }` state pointer.

## Article roster

- [chat-panel-provider](chat-panel-provider.md) — `ChatPanel` class as a `ChatViewSink`, `ChatPanelConnection` message framing with handshake / buffering, and `ChatPanelSerializer` restoration semantics.

## Reader task

The reader arrives here to answer one of:

- "Where does the chat webview attach to the extension host?"
- "What happens if the user reloads the window mid-conversation — does the tab come back?"
- "How does the panel decide which tab it is when multiple chats are open?"
- "Why does the first request always have to be `getState`?"

## Neighborhood

- **Controller / sink pattern** is documented in [Part I § activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) (introduces `ChatViewSink`) and [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) (owns the tabs).
- **Webview architecture** is [webview-architecture](../webview-architecture/webview-architecture.md).
- **The `AgentEventSequencer` / recovery machinery** is in [Part II § agent-connection-client](../../02-shared-protocol-and-contracts/agent-connection-client/agent-connection-client.md).

## Non-goals

- Chat UI itself (message rendering, tool cards, streaming buffers) lives in [src/webview/main.ts](../../../../src/webview/main.ts) and is not enumerated here.
- The launcher's "which tab is active" is a separate surface — see [launcher-view](../launcher-view/launcher-view.md).
- Session persistence (JSONL on disk) is a Pi SDK concern.
