# Chapter: node-platform-adapters

`src/adapters/node/` is the parallel adapter tree used by the standalone desktop host, where no `vscode` API is available. The Node adapters implement the same ports as the VS Code ones — `FileStatePort`, `SessionRuntimePorts`, `Logger`, `SessionLockPort`, plus a fuzzy-search `FileMentionsPort` and a JSON-backed `StateStore`. They are also reused *from* the VS Code adapters: `VsCodeWorkspaceFileState` extends `NodeWorkspaceFileState`, and `createVsCodeSessionRuntimePorts` composes in `NodeSessionLock` because the lock file is a cross-host resource.

This chapter documents the Node adapters that either stand alone (used only by the desktop host) or are shared between hosts.

## Article roster

- [node-platform-adapters](node-platform-adapters.md) — `NodeWorkspaceFileState`, `NodeLogger`, `NodeSessionWorkspace`, `ObjectSessionSettings`, `CallbackSessionDialogs`, `createNodeSessionRuntimePorts`, `NodeSessionLock`, `NodeFileMentions`, `JsonStateStore`.

## Reader task

The reader arrives here to answer one of:

- "How does the standalone desktop host know which files exist in the workspace when it can't call `vscode.workspace.findFiles`?"
- "What's the sidecar lock file, and how is a stale lock recovered?"
- "The state file grew past 50 MB. How does the desktop host still open it without blowing memory?"
- "Where's the parity: which Node adapter maps to which port?"

## Neighborhood

- The **port declarations** live in [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md).
- The **VS Code adapters** — which subclass or compose these — are in [vscode-workspace-and-diff](../vscode-workspace-and-diff/vscode-workspace-and-diff.md) and [vscode-session-platform](../vscode-session-platform/vscode-session-platform.md).
- The **standalone desktop host** that consumes these adapters is [Part X](../../../index.md#part-x--standalone-desktop-host).

## Non-goals

- Electron main-process wiring (IPC bridges, window management) belongs to Part X.
- Renderer-side code paths — the renderer runs a browser-only bundle equivalent to the VS Code webview, no adapter code there.
- Adapter-level UI (there is none — dialogs are callbacks).
