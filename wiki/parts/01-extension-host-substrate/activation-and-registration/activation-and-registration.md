# activation-and-registration

## Stance

Activation is a single-shot integration function, not a controller. Its job is to instantiate long-lived services in the right order and hand each one to `context.subscriptions` so VS Code disposes them on window close. Anything more clever — routing state, orchestrating tabs, reacting to agent events — belongs to the [`ChatController`](../../../../src/controllers/chat-controller.ts) it constructs, not to [`activate()`](../../../../src/extension.ts#L39) itself.

## Role

[src/extension.ts](../../../../src/extension.ts) exposes two functions: `activate(context)` and `deactivate()`. Activation is deferred by manifest `activationEvents` in [package.json](../../../../package.json); once triggered, it:

1. **Builds VS Code adapters** — [`VsCodeSecretStore`](../../../../src/adapters/vscode/session-platform.ts) wraps `context.secrets`; [`createVsCodeSessionRuntimePorts`](../../../../src/adapters/vscode/session-platform.ts) aggregates workspace / settings / dialogs / secrets / logger / session-lock into one `SessionRuntimePorts` bag consumed by the Pi session manager.
2. **Constructs the portable core**. A single [`ChatController`](../../../../src/controllers/chat-controller.ts) owns the [`ChatHost`](../../../../src/core/chat/chat-host.ts) shared by every tab; per-tab managers ([`PiSessionManager`](../../../../src/pi/session.ts), [`DiffManager`](../../../../src/providers/diff.ts), [`CheckpointManager`](../../../../src/providers/checkpoint.ts)) are created on demand when a new chat tab is opened.
3. **Registers commands, providers, serializers** into `context.subscriptions` so their `dispose()` runs on deactivation.
4. **Bridges VS Code events into portable state**. The one non-trivial subscription is [`context.secrets.onDidChange`](../../../../src/extension.ts#L82): whenever the user stores a key prefixed `pi-code.apiKey.<provider>` in secret storage, it re-reads credentials via [`reloadCredentials()`](../../../../src/pi/auth.ts#L44) and fires [`notifyAuthChanged()`](../../../../src/pi/auth.ts#L23) so open tabs refresh their model lists without a window reload.
5. **Warms up caches** — `fileMentions.warmup()` and the launcher-visible sessions list — so the first user interaction is instant.

`deactivate()` is deliberately narrow: dispose the `SubagentCoordinator` and call [`PiSessionManager.disposeGlobal()`](../../../../src/pi/session.ts) so the SDK releases its shared state. Everything else is handled by `context.subscriptions` unwinding.

## Keywords

**Types — activation entry:**
- `activate` — function [src/extension.ts:39](../../../../src/extension.ts#L39)
- `deactivate` — function [src/extension.ts:234](../../../../src/extension.ts#L234)
- `ExtensionContext` — VS Code API contract; source of `subscriptions`, `secrets`, `globalStorageUri`, `extensionUri`

**Types — controller:**
- `ChatController` — class [src/controllers/chat-controller.ts:144](../../../../src/controllers/chat-controller.ts#L144)
- `ChatViewSink` — interface [src/controllers/chat-controller.ts:84](../../../../src/controllers/chat-controller.ts#L84); contract for sidebar and panel webviews receiving `ServerMessage`s

**Types — registered providers / serializers:**
- `LauncherView` — activity-bar `WebviewViewProvider` [src/providers/launcher-view.ts](../../../../src/providers/launcher-view.ts)
- `ChatPanelSerializer` — restores editor-tab chat panels across Reload Window [src/providers/chat-panel-serializer.ts](../../../../src/providers/chat-panel-serializer.ts)
- `RawPanelSerializer` — restores RawMode panels [src/providers/raw-panel.ts](../../../../src/providers/raw-panel.ts)
- `SettingsPanel` — singleton webview panel [src/providers/settings-panel.ts](../../../../src/providers/settings-panel.ts)

**Types — view-type identifiers:**
- `CHAT_PANEL_VIEW_TYPE` — `pi-code.chatPanel`, used by the panel serializer
- `RAW_PANEL_VIEW_TYPE` — `pi-code.raw`

**Methods — command registrations (each pushed to `context.subscriptions`):**
- `pi-code.newChat` — [src/extension.ts:149](../../../../src/extension.ts#L149) → `controller.createTab()`
- `pi-code.abort` — [src/extension.ts:155](../../../../src/extension.ts#L155) → `controller.activeSession?.abort()`
- `pi-code.selectModel` — [src/extension.ts:159](../../../../src/extension.ts#L159) → `controller.activeSession?.showModelPicker()`
- `pi-code.toggleThinking` — cycles thinking level [src/extension.ts:164](../../../../src/extension.ts#L164)
- `pi-code.focusChat` — opens or focuses the launcher / active panel [src/extension.ts:172](../../../../src/extension.ts#L172)
- `pi-code.openSettings` — spawns / reveals the settings panel [src/extension.ts:183](../../../../src/extension.ts#L183)
- `pi-code.createTab` — same as `newChat`, kept for API stability [src/extension.ts:192](../../../../src/extension.ts#L192)
- `pi-code.showSessions` — focuses the launcher [src/extension.ts:196](../../../../src/extension.ts#L196)
- `pi-code.openRawView` — spawns / reveals RawMode for the current session [src/extension.ts:201](../../../../src/extension.ts#L201)

**Methods — provider / serializer registrations:**
- `vscode.window.registerWebviewViewProvider('pi-code.chat', launcher)` — [src/extension.ts:136](../../../../src/extension.ts#L136)
- `vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_VIEW_TYPE, ChatPanelSerializer)` — [src/extension.ts:215](../../../../src/extension.ts#L215)
- `vscode.window.registerWebviewPanelSerializer(RAW_PANEL_VIEW_TYPE, RawPanelSerializer)` — [src/extension.ts:219](../../../../src/extension.ts#L219)

**Attributes / markers:**
- `context.subscriptions` — array of `Disposable`; VS Code disposes every entry on deactivation
- `context.secrets.onDidChange` — event fired when *any* secret in this extension's namespace changes; filtered here by prefix `pi-code.apiKey.`

**Namespaces:**
- `src/extension.ts` — activation entry
- `src/controllers/chat-controller.ts` — the controller instantiated once here
- `src/adapters/vscode/session-platform.ts` — factories for VS Code-flavored ports

## Lifecycle edges

**Depends on:**
- [configuration-and-secrets](../configuration-and-secrets/configuration-and-secrets.md) — reads `pi-code.*` config and stores / retrieves API keys through the same `pi-code.apiKey.<provider>` prefix documented there.
- [bundle-targets-and-esbuild](../bundle-targets-and-esbuild/bundle-targets-and-esbuild.md) — activation code lives in the extension-host CJS bundle; the packaging invariants (externalized SDK, hoisted `node_modules`) determine what it can `require`.
- [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — every registered provider and serializer eventually posts `ServerMessage`s built from these types.
- [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — activation constructs the `ChatController` that owns the portable `ChatHost`.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — each new tab spawns a `PiSessionManager` whose bootstrap is documented there.

**Used by:**
- [bundle-targets-and-esbuild](../bundle-targets-and-esbuild/bundle-targets-and-esbuild.md) — extension host bundle target has to include everything `activate()` transitively imports; changing entry point layout ripples here.
- [chat-panel-provider](../../06-ui-surfaces-webview/chat-panel-provider/chat-panel-provider.md) — `ChatPanelSerializer` and the `openOrFocusPanel` command are registered from `activate()`.
- [configuration-and-secrets](../configuration-and-secrets/configuration-and-secrets.md) — the sole subscriber to `context.secrets.onDidChange` and the only place `SettingsPanel.show` is bound to a command.
- [vscode-workspace-and-diff](../../04-platform-adapters/vscode-workspace-and-diff/vscode-workspace-and-diff.md) — `DiffContentProvider` is registered once from `activate()` with `vscode.workspace.registerTextDocumentContentProvider`.

## See also

- **Rule — dispose everything.** Every disposable created in `activate()` MUST be pushed into `context.subscriptions`. Anything left dangling survives the window and leaks the underlying VS Code disposable (event listener, output channel, secret watcher).
- **Rule — do not register commands lazily.** VS Code binds command IDs to keybindings via [package.json contributes.commands](../../../../package.json). Registering a command inside a method that only fires after user action leaves the keybinding no-op until then. All commands must be registered from `activate()`.
- **Pattern — secrets are broadcast, not owned.** [`context.secrets.onDidChange`](../../../../src/extension.ts#L82) is filtered by the `pi-code.apiKey.` prefix, then dispatched into `reloadCredentials()` + `notifyAuthChanged()`. Nothing else in the codebase watches `context.secrets` directly; downstream code subscribes to [`onAuthChanged`](../../../../src/pi/auth.ts#L21) instead. That decoupling keeps VS Code-specific event plumbing out of the portable core.
- **Pattern — controller as sink registrar.** The `ChatController` exposes an [`attachViewSink()`](../../../../src/controllers/chat-controller.ts) API so multiple webviews (launcher, editor panels) can register as observers of the same underlying state. `activate()` wires the launcher; each editor panel wires itself when created.
- **Pitfall — order matters for `PiSessionManager.disposeGlobal()`.** It releases SDK-shared resources; calling it before individual tab sessions have disposed leaves dangling handles. Deactivation ordering: subscriptions unwind first (each tab session disposes normally), then `disposeGlobal()`.
- Appendix cross-refs: the seam-types appendix does not yet exist; it will be created once cross-cutting concepts accumulate across 3+ chapters.
