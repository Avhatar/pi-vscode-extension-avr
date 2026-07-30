# Chapter: configuration-and-secrets

Pi Code has two kinds of user-configurable state: **settings** (visible in VS Code's `settings.json` under the `pi-code.*` namespace) and **secrets** (manual API keys stored in `vscode.SecretStorage`, never in plaintext). Both are read by the extension host and propagated into running chat behavior without a window reload.

This chapter explains how those surfaces are declared, edited from the dedicated settings webview, and bridged into the canonical Pi SDK `ModelRuntime` used by every parent and child session.

## Article roster

- [configuration-and-secrets](configuration-and-secrets.md) — the `contributes.configuration` schema, `SettingsData` round-trip, settings host, `ModelRuntime` SecretStorage overrides, OAuth projection, and the `pi-code.apiKey.<provider>` prefix.

## Reader task

The reader arrives here to answer one of:

- "I want to add a new setting — where is it declared, how does it reach the webview, and how does the Pi session see the change?"
- "How does an API key stored via the settings panel become available to every running agent without reload?"
- "Which auth source does the settings panel report?"
- "What is `KNOWN_PROVIDERS`, and why is `pi-code.apiKey.` hardcoded in three places?"

## Neighborhood

- [activation-and-registration](../activation-and-registration/activation-and-registration.md) owns the settings panel registration and `context.secrets.onDidChange` bridge.
- [Part VI § settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) owns webview DOM and interaction details.
- [Part V § models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md) owns the canonical runtime, provider catalog, OAuth, and model projection.

## Non-goals

- Provider OAuth protocol details remain in the Pi SDK; Pi Code implements only the `AuthInteraction` UI bridge.
- The webview HTML and browser logic live in [src/webview/settings.ts](../../../../src/webview/settings.ts).
- MCP import for Claude Code belongs to [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md).
