# models-and-auth

## Stance

One canonical runtime, one secret bridge. [`getModelRuntime()`](../../../../src/pi/auth.ts) lazily creates a single process-wide Pi SDK `ModelRuntime`; concurrent first callers share the same initialization promise. Parent sessions, persistent child sessions, the model picker, metadata refresh, Codex usage, and DeepSeek balance checks all use that object. Manual keys never enter Pi's persistent auth files: `applySecretsToRuntime()` copies them from VS Code `SecretStorage` into non-persistent runtime overrides.

Pi Code creates the runtime with model-catalog networking disabled. This keeps SDK catalog refreshes — including the refresh performed when a runtime key is removed — from causing unrelated network or OAuth activity. Explicit provider login and the account-scoped Codex metadata request remain separate, intentional network operations.

## Role

[src/pi/auth.ts](../../../../src/pi/auth.ts) owns runtime and credential state:

- `KNOWN_PROVIDERS` lists provider ids whose manual keys are synchronized from `pi-code.apiKey.<id>` secrets.
- `getModelRuntime(secrets?)` dynamically imports the externalized SDK, coalesces initialization, caches the runtime, and optionally queues SecretStorage synchronization.
- `reloadCredentials()` serially re-reads all known keys. Changed values call `setRuntimeApiKey(..., { allowNetwork: false })`; removed values call `removeRuntimeApiKey()`.
- `getProviderAccessToken(providerId)` resolves the current credential through `ModelRuntime.getAuth()`. This allows SDK-managed OAuth refresh and is used by account-scoped Codex and DeepSeek consumers.
- `notifyAuthChanged(providerId?)` fires `onAuthChanged`; subscribers then refresh their own projections.
- `disposeModelRuntime()` clears the process cache for global shutdown and tests.

[src/pi/models.ts](../../../../src/pi/models.ts) projects model state:

- `prepareModelRuntime(runtime, log?)` synchronizes custom providers and applies metadata.
- `syncCustomProviders(runtime)` conditionally registers or unregisters `qwen` and `qwen-cn` according to Pi Code's applied SecretStorage override map (`hasRuntimeSecretOverride()`). Registration state is tracked per runtime with a `WeakMap`, so disposal/recreation is safe.
- `refreshModelRuntime(log?)` refreshes the SDK snapshot without catalog networking, then re-runs custom-provider and metadata preparation.
- `getAvailableModels(runtime)` converts `getAvailableSnapshot()` entries into shared `ModelInfo` values.
- `findModel(runtime, provider, modelId)` delegates to `runtime.getModel()`.

[src/pi/model-metadata.ts](../../../../src/pi/model-metadata.ts) mutates the canonical runtime's model objects with documented context-window corrections and authenticated Codex catalog values. Codex credentials come from `runtime.getAuth('openai-codex')`. The persistent catalog is account-scoped, fresh for 24 hours, and stale-while-revalidate; first use without a cache waits for one request.

[src/pi/deepseek-usage-store.ts](../../../../src/pi/deepseek-usage-store.ts) uses the same runtime credential to refresh DeepSeek's authoritative account balance after turns and when a chat opens. It keeps key-fingerprinted, local-calendar-day ledgers of Pi Code-attributable turn cost in global state; API-key changes invalidate in-flight balance requests and clear the old account projection without discarding that day's other-account totals.

[src/pi/providers/qwen.ts](../../../../src/pi/providers/qwen.ts) registers DashScope's international and China endpoints directly on the runtime. Their models use Qwen-specific flags such as `supportsDeveloperRole: false`, `supportsStore: false`, `supportsLongCacheRetention: false`, and `thinkingFormat: 'qwen'`.

[src/providers/settings-panel.ts](../../../../src/providers/settings-panel.ts) projects OAuth-capable providers from `runtime.getProviders()`, checks sign-in state with `runtime.checkAuth()`, and invokes `runtime.login(providerId, 'oauth', interaction)` or `runtime.logout(providerId)`. [`OAuthLoginFlow`](../../../../src/pi/oauth-login-flow.ts) implements the SDK `AuthInteraction` contract with prompt, selection, browser, device-code, notification, and cancellation UI states.

## Keywords

**Types:**
- `ModelRuntime` — canonical SDK model/auth/provider runtime
- `AuthInteraction` — SDK OAuth UI callback contract
- `SecretStore` — portable secret port implemented with VS Code `SecretStorage`
- `ModelInfo`, `OAuthProviderInfo` — shared protocol projections
- `DeepSeekUsageStore`, `PersistedDeepSeekUsage`, `DeepSeekDailyLedger` — account balance plus key/date-scoped local spend state

**Methods — runtime/auth:**
- `getModelRuntime(secrets?)`, `getInitializedModelRuntime()`, `reloadCredentials()`, `getProviderAccessToken()`, `notifyAuthChanged()`, `disposeModelRuntime()`

**Methods — models:**
- `prepareModelRuntime()`, `syncCustomProviders()`, `refreshModelRuntime()`, `getAvailableModels()`, `findModel()`, `resetModelRuntimeState()`

**Methods — metadata:**
- `refreshModelMetadata()`, `applyDocumentedApiMetadata()`, `applyCodexCatalogMetadata()`, `parseCodexModelCatalog()`

**Methods — DeepSeek account usage:**
- `getDeepSeekUsageStore()`, `refresh()`, `recordTurnCost()`, `clear()`

**Methods — Qwen:**
- `registerQwenProvider(runtime, baseUrl?)`, `registerQwenCnProvider(runtime, baseUrl?)`

**Markers:**
- SecretStorage prefix: `pi-code.apiKey.`
- Codex catalog freshness: 24 hours per account, with stale-while-revalidate behavior
- `DOCUMENTED_API_OVERRIDES`

## Lifecycle edges

**Depends on:**
- [configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — owns persistence and the secret-change subscription.
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — acquires the runtime during session initialization.

**Used by:**
- [configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — canonical runtime and model/provider projection.
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — canonical `ModelRuntime`, model resolution, and SecretStorage overrides.
- [settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) — providers dropdown source.

## See also

- **Rule — one prefix, three places.** `pi-code.apiKey.` appears in `auth.ts`, the settings-panel key handler, and the activation secret-change filter. Grep the literal when changing it.
- **Rule — add manual-key providers to both surfaces when needed.** `KNOWN_PROVIDERS` gives a provider hot reload; `API_KEY_PROVIDERS` in `src/shared/providers.ts` gives it a settings dropdown entry.
- **Pattern — custom providers are runtime-scoped.** Never track registration in one process-global provider set; recreated runtimes must register independently.
- **Pattern — consumers receive the runtime.** Do not create private `ModelRuntime` instances in tabs or subagents; otherwise credential changes and provider projection diverge.
- **Pitfall — `getModelRuntime()` is asynchronous.** The SDK remains dynamically imported because it is externalized from the extension-host bundle.
- **Pattern — `onAuthChanged` is the public event.** Downstream consumers re-query the runtime instead of subscribing directly to VS Code SecretStorage.
