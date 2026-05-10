import * as vscode from 'vscode';
import type { AuthStorage } from '@mariozechner/pi-coding-agent';

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
let cachedSecrets: vscode.SecretStorage | undefined;

const _onAuthChanged = new vscode.EventEmitter<void>();
export const onAuthChanged = _onAuthChanged.event;

export function notifyAuthChanged(): void {
    _onAuthChanged.fire();
}

export async function getAuthStorage(secrets?: vscode.SecretStorage): Promise<AuthStorage> {
    if (cached) {
        if (secrets) {
            cachedSecrets = secrets;
            await applySecretsToStorage(cached, secrets);
        }
        return cached;
    }
    const { AuthStorage: AS } = await import('@mariozechner/pi-coding-agent');
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

async function applySecretsToStorage(storage: AuthStorage, secrets: vscode.SecretStorage): Promise<void> {
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
