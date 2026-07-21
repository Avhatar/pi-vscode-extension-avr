# Chapter: configuration-and-secrets

Pi Code has two kinds of user-configurable state: **settings** (visible in VS Code's `settings.json` under the `pi-code.*` namespace) and **secrets** (API keys stored in `vscode.SecretStorage`, never in plaintext). Both are declared by the extension manifest, both are read from the extension host, and both need to reach the running Pi SDK session so tool policies, model choices, and provider credentials take effect without a window reload.

This chapter explains how those two surfaces are declared, read, edited from a dedicated webview, and — most importantly — how a change on either surface propagates into the live session and into every open chat tab.

## Article roster

- [configuration-and-secrets](configuration-and-secrets.md) — the `contributes.configuration` schema in [package.json](../../../../package.json), the [`SettingsData`](../../../../src/shared/protocol.ts) round-trip, the settings-panel webview, the [`AuthStorage`](../../../../src/pi/auth.ts) singleton, and the `pi-code.apiKey.<provider>` prefix that ties everything together.

## Reader task

The reader arrives here to answer one of:

- "I want to add a new setting — where is it declared, how does it reach the webview, and how does the Pi session see the change?"
- "How does an API key stored via the settings panel become available to the running agent, and does the user need to reload the window?"
- "Which auth method wins if the user has an env var *and* a manually stored key *and* a `pi-login` session?"
- "What is `KNOWN_PROVIDERS` for and why is the prefix `pi-code.apiKey.` hardcoded in three places?"

## Neighborhood

- Activation (previous chapter, [activation-and-registration](../activation-and-registration/activation-and-registration.md)) is where the settings panel gets registered and where `context.secrets.onDidChange` is bridged to `reloadCredentials()`.
- The webview UI itself — its DOM structure, message discipline, styling — belongs to [Part VI § settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md). This chapter documents the wire and the extension-host side only.
- Model registry and provider list are documented in [Part V § models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md); this chapter references them as the consumer of `AuthStorage`.

## Non-goals

- OAuth provider-specific flows (Anthropic Console, `pi-login`, Codex device code) are only sketched here as `OAuthLoginFlow` state; provider-specific detail belongs in [Part V § models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md).
- The webview HTML / JS lives in [src/webview/settings.ts](../../../../src/webview/settings.ts) — this chapter documents the extension-host side and the typed messages the two exchange.
- MCP import for Claude Code (`pi-code.mcp.importClaudeCode`) is a specific setting whose behavior is described alongside the Claude compatibility bridge in [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md).
