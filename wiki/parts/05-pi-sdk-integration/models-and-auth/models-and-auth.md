# models-and-auth

## Stance

Two singletons, one bridge. The **model registry** is lazily built once per extension session; the **auth storage** is lazily built once per extension session; and a single `applySecretsToStorage()` call is the only thing that ever moves user-typed API keys into the SDK's runtime-override map. Any code path that tries to shortcut this — read directly from `context.secrets`, hardcode a provider, bypass the `pi-code.apiKey.` prefix — creates a divergence between what the user sees in settings and what the SDK actually uses when it fires a request.

## Role

[src/pi/auth.ts](../../../../src/pi/auth.ts) is the credential surface:

- [`KNOWN_PROVIDERS`](../../../../src/pi/auth.ts#L7) — a `readonly string[]` of provider ids the extension can auto-sync. Currently includes anthropic, openai, google, deepseek, mistral, groq, cerebras, xai, openrouter, fireworks, huggingface, bedrock, vertex, azure, kimi, minimax, gateway, vercel-ai-gateway, gemini, claude, zai, qwen, qwen-cn — and additional aliases (see the array).
- [`getAuthStorage(secrets?)`](../../../../src/pi/auth.ts#L27) — lazy factory; returns the cached SDK `AuthStorage`. On first call (or after `disposeAuthStorage`), it dynamically imports the SDK, constructs the storage, and calls `applySecretsToStorage()`.
- [`applySecretsToStorage()`](../../../../src/pi/auth.ts#L53) — iterates `KNOWN_PROVIDERS`; for each id, reads the `pi-code.apiKey.<id>` value from the injected `SecretStore` and calls `storage.setRuntimeApiKey(id, key)` or `storage.removeRuntimeApiKey(id)` accordingly.
- [`reloadCredentials()`](../../../../src/pi/auth.ts#L44) — public re-sync; called from `activate()` and again from the `context.secrets.onDidChange` handler.
- [`notifyAuthChanged(providerId?)`](../../../../src/pi/auth.ts#L23) — fires the module-level [`onAuthChanged`](../../../../src/pi/auth.ts#L21) `TypedEventEmitter`. Subscribers (tab controllers, launcher, model picker) re-query the registry.
- [`disposeAuthStorage()`](../../../../src/pi/auth.ts#L64) — clears the cache; used in tests.

[src/pi/models.ts](../../../../src/pi/models.ts) is the model registry surface:

- [`getModelRegistry(log?)`](../../../../src/pi/models.ts#L9) — async; returns cached `ModelRegistry` or constructs it (dynamic SDK import), syncs custom providers, refreshes metadata.
- [`syncCustomProviders()`](../../../../src/pi/models.ts#L24) — inspects `AuthStorage`; if Qwen credentials exist, calls `registerQwenProvider` and/or `registerQwenCnProvider`; if they don't, removes any previous registration.
- [`refreshModelRegistry(log?)`](../../../../src/pi/models.ts#L55) — full re-sync (SDK registry + custom providers + metadata).
- [`getAvailableModels(registry)`](../../../../src/pi/models.ts#L63) — maps SDK models to `ModelInfo[]` for the shared protocol.
- [`findModel(registry, provider, modelId)`](../../../../src/pi/models.ts#L72) — direct lookup.

[src/pi/model-metadata.ts](../../../../src/pi/model-metadata.ts) refreshes context-window sizes and account-specific catalog data:

- [`refreshModelMetadata()`](../../../../src/pi/model-metadata.ts#L48) — applies documented overrides + Codex catalog if the user is Codex-authenticated.
- [`applyDocumentedApiMetadata()`](../../../../src/pi/model-metadata.ts#L101) — patches GPT-5.6 (and other) context windows from `DOCUMENTED_API_OVERRIDES` [model-metadata.ts:31](../../../../src/pi/model-metadata.ts#L31).
- [`applyCodexCatalogMetadata()`](../../../../src/pi/model-metadata.ts#L119) — for Codex accounts; hits the Codex-model-catalog endpoint, parses via [`parseCodexModelCatalog`](../../../../src/pi/model-metadata.ts#L136), caches per account for 60 s.

[src/pi/providers/qwen.ts](../../../../src/pi/providers/qwen.ts) registers the Qwen international ([qwen.ts:185](../../../../src/pi/providers/qwen.ts#L185)) and China ([qwen.ts:194](../../../../src/pi/providers/qwen.ts#L194)) endpoints, both talking to DashScope. Model list covers Qwen3, Qwen3.5, Qwen3.6, QwQ, and Qwen VL series. Provider flags: `supportsDeveloperRole: false`, `supportsStore: false`, `supportsLongCacheRetention: false`, `thinkingFormat: 'qwen'`.

[src/shared/providers.ts](../../../../src/shared/providers.ts) exposes an `API_KEY_PROVIDERS: ApiKeyProvider[]` array used purely by the settings panel dropdown (id + label).

## Keywords

**Types — auth:**
- `AuthStorage` — SDK class, cached
- `SecretStore` — port from [src/adapters/vscode/session-platform.ts](../../../../src/adapters/vscode/session-platform.ts)
- `TypedEventEmitter<string | undefined>` — for `onAuthChanged`

**Types — models:**
- `ModelRegistry` — SDK class, cached
- `ModelInfo` — shared protocol type [src/shared/agent-protocol.ts:153](../../../../src/shared/agent-protocol.ts#L153)
- `ApiKeyProvider` — `{ id, label }` [src/shared/providers.ts](../../../../src/shared/providers.ts)
- `API_KEY_PROVIDERS` — UI list

**Methods — auth:**
- `getAuthStorage(secrets?)`, `reloadCredentials()`, `notifyAuthChanged(providerId?)`, `disposeAuthStorage()`, `applySecretsToStorage()` — [src/pi/auth.ts](../../../../src/pi/auth.ts)

**Methods — models:**
- `getModelRegistry(log?)`, `syncCustomProviders()`, `refreshModelRegistry(log?)`, `getAvailableModels(registry)`, `findModel(registry, provider, modelId)`, `disposeModelRegistry()` — [src/pi/models.ts](../../../../src/pi/models.ts)

**Methods — metadata:**
- `refreshModelMetadata()`, `applyDocumentedApiMetadata()`, `applyCodexCatalogMetadata()`, `parseCodexModelCatalog()` — [src/pi/model-metadata.ts](../../../../src/pi/model-metadata.ts)

**Methods — Qwen:**
- `registerQwenProvider(registry, baseUrl?)`, `registerQwenCnProvider(registry, baseUrl?)` — [src/pi/providers/qwen.ts](../../../../src/pi/providers/qwen.ts)

**Attributes / markers:**
- SecretStorage key prefix: `pi-code.apiKey.` — [auth.ts:5](../../../../src/pi/auth.ts#L5)
- Codex catalog TTL: 60 seconds per account
- Codex client version: pinned to 0.144.0 for GPT-5.6 compatibility [model-metadata.ts:7](../../../../src/pi/model-metadata.ts#L7)
- `DOCUMENTED_API_OVERRIDES` — [model-metadata.ts:31](../../../../src/pi/model-metadata.ts#L31)

**Namespaces:**
- [src/pi/auth.ts](../../../../src/pi/auth.ts)
- [src/pi/models.ts](../../../../src/pi/models.ts)
- [src/pi/model-metadata.ts](../../../../src/pi/model-metadata.ts)
- [src/pi/providers/qwen.ts](../../../../src/pi/providers/qwen.ts)
- [src/shared/providers.ts](../../../../src/shared/providers.ts)

## Lifecycle edges

**Depends on:**
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — the session consults both singletons during model resolution.
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — the SecretStorage prefix and `context.secrets.onDidChange` bridge are declared and subscribed there.

**Used by:**
- [configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `AuthStorage` is the shared substrate; model registry consults it during provider resolution.
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — model resolution and `AuthStorage` bridge.
- [settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) — providers dropdown source.

## See also

- **Rule — one prefix, three places.** `pi-code.apiKey.` appears in [auth.ts](../../../../src/pi/auth.ts#L5), the settings panel's key-set handler, and the extension's secret-change subscription in `extension.ts`. When adding or renaming, grep the string; there is no shared constant.
- **Rule — new providers land in `KNOWN_PROVIDERS`.** Appending the id gives it the hot-reload path automatically. If it also needs a UI entry, add it to `API_KEY_PROVIDERS` in [shared/providers.ts](../../../../src/shared/providers.ts).
- **Pattern — custom providers registered at metadata-refresh time.** `syncCustomProviders` runs from `getModelRegistry` / `refreshModelRegistry`; it flips Qwen registration on / off based on whether credentials exist. Consumers don't have to poll; they just re-query the registry.
- **Pattern — Codex metadata is account-scoped.** Different Codex accounts have different model catalogs; the cache is keyed by account id and TTL'd at 60 s so login switches propagate.
- **Pitfall — Qwen has provider-specific flags.** `supportsDeveloperRole: false`, `supportsStore: false`, `thinkingFormat: 'qwen'`. New Qwen models must inherit these flags or requests will fail; the registration in [qwen.ts](../../../../src/pi/providers/qwen.ts) is the source of truth.
- **Pitfall — `getModelRegistry` is `async`.** First call dynamically imports the SDK. Subsequent calls are cache hits. Don't invoke it from a synchronous path.
- **Pattern — `onAuthChanged` is the public event; listeners re-query the registry.** Downstream consumers must not subscribe directly to `context.secrets.onDidChange` — that's the extension host's private plumbing.
