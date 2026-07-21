# Chapter: launcher-view

The activity-bar sidebar is a `WebviewViewProvider` — always visible when the Pi Code icon is selected, showing tabs, recent sessions, per-tab ToDo, subagents, Plan Mode toggle, tool selection, notifications. [`LauncherView`](../../../../src/providers/launcher-view.ts) owns the host-side wiring; [src/webview/launcher.ts](../../../../src/webview/launcher.ts) renders the DOM.

Unlike chat panels (which are per-tab), the launcher is a **singleton** — one sidebar view for the whole window, showing everything at once. Its state (`LauncherState`) is a projection of the `ChatController`'s multi-tab world.

## Article roster

- [launcher-view](launcher-view.md) — `LauncherView` provider registration, `LauncherState` projection, the 31 launcher client messages, and the render-state preservation trick.

## Reader task

The reader arrives here to answer one of:

- "Where does the sidebar get its list of tabs?"
- "How is the Plan Mode toggle wired to the running session?"
- "Why does scrolling in the sidebar not reset on every state update?"
- "How does the tool-selection paste work?"

## Neighborhood

- **State projection** — `LauncherState` is assembled in [src/core/chat/launcher-projection.ts](../../../../src/core/chat/launcher-projection.ts); see [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md).
- **Message tree** — `LauncherClientMessage` / `LauncherServerMessage` are declared in [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md).
- **Subagent snapshots** — the launcher displays live subagent status; source in [Part IX § subagent-manager-and-lifecycle](../../09-subagents/subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md).

## Non-goals

- Individual tab rendering (chat webview) is [chat-panel-provider](../chat-panel-provider/chat-panel-provider.md).
- Settings UI is [settings-panel](../settings-panel/settings-panel.md).
- Tool policy — what the toggles actually mean at runtime — is [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
