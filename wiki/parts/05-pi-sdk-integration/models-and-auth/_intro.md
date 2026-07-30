# Chapter: models-and-auth

Pi Code owns one process-wide Pi SDK `ModelRuntime`. The runtime unifies the model catalog, API-key and OAuth credential resolution, provider registration, and session-facing model lookup. Pi Code adds an opinionated `KNOWN_PROVIDERS` bridge from VS Code `SecretStorage`, conditionally registers Qwen international / China endpoints, and augments model metadata from documented limits and the authenticated Codex catalog.

## Article roster

- [models-and-auth](models-and-auth.md) — canonical `ModelRuntime` ownership, SecretStorage runtime overrides, OAuth access, custom-provider synchronization, model lookup, and metadata refresh.

## Reader task

The reader arrives here to answer one of:

- "Where does the model picker actually get its list?"
- "How do provider-specific quirks (Qwen has no `developer` role, Anthropic has long cache retention) get into the SDK?"
- "When I paste or remove an API key in the settings panel, when does the SDK see it?"
- "How do parent and child sessions share model and credential state?"

## Neighborhood

- **Storage of manual API keys** is [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md); this chapter picks up on the SDK side.
- **Session construction** is [session-lifecycle](../session-lifecycle/session-lifecycle.md) — parent and child sessions receive this same runtime.
- **`shared/providers.ts` list** is a UI concern: which providers appear in the manual-key dropdown. SDK OAuth providers are projected dynamically from `ModelRuntime.getProviders()`.

## Non-goals

- Provider-specific OAuth protocol details remain owned by the Pi SDK; the extension supplies the `AuthInteraction` UI bridge.
- Actual token accounting and rate-limit interpretation remain separate from the model-runtime catalog.
- Pi Code deliberately disables SDK model-catalog network refreshes; the explicit account-scoped Codex metadata request is documented here.
