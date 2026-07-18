import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    disposeAuthStorage,
    getAuthStorage,
    reloadCredentials,
} from '../../../pi/auth';

describe('auth portable secret store', () => {
    const values = new Map<string, string>();
    const secrets = {
        get: vi.fn(async (key: string) => values.get(key)),
        store: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
    };

    beforeEach(() => {
        disposeAuthStorage();
        values.clear();
        vi.clearAllMocks();
    });

    afterEach(() => disposeAuthStorage());

    it('reapplies added and removed runtime keys when credentials reload', async () => {
        values.set('pi-code.apiKey.deepseek', 'initial-key');
        const storage = await getAuthStorage(secrets);
        const reload = vi.spyOn(storage, 'reload');

        await expect(storage.getApiKey('deepseek', { includeFallback: false }))
            .resolves.toBe('initial-key');

        values.delete('pi-code.apiKey.deepseek');
        await reloadCredentials();

        expect(reload).toHaveBeenCalledOnce();
        await expect(storage.getApiKey('deepseek', { includeFallback: false }))
            .resolves.toBeUndefined();
        expect(secrets.get).toHaveBeenCalledWith('pi-code.apiKey.deepseek');
    });
});
