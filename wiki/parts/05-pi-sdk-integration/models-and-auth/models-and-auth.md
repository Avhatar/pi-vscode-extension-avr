# models-and-auth

## Stance

One canonical runtime, one secret bridge. [`getModelRuntime()`](../../../../src/pi/auth.ts) lazily creates a single process-wide Pi SDK `ModelRuntime`; concurrent first callers share the same initialization promise. Parent sessions, persistent child sessions, the model picker, metadata refresh, Codex usage, and DeepSeek balance checks all use that object. Manual keys never enter Pi's persistent auth files: `applySecretsToRuntime()` copies them from VS Code `SecretStorage` into non-persistent runtime overrides.

Pi Code creates the runtime with model-catalog networking disabled. This keeps SDK catalog refreshes — including the refresh performed when a runtime key is removed — from causing unrelated network or OAuth activity. Explicit provider login and the account-scoped Codex metadata request remain separate, intentional network operations.

## Role

[src/pi/auth.ts](../../../../src/pi/auth.ts) owns runtime and credential state:

- `KNOWN_PROVIDERS` lists provider ids whose manual keys are synchronized from `pi-code.apiKey.<id>` secrets.
- `getModelRuntime(secrets?)` dynamically imports the externalized SDK, coalesces initialization, caches the runtime, and optionally queues SecretStorage synchronization.
- `reloadCredentials()` serially re-reads all known keys. Changed values call `setRuntimeApiKey()`; removed values call `removeRuntimeApiKey()`. Neither takes a network flag: the SDK synchronizes only the affected provider and hardcodes `allowNetwork: false`.
- Each provider in that pass is isolated by a `try`/`catch` that logs and continues, because the credential operations reject (`CredentialSynchronizationError`) on composition, catalog, and availability errors that earlier SDK releases only collected into a result map. A single unusable key would otherwise abort the loop, strand every provider behind it in `KNOWN_PROVIDERS`, and fail session bring-up. `appliedRuntimeKeys` records a provider only after success, so the next synchronization retries the failed one.
- Both calls carry an `AbortSignal.timeout(CREDENTIAL_SYNC_TIMEOUT_MS)`. The SDK substitutes a never-firing `new AbortController().signal` when the caller passes none, and the availability half of the credential sync (`checkAuth`, `getAvailable`) is not covered by the `allowNetwork: false` the SDK applies to the catalog refresh — so an unbounded call can stall indefinitely on the network. A timeout surfaces as an ordinary rejection and is handled by the same per-provider `catch`.
- `getProviderAccessToken(providerId)` resolves the current credential through `ModelRuntime.getAuth()`. This allows SDK-managed OAuth refresh and is used by account-scoped Codex and DeepSeek consumers.
- `notifyAuthChanged(providerId?)` fires `onAuthChanged`; subscribers then refresh their own projections.
- `disposeModelRuntime()` clears the process cache for global shutdown and tests.

[src/pi/models.ts](../../../../src/pi/models.ts) projects model state:

- `prepareModelRuntime(runtime, log?)` synchronizes custom providers, applies the DeepSeek vision catalog shim, and applies metadata.
- `syncCustomProviders(runtime)` conditionally registers or unregisters `qwen` and `qwen-cn` according to Pi Code's applied SecretStorage override map (`hasRuntimeSecretOverride()`). Registration state is tracked per runtime with a `WeakMap`, so disposal/recreation is safe.
- `syncDeepSeekVisionModel(runtime, log?)` applies the temporary DeepSeek vision entry and swallows failures after logging them, so a catalog shape it does not recognize cannot cost the user the whole model list.
- `refreshModelRuntime(log?)` refreshes the SDK snapshot without catalog networking, then re-runs custom-provider and metadata preparation.
- `getAvailableModels(runtime)` converts `getAvailableSnapshot()` entries into shared `ModelInfo` values.
- `findModel(runtime, provider, modelId)` delegates to `runtime.getModel()`.

[src/pi/model-metadata.ts](../../../../src/pi/model-metadata.ts) mutates the canonical runtime's model objects with documented context-window corrections and authenticated Codex catalog values. Codex credentials come from `runtime.getAuth('openai-codex')`. The persistent catalog is account-scoped, fresh for 24 hours, and stale-while-revalidate; first use without a cache waits for one request.

[src/pi/deepseek-usage-store.ts](../../../../src/pi/deepseek-usage-store.ts) uses the same runtime credential to refresh DeepSeek's authoritative account balance after turns and when a chat opens. It keeps key-fingerprinted, local-calendar-day ledgers of Pi Code-attributable turn cost in global state; API-key changes invalidate in-flight balance requests and clear the old account projection without discarding that day's other-account totals.

[src/pi/providers/qwen.ts](../../../../src/pi/providers/qwen.ts) registers DashScope's international and China endpoints directly on the runtime. Their models use Qwen-specific flags such as `supportsDeveloperRole: false`, `supportsStore: false`, `supportsLongCacheRetention: false`, and `thinkingFormat: 'qwen'`.

[src/pi/providers/deepseek.ts](../../../../src/pi/providers/deepseek.ts) adds `deepseek-v4-flash-vision-exp` to the built-in `deepseek` provider until the SDK catalog carries it. `registerDeepSeekVisionModel(runtime)` clones the provider's existing models verbatim and appends one entry derived from `deepseek-v4-flash` with `input: ['text', 'image']`; the SDK stays the source of truth for cost, context window, `compat`, and thinking levels. Unlike the Qwen registrations this composes over a provider the SDK already ships, so API-key resolution and streaming stay with the built-in provider and no placeholder key is needed. The shim skips itself when `runtime.getModel()` already resolves the vision id — which makes repeated preparation idempotent and retires the shim automatically once an SDK release ships the model — and when the `deepseek-v4-flash` template is absent.

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

**Methods — DeepSeek catalog shim:**
- `registerDeepSeekVisionModel(runtime)`

**Markers:**
- SecretStorage prefix: `pi-code.apiKey.`
- Codex catalog freshness: 24 hours per account, with stale-while-revalidate behavior
- `DOCUMENTED_API_OVERRIDES`
- `DEEPSEEK_VISION_MODEL_ID`, `DEEPSEEK_VISION_MODEL_NAME`

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
- **Pattern — catalog shims clone, never re-declare.** An extension layer replaces a provider's model list wholesale and does not merge `compat`, so a shim that hand-copies existing entries silently drops provider quirks and drifts from the SDK. Clone the runtime's own models and add only the new entry.
- **Rule — every SDK credential call needs an explicit `signal`.** `operationSignal()` falls back to `new AbortController().signal`, which never fires, so an omitted signal means no timeout and no cancellation. Because `queueSecretSync` runs all synchronization on one process-wide promise chain, a single unbounded call does not merely stall its own provider — it blocks every later `getModelRuntime()`, and with it the creation of every new chat tab, with no error and no way to cancel from the UI.
- **Rule — documented context-window corrections apply to the direct `openai` provider only.** The bundled `openai-codex` catalog lists every model at the same conservative 272K, but those windows are plan-specific and `applyCodexCatalogMetadata()` refreshes them from the user's authenticated catalog. Adding a documented value for a Codex entry would overwrite account truth with a guess, so `DOCUMENTED_API_OVERRIDES` entries must name `openai`.
- **Rule — a catalog shim must retire itself.** Gate it on `runtime.getModel()` so an SDK release that ships the model wins automatically; otherwise the temporary entry outlives its reason and freezes stale metadata.
- **Pitfall — `input` is the only image-capability signal.** `getAvailableModels()` derives `ModelInfo.supportsImages` from `model.input`, and the chat input refuses attachments on that basis, so a vision model missing from the catalog is unusable for images no matter what the provider API accepts. Mixed line-ups also need the [session-lifecycle](../session-lifecycle/session-lifecycle.md) image-compat guard.
