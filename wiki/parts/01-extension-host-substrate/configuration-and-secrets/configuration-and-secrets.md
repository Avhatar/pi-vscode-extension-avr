# configuration-and-secrets

## Stance

Two rules govern every setting in this extension. First: **the `pi-code.apiProvider` config key is cosmetic** — it controls which provider tab the settings panel opens on, not which provider is used at runtime. Runtime provider selection is driven by the *model* the user picks; the model's `provider` field decides which credential the SDK reaches for. Second: **API keys are never in `settings.json`**. They live in `vscode.SecretStorage` under the fixed prefix `pi-code.apiKey.<providerId>`, and the only ceremony that gets them into the running agent is [`reloadCredentials()`](../../../../src/pi/auth.ts#L44) plus a fired [`onAuthChanged`](../../../../src/pi/auth.ts#L21) event.

## Role

The chapter has three moving parts:

1. **Manifest declarations** — [package.json § contributes.configuration](../../../../package.json) enumerates every `pi-code.*` key. VS Code renders the Settings UI for these automatically; extension code reads via `vscode.workspace.getConfiguration('pi-code').get<T>(key, default)`.
2. **Settings panel webview** — [`SettingsPanel`](../../../../src/providers/settings-panel.ts) is a singleton `WebviewPanel` that presents an opinionated form for the same keys plus per-provider API-key entry and OAuth flow controls. It round-trips a [`SettingsData`](../../../../src/shared/protocol.ts) payload defined in [src/shared/protocol.ts:60](../../../../src/shared/protocol.ts#L60).
3. **Auth bridge** — [`AuthStorage`](../../../../src/pi/auth.ts) is a lazily-loaded singleton (proxying Pi SDK's own `AuthStorage`) with a Node-visible cache. When a secret changes, [`reloadCredentials()`](../../../../src/pi/auth.ts#L44) iterates [`KNOWN_PROVIDERS`](../../../../src/pi/auth.ts#L7) and, for each entry, either calls `storage.setRuntimeApiKey(provider, key)` or `removeRuntimeApiKey(provider)`.

The invariant that makes hot-reload work: `context.secrets.onDidChange` is subscribed exactly once in `activate()`; the handler tests the changed key's prefix, calls `reloadCredentials()`, and fires `notifyAuthChanged(providerId?)`. Everyone downstream — tab controllers, launcher badge counts, model pickers — listens on `onAuthChanged` and re-queries the model registry.

## Keywords

**Types — settings surface:**
- `SettingsData` — [src/shared/protocol.ts:60](../../../../src/shared/protocol.ts#L60) (apiProvider, apiKeySet, configuredProviders, authMethod, defaultModel, thinkingLevel, allowedTools, todoPromptGuidelines, subagentsDefault*, lspEnabled, mcpImportClaudeCode, userMessageGlow*, oauthProviders)
- `OAuthProviderInfo` — sibling shape describing per-provider OAuth availability
- `OAuthFlowState` — [src/shared/protocol.ts:89](../../../../src/shared/protocol.ts#L89) discriminated union: `idle | starting | awaitingSelection | awaitingPrompt | awaitingBrowser | awaitingDeviceCode | progress | success | error`

**Types — settings panel:**
- `SettingsPanel` — class [src/providers/settings-panel.ts:27](../../../../src/providers/settings-panel.ts#L27); singleton via `SettingsPanel.show()`
- `SettingsClientMessage` — inbound from webview [src/shared/protocol.ts:316](../../../../src/shared/protocol.ts#L316)
- `SettingsServerMessage` — outbound to webview [src/shared/protocol.ts:335](../../../../src/shared/protocol.ts#L335)

**Types — auth bridge:**
- `AuthStorage` — re-exported SDK class; runtime credential map
- `KNOWN_PROVIDERS` — const array [src/pi/auth.ts:7](../../../../src/pi/auth.ts#L7); 25+ provider ids (anthropic, openai, google, deepseek, mistral, groq, cerebras, xai, openrouter, fireworks, bedrock, vertex, azure, kimi, minimax, gateway, qwen, qwen-cn, zai, …)
- `TypedEventEmitter<string | undefined>` — from [src/shared/typed-event.ts](../../../../src/shared/typed-event.ts); backs `onAuthChanged`

**Methods — auth:**
- `getAuthStorage(secrets?)` — [src/pi/auth.ts:27](../../../../src/pi/auth.ts#L27); lazy-load + secret sync
- `reloadCredentials()` — [src/pi/auth.ts:44](../../../../src/pi/auth.ts#L44); re-read all `KNOWN_PROVIDERS` keys
- `notifyAuthChanged(providerId?)` — [src/pi/auth.ts:23](../../../../src/pi/auth.ts#L23); fires typed event
- `disposeAuthStorage()` — [src/pi/auth.ts:64](../../../../src/pi/auth.ts#L64); clears cache (tests)
- `applySecretsToStorage()` — [src/pi/auth.ts:53](../../../../src/pi/auth.ts#L53); internal fan-out

**Methods — settings panel:**
- `SettingsPanel.show()` — static factory [src/providers/settings-panel.ts:64](../../../../src/providers/settings-panel.ts#L64)
- `_sendSettings()` — [src/providers/settings-panel.ts:231](../../../../src/providers/settings-panel.ts#L231); builds & posts `SettingsData`
- `_updateSetting(key, value)` — [src/providers/settings-panel.ts:223](../../../../src/providers/settings-panel.ts#L223); writes VS Code config; triggers MCP-import sync if relevant
- `_detectAuthMethod()` — [src/providers/settings-panel.ts:386](../../../../src/providers/settings-panel.ts#L386); env var vs. `~/.pi/agent` vs. manual key
- `_handleMessage({ type: 'setApiKey' })` — [src/providers/settings-panel.ts:98](../../../../src/providers/settings-panel.ts#L98); stores `pi-code.apiKey.<providerId>` in secrets

**Attributes / markers:**
- `pi-code.apiKey.*` — SecretStorage key prefix; the *only* string that matters for this bridge
- `context.secrets.onDidChange` — subscribed in [src/extension.ts:82](../../../../src/extension.ts#L82); the sole watch point

**Namespaces:**
- `src/shared/protocol.ts` — `SettingsData`, message shapes
- `src/providers/settings-panel.ts` — webview host
- `src/pi/auth.ts` — auth singleton and event
- `package.json` — manifest source-of-truth for configurable keys

## Lifecycle edges

**Depends on:**
- [activation-and-registration](../activation-and-registration/activation-and-registration.md) — the sole subscriber to `context.secrets.onDidChange` and the only place `SettingsPanel.show` is bound to a command.
- [Part V § models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md) — `AuthStorage` is the shared substrate; model registry consults it during provider resolution.
- [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — `SettingsData`, `SettingsClientMessage`, `SettingsServerMessage`, and `OAuthFlowState` are declared there.

**Used by:**
- [activation-and-registration](../activation-and-registration/activation-and-registration.md) — reads `pi-code.*` config and stores / retrieves API keys through the same `pi-code.apiKey.<provider>` prefix documented there.
- [claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md) — `pi-code.claudeCompat.enabled` / `pi-code.claudeCompat.mode` gate activation.
- [lsp-tools](../../11-auxiliary-systems/lsp-tools/lsp-tools.md) — `pi-code.lsp.enabled` setting.
- [message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — `SettingsData` is one of the artefacts declared here and consumed there.
- [models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md) — the SecretStorage prefix and `context.secrets.onDidChange` bridge are declared and subscribed there.
- [plan-mode-and-todos](../../08-message-flow-discipline/plan-mode-and-todos/plan-mode-and-todos.md) — `pi-code.planMode.defaultEnabled`, `pi-code.todo.promptGuidelines`, `pi-code.todo.defaultEnabled` settings.
- [settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) — `SettingsData`, `KNOWN_PROVIDERS`, `AuthStorage` bridge live there.
- [subagent-manager-and-lifecycle](../../09-subagents/subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — `pi-code.subagents.*` settings.
- [vscode-session-platform](../../04-platform-adapters/vscode-session-platform/vscode-session-platform.md) — the settings and secret-storage surface the adapters wrap.

## See also

- **Rule — never store an API key outside secrets.** Anything read via `workspace.getConfiguration('pi-code').get(...)` is plaintext user config. If a new provider needs a key, it goes into `SecretStorage` under the standard prefix, gets appended to [`KNOWN_PROVIDERS`](../../../../src/pi/auth.ts#L7), and inherits the hot-reload path automatically. Do not invent a new key location.
- **Rule — update three files when adding a setting.** The full circuit is [package.json § contributes.configuration](../../../../package.json) (declaration) → [src/shared/protocol.ts § SettingsData](../../../../src/shared/protocol.ts) (transport) → [src/providers/settings-panel.ts](../../../../src/providers/settings-panel.ts) + [src/webview/settings.ts](../../../../src/webview/settings.ts) (UI). Miss any one and the setting is invisible or unreachable.
- **Pitfall — the `pi-code.apiKey.` prefix appears in three places.** [auth.ts](../../../../src/pi/auth.ts#L5), [settings-panel.ts](../../../../src/providers/settings-panel.ts) message handler, and the `context.secrets.onDidChange` filter in [extension.ts:82](../../../../src/extension.ts#L82). It is not shared as a const. When renaming, grep the string literally.
- **Pattern — `apiProvider` is a webview hint, not a runtime toggle.** Model selection determines which provider's credential the SDK reaches for. The `pi-code.apiProvider` setting only tells the settings panel which section to show first.
- **Pattern — `_detectAuthMethod` distinguishes auth sources.** The panel prefers env vars → `~/.pi/agent` (pi-login) → manual key → none. Users can override by supplying a manual key even when `pi-login` succeeds; the panel exposes the current source so they can debug precedence.
- **Pitfall — `getAuthStorage()` is `async` because the SDK is `externalized`.** The first call dynamically imports `@earendil-works/pi-coding-agent`; subsequent calls hit the cache. Never treat it as synchronous.
