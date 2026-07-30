import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    disposeModelRuntime,
    getModelRuntime,
    reloadCredentials,
} from '../../../pi/auth';
import { syncCustomProviders } from '../../../pi/models';


describe('auth portable secret store', () => {
    const values = new Map<string, string>();
    const secrets = {
        get: vi.fn(async (key: string) => values.get(key)),
        store: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
    };

    beforeEach(() => {
        disposeModelRuntime();
        values.clear();
        vi.clearAllMocks();
    });

    afterEach(() => disposeModelRuntime());

    it('applies, deduplicates, and removes SecretStorage runtime keys', async () => {
        values.set('pi-code.apiKey.deepseek', 'initial-key');
        const runtime = await getModelRuntime(secrets);

        await expect(runtime.getAuth('deepseek'))
            .resolves.toMatchObject({ auth: { apiKey: 'initial-key' } });

        const setRuntimeApiKey = vi.spyOn(runtime, 'setRuntimeApiKey');
        const removeRuntimeApiKey = vi.spyOn(runtime, 'removeRuntimeApiKey');
        const refresh = vi.spyOn(runtime, 'refresh');
        await reloadCredentials();
        expect(setRuntimeApiKey).not.toHaveBeenCalled();

        values.delete('pi-code.apiKey.deepseek');
        await reloadCredentials();

        expect(removeRuntimeApiKey).toHaveBeenCalledWith('deepseek');
        expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
        expect(secrets.get).toHaveBeenCalledWith('pi-code.apiKey.deepseek');
        expect(secrets.store).not.toHaveBeenCalled();
    });

    it('coalesces concurrent runtime initialization', async () => {
        const [first, second] = await Promise.all([
            getModelRuntime(),
            getModelRuntime(),
        ]);

        expect(first).toBe(second);
    });

    it('projects Qwen only while its SecretStorage override exists', async () => {
        let qwenKey: string | undefined = 'qwen-secret';
        const secrets = {
            get: vi.fn(async (name: string) => name.endsWith('.qwen') ? qwenKey : undefined),
            store: vi.fn(),
        };
        const firstRuntime = await getModelRuntime(secrets);
        await syncCustomProviders(firstRuntime);
        expect(firstRuntime.getProviders().some((provider) => provider.id === 'qwen')).toBe(true);

        disposeModelRuntime();
        const secondRuntime = await getModelRuntime(secrets);
        expect(secondRuntime).not.toBe(firstRuntime);
        await syncCustomProviders(secondRuntime);
        expect(secondRuntime.getProviders().some((provider) => provider.id === 'qwen')).toBe(true);

        qwenKey = undefined;
        await reloadCredentials();
        await syncCustomProviders(secondRuntime);
        expect(secondRuntime.getProviders().some((provider) => provider.id === 'qwen')).toBe(false);
    });
});
