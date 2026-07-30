import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SecretStore } from '../core/ports/session-platform';
import { TypedEventEmitter } from '../shared/typed-event';

const API_KEY_PREFIX = 'pi-code.apiKey.';

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
    // ModelRuntime 0.82.1 exposes a create-time network flag, but key removal
    // otherwise refreshes catalogs using its process-level offline setting.
    // Create this app-owned runtime in offline-catalog mode so SecretStorage
    // changes never trigger unrelated provider or OAuth network refreshes.
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

async function applySecretsToRuntime(runtime: ModelRuntime, secrets: SecretStore): Promise<void> {
    for (const provider of KNOWN_PROVIDERS) {
        const key = await secrets.get(`${API_KEY_PREFIX}${provider}`);
        const applied = appliedRuntimeKeys.get(provider);
        if (key) {
            if (key === applied) continue;
            await runtime.setRuntimeApiKey(provider, key, { allowNetwork: false });
            appliedRuntimeKeys.set(provider, key);
        } else if (applied !== undefined) {
            await runtime.removeRuntimeApiKey(provider);
            appliedRuntimeKeys.delete(provider);
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
