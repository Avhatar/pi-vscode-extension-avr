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
        // The SDK synchronizes a credential change through its internal models
        // registry rather than the public `refresh()`, so assert the invariant
        // that actually matters — a SecretStorage change never reaches the
        // network — instead of spying on which refresh entry point is used.
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await reloadCredentials();
        expect(setRuntimeApiKey).not.toHaveBeenCalled();

        values.delete('pi-code.apiKey.deepseek');
        await reloadCredentials();

        expect(removeRuntimeApiKey).toHaveBeenCalledWith('deepseek', expect.anything());
        expect(fetchSpy).not.toHaveBeenCalled();
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

    it('keeps applying keys after one provider fails, and retries it later', async () => {
        values.set('pi-code.apiKey.anthropic', 'anthropic-key');
        values.set('pi-code.apiKey.deepseek', 'deepseek-key');
        const runtime = await getModelRuntime();

        // `setRuntimeApiKey` rejects on composition, catalog, and availability
        // errors, so a single broken provider must not strand the ones behind
        // it in KNOWN_PROVIDERS or fail the whole session bring-up.
        const setRuntimeApiKey = vi.spyOn(runtime, 'setRuntimeApiKey')
            .mockImplementationOnce(async () => { throw new Error('sync failed'); });

        await expect(getModelRuntime(secrets)).resolves.toBe(runtime);
        expect(setRuntimeApiKey.mock.calls.map(([provider]) => provider))
            .toEqual(['anthropic', 'deepseek']);

        // The failed provider was never recorded as applied, so the next sync
        // retries it while the provider that succeeded is deduplicated away.
        setRuntimeApiKey.mockClear();
        await reloadCredentials();
        expect(setRuntimeApiKey.mock.calls.map(([provider]) => provider))
            .toEqual(['anthropic']);
    });

    it('bounds each credential sync so a stalled provider cannot wedge the runtime', async () => {
        values.set('pi-code.apiKey.anthropic', 'anthropic-key');
        const runtime = await getModelRuntime();

        // The SDK substitutes a never-firing signal when the caller supplies
        // none, and provider availability refresh is not covered by the
        // `allowNetwork: false` it applies to the catalog refresh. Every sync
        // shares one process-wide chain, so an unbounded call here blocks
        // every later getModelRuntime() and every new chat tab with it.
        // Reject immediately rather than waiting the real timeout out: the
        // regression guarded here is a call made with no signal at all, so
        // what matters is that a bounded one is supplied and that a failure
        // leaves the provider retryable.
        const setRuntimeApiKey = vi.spyOn(runtime, 'setRuntimeApiKey')
            .mockRejectedValue(new Error('TimeoutError'));

        await expect(getModelRuntime(secrets)).resolves.toBe(runtime);
        const [, , options] = setRuntimeApiKey.mock.calls[0];
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        expect(options?.signal?.aborted).toBe(false);

        // A timed-out provider is not recorded, so the next sync retries it.
        setRuntimeApiKey.mockClear();
        await reloadCredentials();
        expect(setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'anthropic-key', expect.anything());
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
