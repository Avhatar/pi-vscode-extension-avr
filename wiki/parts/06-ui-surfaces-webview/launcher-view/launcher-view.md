# launcher-view

## Stance

The launcher is a **read-mostly window** onto the ChatController. It receives one message type from the host (`launcherState`, a full snapshot) and sends 31 client messages back (tab lifecycle, collapse toggles, tool ops, subagent controls). Two rules keep it responsive. First, **capture render state before rebuild** — scroll positions, focused input, transient UI state — so a state push doesn't scroll users back to the top of a long recent-sessions list. Second, **the launcher never mutates state directly** — everything goes through `ChatController.dispatch`, which routes to the ChatHost / ChatService and returns via a fresh `launcherState`.

## Role

[`LauncherView`](../../../../src/providers/launcher-view.ts#L10) implements `vscode.WebviewViewProvider`:

- `resolveWebviewView()` [launcher-view.ts:48](../../../../src/providers/launcher-view.ts#L48) — binds the message handler, subscribes to `ChatController.onLauncherStateChanged`, posts an initial `launcherState`.
- Client-message handlers cover [launcher-view.ts:61-215](../../../../src/providers/launcher-view.ts#L61):
  - Tab lifecycle: `createTab`, `openTab`, `closeTab`
  - Sessions: `openSession`, `deleteSession`
  - Collapse toggles: `setHistoryCollapsed`, `setNotificationsCollapsed`, `setTodoCollapsed`
  - Per-tab toggles: `setTodoEnabled`, `setSubagentsEnabled`, `setPlanModeEnabled`, `setFileUndoViewEnabled`
  - Tool selection: `setToolDisabled`, `setToolsBulk`, `copyToolSelection`, `pasteToolSelection`, `setToolSelectionAsProjectDefault`
  - Subagents: `stopSubagent`, `inspectSubagent`, `resumeSubagent`, `steerSubagent`
  - `openSettings` — VS Code command execution

[src/webview/launcher.ts](../../../../src/webview/launcher.ts) is the DOM side:

- `currentState: LauncherState` — the latest snapshot. Updated whenever a `launcherState` message arrives.
- UI-local state (not from server): `toolsSearch`, `toolGroupsCollapsed`, `subagentRowsOpen`. Preserved across re-renders because the server does not know about them.
- `captureRenderState()` [launcher.ts:93](../../../../src/webview/launcher.ts#L93) — before rebuilding the DOM, snapshots scroll offsets and focused element. `restoreRenderState()` re-applies them after rebuild.
- Sections rendered [launcher.ts:134](../../../../src/webview/launcher.ts#L134): toolbar (New chat, Settings), Plan Mode toggle (visible when defined), File Undo View (when active + fileChanges > 0 or rollbackPoint present), Notifications, ToDo, Subagents, Recent Sessions (collapsible), Tools (filterable).

`LauncherState` [src/shared/protocol.ts:229](../../../../src/shared/protocol.ts#L229) is the canonical shape: `tabs`, `recentSessions`, collapsed flags, notifications, todo, subagents, tool selection, plus per-tab toggles.

## Keywords

**Types — provider:**
- `LauncherView` — class [launcher-view.ts:10](../../../../src/providers/launcher-view.ts#L10); implements `vscode.WebviewViewProvider`
- `LauncherState` — snapshot type [protocol.ts:229](../../../../src/shared/protocol.ts#L229)
- `LauncherTabInfo` — [protocol.ts:109](../../../../src/shared/protocol.ts#L109)
- `LauncherSessionInfo` — [protocol.ts:120](../../../../src/shared/protocol.ts#L120)
- `LauncherSubagentSnapshot`, `LauncherSubagentRun`, `LauncherSubagentStatus` — [protocol.ts:185](../../../../src/shared/protocol.ts#L185)

**Types — client messages:**
- `LauncherClientMessage` — union of 31 discriminators [protocol.ts:278](../../../../src/shared/protocol.ts#L278)
- `LauncherServerMessage` — single `{ type: 'launcherState', state }` [protocol.ts:312](../../../../src/shared/protocol.ts#L312)

**Methods — provider:**
- `resolveWebviewView(view, context, token)` — [launcher-view.ts:48](../../../../src/providers/launcher-view.ts#L48)
- Message handler dispatch — [launcher-view.ts:61-215](../../../../src/providers/launcher-view.ts#L61)

**Methods — webview:**
- `captureRenderState()` / `restoreRenderState()` — [launcher.ts:93](../../../../src/webview/launcher.ts#L93); preserve scroll and focus across DOM rebuilds
- `renderSection*()` — one per section (tools, sessions, subagents, …)

**Attributes / markers:**
- View id: `pi-code.chat` — registered from [activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md)
- `retainContextWhenHidden: true` (from panel options) — sidebar keeps its state when the user switches to another activity-bar view

**Namespaces:**
- [src/providers/launcher-view.ts](../../../../src/providers/launcher-view.ts)
- [src/webview/launcher.ts](../../../../src/webview/launcher.ts)
- [src/webview/styles/launcher.css](../../../../src/webview/styles/launcher.css)
- [src/core/chat/launcher-projection.ts](../../../../src/core/chat/launcher-projection.ts) — the projection that assembles `LauncherState`

## Lifecycle edges

**Depends on:**
- [webview-architecture](../webview-architecture/webview-architecture.md) — the launcher webview uses the shared transport / DOM pattern.
- [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — `LauncherState` is a projection of ChatHost tabs / TabRegistry.
- [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — 31 client messages + 1 server message.
- [Part IX § subagent-manager-and-lifecycle](../../09-subagents/subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — subagent snapshots surfaced in the launcher.

**Used by:**
- [plan-mode-and-todos](../../08-message-flow-discipline/plan-mode-and-todos/plan-mode-and-todos.md) — launcher renders the ToDo list.
- [subagent-manager-and-lifecycle](../../09-subagents/subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — launcher renders `LauncherSubagentSnapshot`.

## See also

- **Rule — the launcher is view-only.** All mutations flow through `ChatController.dispatch`. Do not add `LauncherState` writes that bypass the controller; state consistency across the launcher and open chat panels depends on the single dispatch path.
- **Rule — capture scroll before rebuild.** Any DOM change that clobbers state must call `captureRenderState()` first. Otherwise the user experiences the sidebar snapping to the top on every message stream.
- **Pattern — UI-local state stays UI-local.** `toolsSearch`, `toolGroupsCollapsed` are not persisted; the launcher does not send them to the host. Server-persisted state lives in `LauncherState` (via workspaceState).
- **Pattern — collapsible sections toggle via three server-persisted flags.** `setHistoryCollapsed`, `setNotificationsCollapsed`, `setTodoCollapsed`. They round-trip because the user expects the collapsed state to survive `Reload Window`.
- **Pitfall — one launcher, many panels.** The launcher shows *all* tabs; each chat panel is *one*. Message routing depends on `tabId` filtering — do not add "launcher pushes into tab X" shortcuts that skip the controller.
- **Pitfall — Plan Mode toggle affects prompts, not tools.** See [Part VIII § plan-mode-and-todos](../../08-message-flow-discipline/plan-mode-and-todos/plan-mode-and-todos.md) for what it actually does.
- **Pattern — tool copy/paste is a UX-level shortcut over a project-default write.** Copy encodes the current selection into the clipboard; paste applies it to the current tab. "Set as project default" writes to `pi-code.allowedTools` in workspace config.
