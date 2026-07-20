import type { AuthStorage } from '@earendil-works/pi-coding-agent';
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
];

let cached: AuthStorage | undefined;
let cachedSecrets: SecretStore | undefined;

const _onAuthChanged = new TypedEventEmitter<string | undefined>();
export const onAuthChanged = _onAuthChanged.event;

export function notifyAuthChanged(providerId?: string): void {
    _onAuthChanged.fire(providerId);
}

export async function getAuthStorage(secrets?: SecretStore): Promise<AuthStorage> {
    if (cached) {
        if (secrets) {
            cachedSecrets = secrets;
            await applySecretsToStorage(cached, secrets);
        }
        return cached;
    }
    const { AuthStorage: AS } = await import('@earendil-works/pi-coding-agent');
    cached = AS.create();
    if (secrets) {
        cachedSecrets = secrets;
        await applySecretsToStorage(cached, secrets);
    }
    return cached;
}

export async function reloadCredentials(): Promise<void> {
    if (cached) {
        cached.reload();
    }
    if (cached && cachedSecrets) {
        await applySecretsToStorage(cached, cachedSecrets);
    }
}

async function applySecretsToStorage(storage: AuthStorage, secrets: SecretStore): Promise<void> {
    for (const provider of KNOWN_PROVIDERS) {
        const key = await secrets.get(`${API_KEY_PREFIX}${provider}`);
        if (key) {
            storage.setRuntimeApiKey(provider, key);
        } else {
            storage.removeRuntimeApiKey(provider);
        }
    }
}

export function disposeAuthStorage() {
    cached = undefined;
    cachedSecrets = undefined;
}
