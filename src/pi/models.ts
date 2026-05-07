import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { ModelInfo } from '../shared/protocol';
import { getAuthStorage } from './auth';

let cached: ModelRegistry | undefined;

export async function getModelRegistry(): Promise<ModelRegistry> {
    if (cached) {
        return cached;
    }
    const { ModelRegistry: MR } = await import('@mariozechner/pi-coding-agent');
    const authStorage = await getAuthStorage();
    cached = MR.create(authStorage);
    return cached;
}

export async function refreshModelRegistry(): Promise<void> {
    if (cached) {
        cached.refresh();
    }
}

export function getAvailableModels(registry: ModelRegistry): ModelInfo[] {
    return registry.getAvailable().map((m) => ({
        provider: String(m.provider),
        id: m.id,
        name: m.name,
    }));
}

export function findModel(registry: ModelRegistry, provider: string, modelId: string) {
    return registry.find(provider, modelId);
}

export function disposeModelRegistry() {
    cached = undefined;
}
