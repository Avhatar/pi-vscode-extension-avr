# settings-panel

## Stance

`SettingsPanel` is a **singleton**. One panel per window; opening it a second time reveals the existing one. This is deliberate — settings are global to the window (workspace config + secret storage), so multiple concurrent panels would show conflicting states. The panel serializes `SettingsData` to the webview on every relevant change (secret store fires `onDidChange`, workspace config fires `onDidChangeConfiguration`, an OAuth flow makes progress) and receives `SettingsClientMessage`s for user edits.

## Role

[`SettingsPanel`](../../../../src/providers/settings-panel.ts#L27) — singleton with `.show()` factory [settings-panel.ts:64](../../../../src/providers/settings-panel.ts#L64). Constructor creates the `WebviewPanel`, subscribes to workspace config change events, and constructs an OAuth flow map keyed by `providerId`.

Message handler [settings-panel.ts:89](../../../../src/providers/settings-panel.ts#L89) dispatches:

- `getSettings` → `_sendSettings()` — build `SettingsData` from config + auth + oauth state, post to webview.
- `updateSetting` → `_updateSetting(key, value)` [settings-panel.ts:223](../../../../src/providers/settings-panel.ts#L223) — write to `vscode.workspace.getConfiguration('pi-code')`; if the key is `mcp.importClaudeCode`, call `syncClaudeCodeMcpImport(enabled)` on the session platform.
- `setApiKey`, `clearApiKey` — write / delete secret under `pi-code.apiKey.<provider>`; the `onDidChange` bridge in [activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) auto-triggers `reloadCredentials()`.
- `oauthSelect`, `oauthSubmitInput`, `oauthOpenUrl` — drive the OAuth flow state machine per provider.
- `getSkills` → posts a `skills` server message with the current `SkillInfo[]` from the Pi SDK.
- `rawMode.getStats`, `rawMode.clearSession`, `rawMode.clearAll`, `rawMode.revealStorage`, `rawMode.openView` — RawMode stats block.

[`OAuthLoginFlow`](../../../../src/providers/settings-panel.ts#L287) is one per provider. It exposes `oauthState` messages to the webview as the flow progresses through `starting → awaitingSelection → awaitingPrompt → awaitingBrowser → awaitingDeviceCode → progress → success | error`.

The webview [src/webview/settings.ts](../../../../src/webview/settings.ts) subscribes to `settings`, `settingChanged`, `skills`, `oauthState`, `rawMode.stats`, `error`. State maps: `currentSettings`, `loadedSkills`, `rawStats`, `oauthFlowStates`. `render(data)` [settings.ts:56](../../../../src/webview/settings.ts#L56) rebuilds the whole form on every state push — no partial DOM updates.

## Keywords

**Types — panel:**
- `SettingsPanel` — class [settings-panel.ts:27](../../../../src/providers/settings-panel.ts#L27); singleton
- `OAuthLoginFlow` — class [settings-panel.ts:287](../../../../src/providers/settings-panel.ts#L287); per-provider flow

**Types — data:**
- `SettingsData` — [protocol.ts:60](../../../../src/shared/protocol.ts#L60)
- `OAuthFlowState` — [protocol.ts:89](../../../../src/shared/protocol.ts#L89); discriminated by `phase`
- `OAuthProviderInfo` — per-provider availability
- `SkillInfo` — [agent-protocol.ts:190](../../../../src/shared/agent-protocol.ts#L190)

**Types — messages:**
- `SettingsClientMessage` — [protocol.ts:316](../../../../src/shared/protocol.ts#L316)
- `SettingsServerMessage` — [protocol.ts:335](../../../../src/shared/protocol.ts#L335)
- `RawModeSettingsClientMessage`, `RawModeSettingsServerMessage` — [raw-protocol.ts:185](../../../../src/shared/raw-protocol.ts#L185)

**Methods — panel:**
- `SettingsPanel.show()` — static factory [settings-panel.ts:64](../../../../src/providers/settings-panel.ts#L64)
- `_sendSettings()` — [settings-panel.ts:231](../../../../src/providers/settings-panel.ts#L231); assembles `SettingsData` and posts
- `_updateSetting(key, value)` — [settings-panel.ts:223](../../../../src/providers/settings-panel.ts#L223); writes config, triggers MCP sync when relevant
- `_detectAuthMethod()` — [settings-panel.ts:386](../../../../src/providers/settings-panel.ts#L386); env → pi-login → manual → none precedence
- `_sendRawStats()` — [settings-panel.ts:149](../../../../src/providers/settings-panel.ts#L149); aggregates from `RawStoragePort`

**Methods — webview:**
- `render(data)` — [settings.ts:56](../../../../src/webview/settings.ts#L56); rebuilds full DOM

**Attributes / markers:**
- View type: `pi-code.settings` — used by `WebviewPanel` creation
- Panel is singleton — `SettingsPanel.show()` reveals existing or creates new
- Provider config keys: `pi-code.apiProvider` = cosmetic; runtime resolution is model-driven

**Namespaces:**
- [src/providers/settings-panel.ts](../../../../src/providers/settings-panel.ts)
- [src/webview/settings.ts](../../../../src/webview/settings.ts)
- [src/webview/styles/settings.css](../../../../src/webview/styles/settings.css)

## Lifecycle edges

**Depends on:**
- [webview-architecture](../webview-architecture/webview-architecture.md) — the settings webview shares the transport / DOM pattern.
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `SettingsData`, `KNOWN_PROVIDERS`, `AuthStorage` bridge live there.
- [Part V § models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md) — providers dropdown source.
- [Part XI § raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md) — stats block wires into the raw storage port.

**Used by:**
- [raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md) — stats block + clear buttons.

## See also

- **Rule — one settings panel per window.** Do not add a "settings for this tab" variant. Configuration is global.
- **Rule — the panel is a mirror, not a source of truth.** Every change is written to VS Code config or SecretStorage; the panel re-reads and re-renders. Do not cache "the user's intent" in the panel between writes.
- **Pattern — `render(data)` rebuilds the whole DOM.** Settings state is small; rebuild cost is negligible. This keeps the render code straight-line rather than diff-tracking.
- **Pattern — OAuth is a state machine per provider.** `OAuthFlowState.phase` drives the visible UI (button vs. code entry vs. waiting spinner). The webview must show every phase; do not collapse phases into a single "loading".
- **Pitfall — clearing `pi-code.apiKey.<provider>` is the same as removing.** SecretStorage does not distinguish "empty string" from "unset"; empty-string writes should be treated as a `delete` by the panel.
- **Pitfall — `_updateSetting` is unconditional.** Writing the same value fires `onDidChangeConfiguration` and triggers a full refresh. Avoid dispatching updates for values that did not change — the webview should compare before sending.
- **Pattern — RawMode stats block is a peer feature.** The settings panel exposes stats and clear buttons; the actual RawMode UI lives in a separate panel (`RawPanel`), documented in [Part XI § raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md).
