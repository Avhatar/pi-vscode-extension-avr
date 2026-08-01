# configuration-and-secrets

## Stance

Two rules govern configuration. First, `pi-code.apiProvider` is a settings-panel hint, not a runtime provider switch; the selected model determines its provider. Second, manual API keys never enter `settings.json` or Pi's persistent auth files. They live in VS Code `SecretStorage` under `pi-code.apiKey.<providerId>` and are copied into the process-wide Pi SDK `ModelRuntime` as non-persistent overrides.

## Role

The circuit has three parts:

1. **Manifest declarations** — [package.json § contributes.configuration](../../../../package.json) enumerates `pi-code.*` keys. Extension code reads them through `vscode.workspace.getConfiguration('pi-code')`.
2. **Settings panel** — [`SettingsPanel`](../../../../src/providers/settings-panel.ts) presents configuration, manual-key, and OAuth controls. Host and webview exchange typed `SettingsData`, `SettingsClientMessage`, and `SettingsServerMessage` values from [src/shared/protocol.ts](../../../../src/shared/protocol.ts).
3. **Credential bridge** — [`src/pi/auth.ts`](../../../../src/pi/auth.ts) owns the canonical `ModelRuntime`. `getModelRuntime(secrets?)` synchronizes `KNOWN_PROVIDERS`; `reloadCredentials()` re-reads them after a secret change. Changed keys call `setRuntimeApiKey(..., { allowNetwork: false })`; removed keys call `removeRuntimeApiKey()` on a runtime created with catalog networking disabled.

`activate()` subscribes once to `context.secrets.onDidChange`. For the `pi-code.apiKey.` prefix, it awaits credential reload, refreshes the model projection, and calls `notifyAuthChanged(providerId)`. All tabs share the runtime, so rotated or removed keys reach parent and child sessions without recreating per-tab credential stores.

OAuth is distinct from manual keys. The settings host derives OAuth-capable providers from `ModelRuntime.getProviders()`, checks state with `checkAuth()`, and invokes `login(providerId, 'oauth', interaction)` / `logout(providerId)`. The SDK persists and refreshes OAuth credentials; Pi Code's [`OAuthLoginFlow`](../../../../src/pi/oauth-login-flow.ts) supplies the typed interaction UI.

## Keywords

**Settings protocol:**
- `SettingsData`
- `OAuthProviderInfo`
- `OAuthFlowState`: `idle | starting | awaitingSelection | awaitingPrompt | awaitingBrowser | awaitingDeviceCode | progress | success | error`
- `SettingsClientMessage`, `SettingsServerMessage`

**Auth bridge:**
- `ModelRuntime` — canonical SDK runtime
- `SecretStore` — portable secret port backed by VS Code `SecretStorage`
- `KNOWN_PROVIDERS`
- `getModelRuntime(secrets?)`, `reloadCredentials()`, `notifyAuthChanged()`, `disposeModelRuntime()`
- `pi-code.apiKey.*` — fixed SecretStorage prefix

**Settings host:**
- `SettingsPanel.show()`
- `_sendSettings()`
- `_updateSetting(key, value)`
- `_detectAuthMethod()`
- `_getOAuthProviders()`
- `_startOAuthLogin()`, `_oauthLogout()`

## Lifecycle edges

**Depends on:**
- [activation-and-registration](../activation-and-registration/activation-and-registration.md) — secret-change subscription and settings command registration.
- [models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md) — canonical runtime and model/provider projection.
- [message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — typed settings messages.

**Used by:**
- [activation-and-registration](../activation-and-registration/activation-and-registration.md) — reads `pi-code.*` config and stores / retrieves API keys through the same `pi-code.apiKey.<provider>` prefix documented there.
- [claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md) — `pi-code.claudeCompat.enabled` / `pi-code.claudeCompat.mode` gate activation.
- [lsp-tools](../../11-auxiliary-systems/lsp-tools/lsp-tools.md) — `pi-code.lsp.enabled` setting.
- [message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — `SettingsData` is one of the artefacts declared here and consumed there.
- [models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md) — owns persistence and the secret-change subscription.
- [plan-mode-and-todos](../../08-message-flow-discipline/plan-mode-and-todos/plan-mode-and-todos.md) — `pi-code.planMode.defaultEnabled`, `pi-code.todo.promptGuidelines`, `pi-code.todo.defaultEnabled` settings.
- [settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) — `SettingsData`, `KNOWN_PROVIDERS`, and the `ModelRuntime` SecretStorage bridge live there.
- [subagent-manager-and-lifecycle](../../09-subagents/subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — `pi-code.subagents.*` settings.
- [vscode-session-platform](../../04-platform-adapters/vscode-session-platform/vscode-session-platform.md) — the settings and secret-storage surface the adapters wrap.

## See also

- **Rule — never store API keys in configuration.** New manual-key providers go into SecretStorage under the standard prefix and into `KNOWN_PROVIDERS`; add a matching `API_KEY_PROVIDERS` entry when they also need settings UI.
- **Rule — update the full setting circuit.** Manifest declaration → shared protocol → settings host → webview.
- **Pitfall — the key prefix appears in three places.** `auth.ts`, the settings-panel key handler, and the `extension.ts` secret-change filter. Grep the literal before changing it.
- **Pattern — `apiProvider` is cosmetic.** Model selection decides runtime provider and credential resolution.
- **Pattern — manual keys override SDK-resolved credentials only in memory.** OAuth and environment credentials remain SDK-owned; deleting a manual key exposes the next configured source.
- **Pitfall — runtime initialization is asynchronous.** The externalized Pi SDK is dynamically imported; callers must await `getModelRuntime()`.
