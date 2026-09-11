import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SecretStore } from '../core/ports/session-platform';
import { TypedEventEmitter } from '../shared/typed-event';

const API_KEY_PREFIX = 'pi-code.apiKey.';

/**
 * Ceiling for one provider's credential synchronization.
 *
 * `setRuntimeApiKey`/`removeRuntimeApiKey` refresh provider availability, and
 * that path reaches `checkAuth` and `getAvailable`, neither of which is
 * covered by the `allowNetwork: false` the SDK applies to the catalog refresh.
 * Without a signal the SDK substitutes `new AbortController().signal`, which
 * never fires, so a provider stalled on the network hangs the call forever —
 * and because every sync runs on one process-wide chain, that wedges every
 * later `getModelRuntime()` and with it the creation of any new chat tab.
 */
const CREDENTIAL_SYNC_TIMEOUT_MS = 10_000;

const KNOWN_PROVIDERS = [
    'anthropic', 'openai', 'google', 'deepseek', 'mistral', 'groq',
    'cerebras', 'xai', 'openrouter', 'fireworks', 'huggingface',
    'bedrock', 'amazon-bedrock', 'vertex', 'google-vertex',
    'azure', 'azure-openai-responses',
    'kimi', 'kimi-coding', 'minimax', 'minimax-cn',
    'gateway', 'vercel-ai-gateway',
    'gemini', 'claude', 'zai', 'qwen', 'qwen-cn',
] as const;

let cached: ModelRuntime | undefined;
let initialization: Promise<ModelRuntime> | undefined;
let secretSync: Promise<void> = Promise.resolve();
let cachedSecrets: SecretStore | undefined;
const appliedRuntimeKeys = new Map<string, string>();

const _onAuthChanged = new TypedEventEmitter<string | undefined>();
export const onAuthChanged = _onAuthChanged.event;

export function notifyAuthChanged(providerId?: string): void {
    _onAuthChanged.fire(providerId);
}

export async function getModelRuntime(secrets?: SecretStore): Promise<ModelRuntime> {
    if (!cached) {
        initialization ??= createModelRuntime().then((runtime) => {
            cached = runtime;
            return runtime;
        }).finally(() => {
            initialization = undefined;
        });
        await initialization;
    }
    const runtime = cached!;
    if (secrets) {
        cachedSecrets = secrets;
        await queueSecretSync(runtime, secrets);
    }
    return runtime;
}

export function getInitializedModelRuntime(): ModelRuntime | undefined {
    return cached;
}

export function hasRuntimeSecretOverride(providerId: string): boolean {
    return appliedRuntimeKeys.has(providerId);
}

export async function reloadCredentials(): Promise<void> {
    if (cached && cachedSecrets) {
        await queueSecretSync(cached, cachedSecrets);
    }
}

export async function getProviderAccessToken(providerId: string): Promise<string | undefined> {
    const runtime = await getModelRuntime();
    const auth = await runtime.getAuth(providerId);
    return auth?.auth.apiKey;
}

async function createModelRuntime(): Promise<ModelRuntime> {
    const { ModelRuntime: Runtime } = await import('@earendil-works/pi-coding-agent');
    // `create()` is the only catalog refresh here that can reach the network:
    // `setRuntimeApiKey` and `removeRuntimeApiKey` scope their own refresh to
    // the affected provider with `allowNetwork: false` hardcoded. Create this
    // app-owned runtime in offline-catalog mode anyway so bring-up never
    // blocks on a provider or OAuth network refresh.
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
        return await Runtime.create({ allowModelNetwork: false });
    } finally {
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
    }
}

async function queueSecretSync(runtime: ModelRuntime, secrets: SecretStore): Promise<void> {
    const operation = secretSync.then(() => applySecretsToRuntime(runtime, secrets));
    secretSync = operation.catch(() => undefined);
    await operation;
}

/**
 * Apply every stored key to the runtime, one provider at a time.
 *
 * Each provider is isolated by its own `try`/`catch`, because the credential
 * operations reject on failure: `CredentialSynchronizationError` wraps the
 * composition, catalog, and availability errors that earlier SDK releases
 * only collected into a result map. Letting that propagate would abort the
 * loop, strand every provider behind it in `KNOWN_PROVIDERS`, and fail the
 * whole session bring-up. `appliedRuntimeKeys` is only updated once the
 * operation succeeds, which makes the next sync retry the failed provider —
 * including one that hit `CREDENTIAL_SYNC_TIMEOUT_MS`, since a timeout
 * arrives here as a rejection like any other failure.
 */
async function applySecretsToRuntime(runtime: ModelRuntime, secrets: SecretStore): Promise<void> {
    for (const provider of KNOWN_PROVIDERS) {
        const key = await secrets.get(`${API_KEY_PREFIX}${provider}`);
        const applied = appliedRuntimeKeys.get(provider);
        try {
            if (key) {
                if (key === applied) continue;
                await runtime.setRuntimeApiKey(provider, key, {
                    signal: AbortSignal.timeout(CREDENTIAL_SYNC_TIMEOUT_MS),
                });
                appliedRuntimeKeys.set(provider, key);
            } else if (applied !== undefined) {
                await runtime.removeRuntimeApiKey(provider, {
                    signal: AbortSignal.timeout(CREDENTIAL_SYNC_TIMEOUT_MS),
                });
                appliedRuntimeKeys.delete(provider);
            }
        } catch (err) {
            console.error(`[pi-code] Failed to apply the stored API key for "${provider}":`, err);
        }
    }
}

export function disposeModelRuntime(): void {
    cached = undefined;
    initialization = undefined;
    secretSync = Promise.resolve();
    cachedSecrets = undefined;
    appliedRuntimeKeys.clear();
}
