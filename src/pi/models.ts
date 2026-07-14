import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '../shared/protocol';
import { getAuthStorage } from './auth';
import { registerQwenCnProvider, registerQwenProvider } from './providers/qwen';
import { refreshModelMetadata, type ModelMetadataLog } from './model-metadata';

let cached: ModelRegistry | undefined;

export async function getModelRegistry(log?: ModelMetadataLog): Promise<ModelRegistry> {
    const authStorage = await getAuthStorage();
    if (!cached) {
        const { ModelRegistry: MR } = await import('@earendil-works/pi-coding-agent');
        cached = MR.create(authStorage);
        await syncCustomProviders();
    }
    await refreshModelMetadata(cached, authStorage, log);
    return cached;
}

// Dynamically register/unregister providers that pi-coding-agent's validator
// refuses without an `apiKey OR oauth` field. We only register them when the
// user has actually stored a key (so `getAvailable()` doesn't show models
// with no working credentials), and we tear them down when the key is removed.
export async function syncCustomProviders(): Promise<void> {
    if (!cached) return;
    const registry = cached;
    const authStorage = await getAuthStorage();
    syncProvider(registry, 'qwen', () => registerQwenProvider(registry), () => authStorage.hasAuth('qwen'));
    syncProvider(registry, 'qwen-cn', () => registerQwenCnProvider(registry), () => authStorage.hasAuth('qwen-cn'));
}

const registeredProviders = new Set<string>();

function syncProvider(
    registry: ModelRegistry,
    providerId: string,
    register: () => void,
    hasKey: () => boolean,
): void {
    const wantRegistered = hasKey();
    const isRegistered = registeredProviders.has(providerId);
    try {
        if (wantRegistered && !isRegistered) {
            register();
            registeredProviders.add(providerId);
        } else if (!wantRegistered && isRegistered) {
            registry.unregisterProvider(providerId);
            registeredProviders.delete(providerId);
        }
    } catch (err) {
        console.error(`[pi-code] Failed to sync provider "${providerId}":`, err);
    }
}

export async function refreshModelRegistry(log?: ModelMetadataLog): Promise<void> {
    if (!cached) return;
    cached.refresh();
    await syncCustomProviders();
    const authStorage = await getAuthStorage();
    await refreshModelMetadata(cached, authStorage, log);
}

export function getAvailableModels(registry: ModelRegistry): ModelInfo[] {
    return registry.getAvailable().map((m: any) => ({
        provider: String(m.provider),
        id: m.id,
        name: m.name,
        supportsImages: Array.isArray(m.input) ? m.input.includes('image') : undefined,
    }));
}

export function findModel(registry: ModelRegistry, provider: string, modelId: string) {
    return registry.find(provider, modelId);
}

export function disposeModelRegistry() {
    cached = undefined;
}
