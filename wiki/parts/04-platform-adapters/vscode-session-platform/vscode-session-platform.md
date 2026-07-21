# vscode-session-platform

## Stance

VS Code doesn't need a lot of custom adapter logic. Configuration lookup is a one-line `vscode.workspace.getConfiguration('pi-code').get(key, fallback)`. Secret storage is a direct `context.secrets` passthrough. Dialogs are `vscode.window.showQuickPick`. The interesting bit is the factory that stitches these into a single `SessionRuntimePorts` and decides which pieces stay VS Code-native vs. fall through to shared code — session locks, notably, use `NodeSessionLock` so a running VS Code session and a running standalone desktop session cannot both hold the same session-file open.

## Role

Five classes plus one factory:

**[`VsCodeWorkspacePort`](../../../../src/adapters/vscode/session-platform.ts#L27)** — implements `SessionWorkspacePort`. `getRoot()` reads `vscode.workspace.workspaceFolders[0].uri.fsPath` (undefined if none); `isTrusted()` reads `vscode.workspace.isTrusted`; `findFiles(root, include, exclude, maxResults)` delegates to `vscode.workspace.findFiles(new vscode.RelativePattern(root, include), exclude, maxResults)`.

**[`VsCodeSessionSettings`](../../../../src/adapters/vscode/session-platform.ts#L57)** — implements `SessionSettingsPort`. Single method `get<Key>(key, fallback)`: hardcodes the namespace `'pi-code'`. Supported keys mirror `SessionSettingValues`: `allowedTools`, `todo.promptGuidelines`, `lsp.enabled`, `mcp.importClaudeCode`, `thinkingLevel`, `defaultModel`, `subagents.*`.

**[`VsCodeSecretStore`](../../../../src/adapters/vscode/session-platform.ts#L68)** — implements `SecretStore`. Wraps `vscode.SecretStorage`. Methods `get`, `store`, `delete` all delegate directly.

**[`VsCodeSessionDialogs`](../../../../src/adapters/vscode/session-platform.ts#L84)** — implements `SessionDialogPort`. `showWarning(message)` fires and forgets `vscode.window.showWarningMessage(message)`; `selectModel(models, placeHolder)` maps the model list to `vscode.QuickPickItem[]`, calls `vscode.window.showQuickPick`, extracts `{ provider, modelId }` from the selection.

**[`createVsCodeSessionRuntimePorts`](../../../../src/adapters/vscode/session-platform.ts#L106)** — the factory. Takes optional `resources: SessionResourcePaths` and `codexUsage: SessionCodexUsagePort`. Constructs the composite: VS Code workspace / settings / dialogs, a `NodeSessionLock` with `applicationId: 'pi-code-vscode'`, LSP extension creation, MCP-import sync. Falls through to defaults from `DEFAULT_SESSION_RUNTIME_PORTS` when a piece is omitted.

The `NodeSessionLock` choice matters. Both hosts (VS Code, standalone Electron) create it against the same file naming rule (`<sessionPath>.pi-code.lock`) so a running Electron desktop app cannot open the same session file as a running VS Code window. The `applicationId` distinguishes owners in the lock payload — `'pi-code-vscode'` for this factory, `'pi-code-node'` for the Node factory.

The LSP hook (`extensions.createLspExtension(enabled)`) constructs an ExtensionFactory when the `pi-code.lsp.enabled` setting is true; the MCP-import hook (`extensions.syncClaudeCodeMcpImport?(enabled)`) reads the user's Claude Code MCP config once and imports servers into Pi.

## Keywords

**Types — ports:**
- `VsCodeWorkspacePort` — class [session-platform.ts:27](../../../../src/adapters/vscode/session-platform.ts#L27)
- `VsCodeSessionSettings` — class [session-platform.ts:57](../../../../src/adapters/vscode/session-platform.ts#L57)
- `VsCodeSecretStore` — class [session-platform.ts:68](../../../../src/adapters/vscode/session-platform.ts#L68)
- `VsCodeSessionDialogs` — class [session-platform.ts:84](../../../../src/adapters/vscode/session-platform.ts#L84)

**Types — factory:**
- `createVsCodeSessionRuntimePorts` — function [session-platform.ts:106](../../../../src/adapters/vscode/session-platform.ts#L106)
- `SessionRuntimePorts` — port surface [src/core/ports/session-platform.ts](../../../../src/core/ports/session-platform.ts)

**Methods — workspace:**
- `getRoot(): string | undefined`
- `isTrusted(): boolean`
- `findFiles(root, include, exclude, maxResults): Promise<string[]>`

**Methods — settings / secrets / dialogs:**
- `get<Key extends keyof SessionSettingValues>(key, fallback)`
- `SecretStore.{get, store, delete}`
- `showWarning(message)`, `selectModel(models, placeHolder)`

**Attributes / markers:**
- Config namespace: `'pi-code'` — hardcoded in `VsCodeSessionSettings`; do not template
- Session-lock `applicationId`: `'pi-code-vscode'`
- Warning messages are fire-and-forget — VS Code does not block the extension host on them

**Namespaces:**
- [src/adapters/vscode/session-platform.ts](../../../../src/adapters/vscode/session-platform.ts) — all four adapters + factory

## Lifecycle edges

**Depends on:**
- [node-platform-adapters](../node-platform-adapters/node-platform-adapters.md) — `NodeSessionLock` is used verbatim (only `applicationId` differs).
- [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — every class implements one of those interfaces.
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — the settings and secret-storage surface the adapters wrap.

**Used by:**
- [lsp-tools](../../11-auxiliary-systems/lsp-tools/lsp-tools.md) — `SessionExtensionPort.createLspExtension` calls this factory.
- [session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — the concrete adapter that supplies those ports in the VS Code host.

## See also

- **Rule — the config namespace is `'pi-code'`.** Do not read from arbitrary namespaces; the manifest reserves this one, and settings must match.
- **Rule — session-lock `applicationId` must not collide across hosts.** VS Code uses `'pi-code-vscode'`; Node uses `'pi-code-node'`. If a third host is ever added, invent a new suffix.
- **Pattern — warnings are cheap; do not `await` them.** `vscode.window.showWarningMessage` returns a Promise resolving to the button the user clicked; the adapter drops it because callers never use the result.
- **Pattern — `selectModel` returns undefined on cancel.** Callers must handle the null case; do not throw.
- **Pitfall — `VsCodeWorkspacePort.getRoot()` may be undefined.** Behavior when no workspace is open is a legitimate use case (single-file editing). The core handles it; do not fabricate a fallback root here.
- **Pitfall — `VsCodeSessionSettings.get` returns the fallback if the key is unset.** Do not conflate "returned fallback" with "read successful" in downstream code; the difference is invisible.
- **Pattern — MCP-import sync fires on setting change.** [Part VI § settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) triggers `_updateSetting` which calls `syncClaudeCodeMcpImport(enabled)`; the effect surfaces through this port so the session platform observes the same behavior across hosts.
