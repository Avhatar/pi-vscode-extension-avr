# models-and-auth

## Stance

One canonical runtime, one secret bridge. [`getModelRuntime()`](../../../../src/pi/auth.ts) lazily creates a single process-wide Pi SDK `ModelRuntime`; concurrent first callers share the same initialization promise. Parent sessions, persistent child sessions, the model picker, metadata refresh, Codex usage, and DeepSeek balance checks all use that object. Manual keys never enter Pi's persistent auth files: `applySecretsToRuntime()` copies them from VS Code `SecretStorage` into non-persistent runtime overrides.

Pi Code creates the runtime with model-catalog networking disabled. This keeps SDK catalog refreshes — including the refresh performed when a runtime key is removed — from causing unrelated network or OAuth activity. Explicit provider login and the account-scoped Codex metadata request remain separate, intentional network operations.

## Role

[src/pi/auth.ts](../../../../src/pi/auth.ts) owns runtime and credential state:

- `KNOWN_PROVIDERS` lists provider ids whose manual keys are synchronized from `pi-code.apiKey.<id>` secrets.
- `getModelRuntime(secrets?)` dynamically imports the externalized SDK, coalesces initialization, caches the runtime, and optionally queues SecretStorage synchronization.
- `reloadCredentials()` serially re-reads all known keys. Changed values call `setRuntimeApiKey()`; removed values call `removeRuntimeApiKey()`. Neither takes a network flag: the SDK synchronizes only the affected provider and hardcodes `allowNetwork: false`.
- The pass reads every `KNOWN_PROVIDERS` secret up front with `Promise.all`, then applies them sequentially. Each read is an IPC round-trip to the host credential store, so reading them one at a time made the chain the dominant cost of session bring-up; applying stays sequential so one provider cannot disturb another.
- Each provider in that pass is isolated by a `try`/`catch` that logs and continues, because the credential operations reject (`CredentialSynchronizationError`) on composition, catalog, and availability errors that earlier SDK releases only collected into a result map. A single unusable key would otherwise abort the loop, strand every provider behind it in `KNOWN_PROVIDERS`, and fail session bring-up. `appliedRuntimeKeys` records a provider only after success, so the next synchronization retries the failed one.
- Both calls carry an `AbortSignal.timeout(CREDENTIAL_SYNC_TIMEOUT_MS)`. The SDK substitutes a never-firing `new AbortController().signal` when the caller passes none, and the availability half of the credential sync (`checkAuth`, `getAvailable`) is not covered by the `allowNetwork: false` the SDK applies to the catalog refresh — so an unbounded call can stall indefinitely on the network. A timeout surfaces as an ordinary rejection and is handled by the same per-provider `catch`.
- `getProviderAccessToken(providerId)` resolves the current credential through `ModelRuntime.getAuth()`. This allows SDK-managed OAuth refresh and is used by account-scoped Codex and DeepSeek consumers.
- `notifyAuthChanged(providerId?)` fires `onAuthChanged`; subscribers then refresh their own projections.
- `disposeModelRuntime()` clears the process cache for global shutdown and tests.

[src/pi/models.ts](../../../../src/pi/models.ts) projects model state:

- `prepareModelRuntime(runtime, log?)` synchronizes custom providers, applies the DeepSeek catalog shim, and applies metadata.
- `syncCustomProviders(runtime)` conditionally registers or unregisters `qwen` and `qwen-cn` according to Pi Code's applied SecretStorage override map (`hasRuntimeSecretOverride()`). Registration state is tracked per runtime with a `WeakMap`, so disposal/recreation is safe.
- `syncDeepSeekFlashModel(runtime, log?)` applies the temporary DeepSeek V4.1 Flash entry and swallows failures after logging them, so a catalog shape it does not recognize cannot cost the user the whole model list.
- `refreshModelRuntime(log?)` refreshes the SDK snapshot without catalog networking, then re-runs custom-provider and metadata preparation.
- `getAvailableModels(runtime)` converts `getAvailableSnapshot()` entries into shared `ModelInfo` values.
- `findModel(runtime, provider, modelId)` delegates to `runtime.getModel()`.

[src/pi/model-metadata.ts](../../../../src/pi/model-metadata.ts) mutates the canonical runtime's model objects with documented direct-API context windows, the windows your own Codex account reports, and the one documented Codex price exemption. Codex credentials come from `runtime.getAuth('openai-codex')`. The persistent catalog is account-scoped and stored together with the `CODEX_MODELS_CLIENT_VERSION` it was fetched for; it is fresh for 24 hours and stale-while-revalidate, while an entry fetched for a different client version is unusable rather than stale — the endpoint filters its model list by that version — so it waits for one fresh request instead of replaying the previous shape.

[src/pi/deepseek-usage-store.ts](../../../../src/pi/deepseek-usage-store.ts) uses the same runtime credential to refresh DeepSeek's authoritative account balance after turns and when a chat opens. It keeps key-fingerprinted, local-calendar-day ledgers of Pi Code-attributable turn cost in global state; API-key changes invalidate in-flight balance requests and clear the old account projection without discarding that day's other-account totals. The turn cost it records is the SDK's session-cost delta times the DeepSeek peak multiplier in force when the turn started — see the peak/off-peak pitfall below.

[src/pi/providers/qwen.ts](../../../../src/pi/providers/qwen.ts) registers DashScope's international and China endpoints directly on the runtime. Their models use Qwen-specific flags such as `supportsDeveloperRole: false`, `supportsStore: false`, `supportsLongCacheRetention: false`, and `thinkingFormat: 'qwen'`.

[src/pi/providers/deepseek.ts](../../../../src/pi/providers/deepseek.ts) adds `deepseek-flash` (DeepSeek V4.1 Flash, released 2026-09-10) to the built-in `deepseek` provider until the SDK catalog carries it. `registerDeepSeekFlashModel(runtime)` clones the provider's existing models and appends one entry derived from `deepseek-v4-flash` with `input: ['text', 'image']` and the published V4.1 prices; the SDK stays the source of truth for context window, `compat`, and thinking levels. The same pass corrects the two ids DeepSeek retired and now routes to V4.1 Flash — `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` — because a catalog generated before the release describes the old SKUs: it adds `image` to their `input` whenever it is missing, and replaces the cost when the entry still quotes the exact superseded triple. It also reprices `deepseek-v4-pro`, which DeepSeek kept serving under its own id and its own prices after reversing the announced 2026-09-14 move to V4.1 Flash; its bundled numbers predate the 2026-09-10 repricing, so its price is corrected while its text-only `input` is left alone. Every price correction is listed in `PRICE_CORRECTIONS` and fires only on the exact superseded triple (`0.14` / `0.28` / `0.0028` for the routed ids, `0.435` / `0.87` / `0.003625` for V4 Pro); the stored figures are DeepSeek's off-peak rates, because its peak hours cost double. Unlike the Qwen registrations this composes over a provider the SDK already ships, so API-key resolution and streaming stay with the built-in provider and no placeholder key is needed. The shim skips itself when `runtime.getModel()` already resolves `deepseek-flash` — which makes repeated preparation idempotent and retires shim and corrections together once an SDK release ships the model, since a catalog new enough to carry V4.1 Flash is regenerated from a `models.dev` that has already repriced the routed ids — and when the `deepseek-v4-flash` template is absent.

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
- `refreshModelMetadata()`, `applyDocumentedApiMetadata()`, `applyCodexCatalogMetadata()`, `applyCodexLongContextExemptions()`, `parseCodexModelCatalog()`

**Methods — context limits:**
- `higherRateAboveTokens()`

**Methods — DeepSeek account usage:**
- `getDeepSeekUsageStore()`, `refresh()`, `recordTurnCost()`, `clear()`, `deepSeekRateMultiplier()`, `isDeepSeekPeakHour()`

**Methods — Qwen:**
- `registerQwenProvider(runtime, baseUrl?)`, `registerQwenCnProvider(runtime, baseUrl?)`

**Methods — DeepSeek catalog shim:**
- `registerDeepSeekFlashModel(runtime)`

**Markers:**
- SecretStorage prefix: `pi-code.apiKey.`
- Codex catalog freshness: 24 hours per account, with stale-while-revalidate behavior; a different `CODEX_MODELS_CLIENT_VERSION` counts as unusable
- `DOCUMENTED_API_OVERRIDES`, `CODEX_LONG_CONTEXT_EXEMPTIONS`, `PRICE_CORRECTIONS`
- `higherRateAboveTokens` — `ContextUsageInfo` field carrying the model's pricier-tier threshold
- `DEEPSEEK_FLASH_MODEL_ID`, `DEEPSEEK_FLASH_MODEL_NAME`, `ROUTED_MODEL_IDS`

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
- **Rule — documented context-window corrections apply to the direct `openai` provider only.** The bundled `openai-codex` catalog lists every model at the same conservative 272K, but those windows are plan-specific and `applyCodexCatalogMetadata()` replaces them with the account's own ceiling. Adding a documented value for a Codex entry would overwrite account truth with a guess, so `DOCUMENTED_API_OVERRIDES` entries must name `openai`; Codex-specific documented facts belong in their own mechanism (`CODEX_LONG_CONTEXT_EXEMPTIONS`).
- **Rule — the Codex catalog request's client version decides which models exist.** `CODEX_MODELS_CLIENT_VERSION` must be at least the newest needed model's `minimal_client_version`, and the endpoint filters its response by it: at 0.144.0 the live catalog omits `gpt-6-astra` (minimum 0.153.0) entirely, so `applyCodexCatalogMetadata()` silently has nothing to correct and the model keeps the bundled 272K default. Raising the constant is only half the fix — the persisted per-account cache must be invalidated in the same change, which is why each entry records the version it was fetched for.
- **Rule — Codex windows come from the account ceiling, not the conservative default.** `context_window` in the Codex catalog is the window the account starts with and `max_context_window` is the ceiling it may use; the upstream client reads the first and clamps an explicit `model_context_window` to the second. Pi Code has no such opt-in, so `applyCodexCatalogMetadata()` takes the larger of the two. OpenAI charges 2x input and 1.5x output above 272K for GPT-5.4/5.5/5.6 inside Codex but exempts GPT-6 Astra, so `CODEX_LONG_CONTEXT_EXEMPTIONS` removes that model's tier — otherwise Pi Code would overstate its cost and warn about a pricier window Codex does not charge for.
- **Rule — a "this now costs more" threshold must come from the model's cost table.** `cost.tiers[].inputTokensAbove` is the only place a provider states that its rates change above a token count, and the highest matching tier prices the whole request, so `higherRateAboveTokens()` reports the lowest threshold, `PiSession` puts it on `ContextUsageInfo`, and the footer chip turns yellow once the token count passes it. Never hardcode the threshold: reading it from the model makes it follow catalog updates and the Codex exemption automatically.
- **Pitfall — DeepSeek's published prices are peak and off-peak, and the catalog carries only one triple.** DeepSeek doubles its rates during its weekday peak windows (01:00-04:00 and 06:00-10:00 UTC, Monday through Friday) while a model's `cost` expresses a single set of rates. Pi Code stores the off-peak figures and applies `deepSeekRateMultiplier()` where it accounts spend, so the last-turn and daily numbers match what the request was charged; a turn that straddles a boundary is booked at the rate it started in, because a turn spans several provider requests that DeepSeek prices on arrival.
- **Rule — a catalog shim must retire itself.** Gate it on `runtime.getModel()` so an SDK release that ships the model wins automatically; otherwise the temporary entry outlives its reason and freezes stale metadata.
- **Pitfall — a retired model id keeps answering under new metadata.** When a provider reroutes an old id to a successor, nothing fails: requests still succeed, and the catalog silently describes a model that is no longer being served. DeepSeek retired V4 Flash and V4 Flash Vision Exp with the 2026-09-10 V4.1 release and routes both names to V4.1 Flash, so the bundled entries understated the model's capability (`input: ['text']` on a multimodal model) and its price (`0.28` against `0.60` per million output tokens, which the DeepSeek balance ledger records verbatim). Correct capability whenever it is missing, but correct a price only when it matches the exact superseded value — a catalog quoting something else is fresher than the constant.
- **Pitfall — `input` is the only image-capability signal.** `getAvailableModels()` derives `ModelInfo.supportsImages` from `model.input`, and the chat input refuses attachments on that basis, so a vision model missing from the catalog is unusable for images no matter what the provider API accepts. Mixed line-ups also need the [session-lifecycle](../session-lifecycle/session-lifecycle.md) image-compat guard.
