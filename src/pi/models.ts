import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '../shared/protocol';
import { getInitializedModelRuntime, hasRuntimeSecretOverride } from './auth';
import { registerQwenCnProvider, registerQwenProvider } from './providers/qwen';
import { refreshModelMetadata, type ModelMetadataLog } from './model-metadata';

let registeredProviders = new WeakMap<ModelRuntime, Set<string>>();

export async function prepareModelRuntime(
    runtime: ModelRuntime,
    log?: ModelMetadataLog,
): Promise<ModelRuntime> {
    await syncCustomProviders(runtime);
    await refreshModelMetadata(runtime, log);
    return runtime;
}

// Pi Code keeps its DashScope providers conditional because their model list
// should only be visible while a real SecretStorage key is applied to the
// canonical ModelRuntime.
export async function syncCustomProviders(runtime: ModelRuntime): Promise<void> {
    let runtimeProviders = registeredProviders.get(runtime);
    if (!runtimeProviders) {
        runtimeProviders = new Set<string>();
        registeredProviders.set(runtime, runtimeProviders);
    }
    syncProvider(runtime, runtimeProviders, 'qwen', () => registerQwenProvider(runtime));
    syncProvider(runtime, runtimeProviders, 'qwen-cn', () => registerQwenCnProvider(runtime));
}

function syncProvider(
    runtime: ModelRuntime,
    runtimeProviders: Set<string>,
    providerId: string,
    register: () => void,
): void {
    const wantRegistered = hasRuntimeSecretOverride(providerId);
    const isRegistered = runtimeProviders.has(providerId);
    try {
        if (wantRegistered && !isRegistered) {
            register();
            runtimeProviders.add(providerId);
        } else if (!wantRegistered && isRegistered) {
            runtime.unregisterProvider(providerId);
            runtimeProviders.delete(providerId);
        }
    } catch (err) {
        console.error(`[pi-code] Failed to sync provider "${providerId}":`, err);
    }
}

export async function refreshModelRuntime(log?: ModelMetadataLog): Promise<void> {
    const runtime = getInitializedModelRuntime();
    if (!runtime) return;
    await runtime.refresh({ allowNetwork: false });
    await prepareModelRuntime(runtime, log);
}

export function getAvailableModels(runtime: ModelRuntime): ModelInfo[] {
    return runtime.getAvailableSnapshot().map((model) => ({
        provider: String(model.provider),
        id: model.id,
        name: model.name,
        supportsImages: Array.isArray(model.input) ? model.input.includes('image') : undefined,
    }));
}

export function findModel(runtime: ModelRuntime, provider: string, modelId: string) {
    return runtime.getModel(provider, modelId);
}

export function resetModelRuntimeState(): void {
    registeredProviders = new WeakMap<ModelRuntime, Set<string>>();
}
