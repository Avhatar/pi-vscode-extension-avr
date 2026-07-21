# Chapter: settings-panel

Settings are declared in `package.json` and reachable from VS Code's own Settings UI. Pi Code additionally ships a **dedicated settings webview** — [`SettingsPanel`](../../../../src/providers/settings-panel.ts) — that renders an opinionated form: per-provider API key entry, OAuth flow controls, RawMode stats + clear buttons, skill list, MCP-import toggle. This chapter documents the webview side of that panel; the extension-host storage / secret bridge is in [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md).

## Article roster

- [settings-panel](settings-panel.md) — `SettingsPanel` singleton, `SettingsData` round trip, OAuth flow state, RawMode stats block, skill fetching.

## Reader task

The reader arrives here to answer one of:

- "How does the OAuth flow surface progress to the UI?"
- "Where is the 'Clear all raw mode data' button wired?"
- "How does the panel show which skills are loaded — where does the skill list come from?"
- "Why is the settings panel a singleton and not one-per-window?"

## Neighborhood

- **Storage side** — `SettingsData` shape, `AuthStorage` bridge, `KNOWN_PROVIDERS` — is [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md).
- **RawMode stats source** — the recorder / storage port — is [Part XI § raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md).
- **MCP import** setting behavior at agent-run time is a Claude-compat concern — see [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md).

## Non-goals

- Individual settings semantics (what `pi-code.thinkingLevel` does at runtime) belong to the chapters that consume them.
- Per-provider OAuth details (which endpoints, which scopes) are Pi SDK internals.
- The provider list dropdown (which providers are shown) is documented in [Part V § models-and-auth](../../05-pi-sdk-integration/models-and-auth/models-and-auth.md).
