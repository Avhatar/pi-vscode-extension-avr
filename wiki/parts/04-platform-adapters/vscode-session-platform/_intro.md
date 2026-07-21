# Chapter: vscode-session-platform

`SessionRuntimePorts` is the wide port surface a Pi session consumes: workspace discovery, settings lookup, secret storage, dialogs, session locks, MCP-import hooks, LSP capability, Codex usage headers. This chapter documents the VS Code-flavored assembly of all of those into one `SessionRuntimePorts` bag via [`createVsCodeSessionRuntimePorts`](../../../../src/adapters/vscode/session-platform.ts).

Not every piece is unique to VS Code — session locks are Node-based and shared with the standalone desktop host. What is VS Code-specific: reading configuration through `vscode.workspace.getConfiguration`, storing secrets in `vscode.SecretStorage`, showing warnings and model pickers through `vscode.window`.

## Article roster

- [vscode-session-platform](vscode-session-platform.md) — `VsCodeWorkspacePort`, `VsCodeSessionSettings`, `VsCodeSecretStore`, `VsCodeSessionDialogs`, the factory that assembles them, and the shared `NodeSessionLock` fallback.

## Reader task

The reader arrives here to answer one of:

- "Where does the extension read the `pi-code.allowedTools` setting?"
- "Which class wraps `vscode.SecretStorage` and what interface does the core see?"
- "How does the model picker actually get to `vscode.window.showQuickPick`?"
- "Why is `applicationId` hardcoded to `'pi-code-vscode'` in the session lock?"

## Neighborhood

- The **port declarations** live in [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md).
- The **Node adapters** for the same ports (used by the standalone desktop host) are in [node-platform-adapters](../node-platform-adapters/node-platform-adapters.md).
- **Configuration and secrets** at the extension level are documented in [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md); this chapter is the concrete adapter side.

## Non-goals

- Anything cross-host (the shared session-lock file format) is documented on the Node side.
- Concrete OAuth flow behavior is a Pi SDK detail, not an adapter concern.
- The claude-compat MCP-import syncing is a hook the session platform exposes; the *policy* lives in [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md).
