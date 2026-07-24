# Chapter: desktop-host-lifecycle

> **Retired.** The Electron-based standalone desktop host was removed from the
> working tree on 2026-07-22. Articles below describe code that no longer
> exists in the working tree; they are preserved as a historical snapshot.

The Electron app in `standalone/desktop/` (retired) was a second host for the portable chat core. It reused `ChatHost`, `ChatService`, `TabRegistry`, and every port; only the outer scaffolding (Electron `app`, `BrowserWindow`, workspace picker, SafeStorage-backed secret storage) was desktop-specific.

## Article roster

- [desktop-host-lifecycle](desktop-host-lifecycle.md) — Electron activation flow, workspace trust model, session storage differences from VS Code, `DesktopChatRuntime`, process-scoped data directories, shutdown coordination, and the esbuild build script.

## Reader task

The reader arrives here to answer one of:

- "How does the desktop app pick a workspace on first launch?"
- "Where does the desktop app store session data — is it per-process?"
- "How does the shutdown flow ensure data is flushed?"
- "What does `build.mjs` produce, and why is it a separate build from the extension?"

## Neighborhood

- **IPC contract** to the renderer is [desktop-ipc-contract](../desktop-ipc-contract/desktop-ipc-contract.md).
- **Node adapters** (session-lock, workspace, file-mentions, JSON state store) reused here are [Part IV § node-platform-adapters](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md).
- **The portable core** the runtime wires is [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md).

## Non-goals

- Auto-updater, code-signing, cross-platform installer details — not documented here.
- The renderer app (browser bundle) is documented as part of the shared webview architecture.
- Standalone-only asset submodule details (fonts, sprites) live in [AGENTS.md](../../../../AGENTS.md).
