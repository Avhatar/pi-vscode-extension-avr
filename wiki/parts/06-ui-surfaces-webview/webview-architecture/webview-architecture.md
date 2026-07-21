# webview-architecture

## Stance

Three invariants govern every webview in Pi Code. **No framework.** The DOM is built manually with an `el()` helper; state is mutated in place; there is no virtual DOM, no JSX, no reactive store. This trades verbosity for zero framework overhead and a tiny bundle. **One transport.** All webviews reach the extension host through `AgentConnectionClient` — request/response with timeouts, subscribe for events, epoch-aware recovery. Do not `postMessage` directly. **Theme through CSS variables.** Every color, border, spacing lookup goes through a `--vscode-*` variable with a hardcoded fallback. Never hardcode a color literal.

## Role

Four IIFE bundles, each with its own entry, share the same architecture:

- [src/webview/main.ts](../../../../src/webview/main.ts) — chat panel
- [src/webview/launcher.ts](../../../../src/webview/launcher.ts) — activity-bar launcher
- [src/webview/settings.ts](../../../../src/webview/settings.ts) — settings panel
- [src/webview/raw.ts](../../../../src/webview/raw.ts) — RawMode panel

Plus helper modules imported by the chat panel:

- [src/webview/vscode-agent-connection.ts](../../../../src/webview/vscode-agent-connection.ts) — transport adapter
- [src/webview/user-message-content.ts](../../../../src/webview/user-message-content.ts) — user-message parsing helper
- [src/webview/file-undo-view.ts](../../../../src/webview/file-undo-view.ts) — file-undo visibility rules
- [src/webview/interrupted-turn-notice.ts](../../../../src/webview/interrupted-turn-notice.ts) — interrupted-turn state reconciliation

**The `el()` helper.** `el(tag, className?)` creates a typed DOM element with optional class. It's the only construction primitive; everything else appends children, sets `textContent`, listens for events with `.addEventListener`. Around 4900 lines of chat UI use this pattern.

**Transport.** [`VsCodeAgentConnection`](../../../../src/webview/vscode-agent-connection.ts#L32) extends `AgentConnectionClient`; construction wraps `acquireVsCodeApi().postMessage` as `send` and `window.addEventListener('message', ...)` as `subscribe`. Requests are timed out per [Part II § protocol-runtime](../../02-shared-protocol-and-contracts/protocol-runtime/protocol-runtime.md); events flow via `connection.subscribe(listener)`.

**State persistence.** Panel webviews call `vscode.setState({ tabId, sessionPath })` on every state change; the [`ChatPanelSerializer`](../../../../src/providers/chat-panel-serializer.ts) uses that stored `state` to restore the correct tab on `Reload Window`. Launcher and settings do not persist state — they always ask the host on connect.

**Drafts.** The chat webview keeps three per-tab maps (`draftTexts`, `draftImages`, `draftFiles`) keyed by `tabId`. Switching tabs saves the current input, restores the target tab's draft. Not persisted across window reload; they live only in the webview's in-memory state.

**Theming.** [src/webview/styles/main.css](../../../../src/webview/styles/main.css) declares a top-level CSS custom property block that maps `--vscode-*` tokens to semantic names (`--bg`, `--fg`, `--border`, `--focus-border`, `--btn-bg`, `--error-fg`, `--link`). Every subsequent rule uses those semantic names. Fallbacks in `var(...)` handle the rare case where a theme omits a `--vscode-*` token.

**Markdown.** The chat webview vendors `marked.js` and installs a custom renderer for code blocks (adds a copy button + language label) and code spans (HTML-escapes to prevent injection). No other webview uses `marked`.

## Keywords

**Types — transport:**
- `VsCodeAgentConnection` — class [vscode-agent-connection.ts:32](../../../../src/webview/vscode-agent-connection.ts#L32); extends `AgentConnectionClient`
- `VsCodePostMessageApi`, `MessageEventSource`, `ConnectionMessageListener` — same file
- `createVsCodeTransport(api, source)` — [vscode-agent-connection.ts:46](../../../../src/webview/vscode-agent-connection.ts#L46)

**Types — helpers:**
- `prepareUserMessageContent(text, images, files)` — [user-message-content.ts](../../../../src/webview/user-message-content.ts); formats the user message payload for the API
- `shouldShowFileUndoView(state)` — [file-undo-view.ts](../../../../src/webview/file-undo-view.ts); visibility predicate
- `mergeStateMessages(...)` — from [interrupted-turn-notice.ts](../../../../src/webview/interrupted-turn-notice.ts); recovers durable turn-lifecycle status into the visible message list

**Methods — DOM:**
- `el(tag, className?)` — the sole construction helper; declared inline in [main.ts:4892](../../../../src/webview/main.ts#L4892) and mirrored in launcher / settings
- `vscode.setState({ tabId, sessionPath })` — panel-mode persistence [main.ts:399](../../../../src/webview/main.ts#L399)

**Methods — transport:**
- `connection.request(message, options?)` — request/response
- `connection.subscribe(listener)` — event stream
- `send(message)` — small wrapper around `connection.request` handling `confirmAction` timeouts

**Attributes / markers:**
- `data-mode="panel" | "sidebar"` — set on `#app` by the panel provider; toggles panel-only vs. sidebar-only UI regions
- `data-tab-id="<tabId>"` — set on `#app` for panel-mode chat; used for state restoration
- CSS variables: `--bg`, `--fg`, `--input-bg`, `--focus-border`, `--btn-bg`, `--btn-fg`, `--error-fg`, `--link`, `--border` — semantic aliases layered over `--vscode-*` tokens

**Namespaces:**
- [src/webview/](../../../../src/webview/) — no `vscode` imports, no Node modules
- [src/webview/styles/](../../../../src/webview/styles/) — CSS shipped as loose files in the VSIX (unignored)

## Lifecycle edges

**Depends on:**
- [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md) — every webview is one IIFE bundle produced by esbuild.
- [Part II § agent-connection-client](../../02-shared-protocol-and-contracts/agent-connection-client/agent-connection-client.md) — the transport client all webviews wrap.
- [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — everything on the wire is a typed union member.

**Used by:**
- [chat-panel-provider](../chat-panel-provider/chat-panel-provider.md) — the panel loads the chat webview bundle described there.
- [launcher-view](../launcher-view/launcher-view.md) — the launcher webview uses the shared transport / DOM pattern.
- [settings-panel](../settings-panel/settings-panel.md) — the settings webview shares the transport / DOM pattern.
- [slash-commands-and-skills-menu](../slash-commands-and-skills-menu/slash-commands-and-skills-menu.md) — transport + DOM patterns.

## See also

- **Rule — no framework, no ambient DOM helpers.** Use `el()`. Do not introduce jQuery-style shortcuts; do not import React.
- **Rule — always route through `AgentConnectionClient`.** A raw `vscode.postMessage(...)` bypasses timeouts, deduplication, and recovery. If a new webview needs a transport, wrap it in a `createXTransport(api, source)` factory that mirrors [`createVsCodeTransport`](../../../../src/webview/vscode-agent-connection.ts#L46).
- **Rule — CSS variables all the way down.** Every color, spacing, radius goes through a `--vscode-*` variable with a fallback. Do not hardcode `#1e1e1e` or `#333`.
- **Pattern — `vscode.setState` is a pointer, not a snapshot.** Store `{ tabId, sessionPath }`, not the whole state. The serializer looks up the actual state from the host on restore.
- **Pattern — drafts are session-lifetime, not persistent.** Users expect that closing and reopening the window forgets drafts (they can retype); switching tabs preserves them (they were typing right there). Match this expectation.
- **Pitfall — `data-mode` and `data-tab-id` are load-bearing.** The panel provider sets them on `#app`. If you introduce a new mode, wire the CSS switches at the same time.
- **Pitfall — bundle size matters.** Webview code loads on every panel open. Every new dependency (a markdown library, a syntax highlighter, an icon set) inflates every load. The `marked.js` inclusion is deliberate and scoped to the chat webview alone.
