# Chapter: models-and-auth

The Pi SDK does not commit to a specific set of providers; it exposes a `ModelRegistry` populated from whatever set of provider modules is loaded, and reaches for credentials through an `AuthStorage`. Pi Code sits on top of both: it maintains an opinionated list of providers whose keys it knows how to store in `SecretStorage` ([`KNOWN_PROVIDERS`](../../../../src/pi/auth.ts#L7)), registers a few custom providers the SDK doesn't ship (Qwen international / China endpoints), and refreshes the model catalog from Codex when the user is authenticated to that service.

## Article roster

- [models-and-auth](models-and-auth.md) — `getModelRegistry` and provider sync, `AuthStorage` cache and the secret bridge, model-metadata refresh, and the Qwen custom-provider registration.

## Reader task

The reader arrives here to answer one of:

- "Where does the model picker actually get its list?"
- "How do provider-specific quirks (Qwen has no `developer` role, Anthropic has long cache retention) get into the SDK?"
- "When I paste an API key in the settings panel, when does the SDK see it?"
- "What's the difference between the model registry and the AuthStorage?"

## Neighborhood

- **Storage of the API key** is [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md); this chapter picks up on the SDK side.
- **Session** is [session-lifecycle](../session-lifecycle/session-lifecycle.md) — the registry is consulted when the session resolves the current model.
- **`shared/providers.ts` list** is a UI concern (which providers show up in the settings panel dropdown) — a superset of `KNOWN_PROVIDERS` when we ship UI for providers we don't yet auto-sync.

## Non-goals

- Provider-specific OAuth flows (Anthropic Console, `pi-login`, Codex device code) are Pi SDK concerns; the extension surfaces the flow state but does not implement the flow.
- Actual token accounting (usage, rate limits) is a Pi SDK concern; the extension consumes usage snapshots via the port.
- Model catalog TTL / refresh timing is described here at "what triggers refresh"; the SDK owns the underlying cache.
