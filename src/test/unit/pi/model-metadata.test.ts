import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isContextUsageEstimated } from '../../../pi/context-usage';
import {
    applyCodexCatalogMetadata,
    applyDocumentedApiMetadata,
    parseCodexModelCatalog,
    refreshModelMetadata,
} from '../../../pi/model-metadata';
import {
    _resetCodexCatalogCacheForTests,
    getCachedCodexCatalog,
    setCachedCodexCatalog,
} from '../../../pi/codex-catalog-cache';

describe('provider model metadata', () => {
    beforeEach(() => {
        _resetCodexCatalogCacheForTests();
    });

    it('uses the published direct OpenAI API window without hardcoding Codex', () => {
        const models = ['sol', 'terra', 'luna'].flatMap(variant => [
            model('openai-codex', `gpt-5.6-${variant}`, 372_000),
            model('openai', `gpt-5.6-${variant}`, 272_000),
        ]);
        const registry = { getAll: () => models } as any;

        expect(applyDocumentedApiMetadata(registry)).toBe(3);
        expect(models.filter(item => item.provider === 'openai-codex')
            .every(item => item.contextWindow === 372_000)).toBe(true);
        expect(models.filter(item => item.provider === 'openai')
            .every(item => item.contextWindow === 1_050_000)).toBe(true);
    });

    it('parses and applies the account-specific Codex catalog window', () => {
        const models = [
            model('openai-codex', 'gpt-5.6-sol', 372_000),
            model('openai-codex', 'gpt-5.6-terra', 372_000),
            model('openai', 'gpt-5.6-sol', 1_050_000),
        ];
        const catalog = parseCodexModelCatalog({ models: [
            {
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                max_context_window: 272_000,
                effective_context_window_percent: 95,
            },
            { slug: 'gpt-5.6-terra', context_window: 272_000 },
            { slug: 'malformed', context_window: 0 },
        ] });

        expect(catalog[0]).toEqual({
            slug: 'gpt-5.6-sol',
            contextWindow: 272_000,
            maxContextWindow: 272_000,
            effectiveContextWindowPercent: 95,
        });
        expect(applyCodexCatalogMetadata({ getAll: () => models } as any, catalog)).toBe(2);
        expect(models.map(item => item.contextWindow)).toEqual([272_000, 272_000, 1_050_000]);
    });

    it('tracks later Codex catalog changes instead of pinning the first value', () => {
        const models = [model('openai-codex', 'gpt-5.6-luna', 272_000)];
        const catalog = parseCodexModelCatalog({
            models: [{ slug: 'gpt-5.6-luna', context_window: 372_000 }],
        });

        expect(applyCodexCatalogMetadata({ getAll: () => models } as any, catalog)).toBe(1);
        expect(models[0].contextWindow).toBe(372_000);
        expect(applyCodexCatalogMetadata({ getAll: () => models } as any, catalog)).toBe(0);
    });

    it('fetches Codex metadata with the current account credentials', async () => {
        const token = jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
        });
        const authStorage = {
            getApiKey: vi.fn().mockResolvedValue(token),
        };
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                effective_context_window_percent: 95,
            }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const models = [model('openai-codex', 'gpt-5.6-sol', 372_000)];

        expect(await refreshModelMetadata(
            { getAll: () => models } as any,
            authStorage as any,
            undefined,
            fetchImpl as any,
        )).toBe(1);
        expect(models[0].contextWindow).toBe(272_000);
        expect(String(fetchImpl.mock.calls[0][0])).toContain('/backend-api/codex/models?client_version=0.144.0');
        expect(fetchImpl.mock.calls[0][1].headers['chatgpt-account-id']).toBe('account-123');
    });

    it('rejects model payloads without usable context metadata', () => {
        expect(() => parseCodexModelCatalog(null)).toThrow('not an object');
        expect(() => parseCodexModelCatalog({ models: [] })).toThrow('no context metadata');
    });

    it('reuses the persisted Codex catalog without hitting the network', async () => {
        const token = jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account-cache' },
        });
        const authStorage = { getApiKey: vi.fn().mockResolvedValue(token) };
        const fetchImpl = vi.fn();
        setCachedCodexCatalog('account-cache', [{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }]);
        const models = [model('openai-codex', 'gpt-5.6-sol', 372_000)];

        expect(await refreshModelMetadata(
            { getAll: () => models } as any,
            authStorage as any,
            undefined,
            fetchImpl as any,
        )).toBe(1);
        expect(models[0].contextWindow).toBe(272_000);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('serves stale Codex catalog immediately and refreshes it in the background', async () => {
        const token = jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account-stale' },
        });
        const authStorage = { getApiKey: vi.fn().mockResolvedValue(token) };
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.6-sol', context_window: 300_000 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        // Seed a very old entry so the freshness check treats it as stale.
        setCachedCodexCatalog('account-stale', [{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }]);
        const seeded = getCachedCodexCatalog('account-stale');
        if (seeded) seeded.capturedAt = Date.now() - (48 * 60 * 60_000);
        const models = [model('openai-codex', 'gpt-5.6-sol', 372_000)];

        // refreshModelMetadata resolves synchronously with the stale value.
        await refreshModelMetadata(
            { getAll: () => models } as any,
            authStorage as any,
            undefined,
            fetchImpl as any,
        );
        expect(models[0].contextWindow).toBe(272_000);

        // Yield so the background revalidation completes and mutates the model.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(models[0].contextWindow).toBe(300_000);
        const refreshed = getCachedCodexCatalog('account-stale');
        expect(refreshed?.models[0].contextWindow).toBe(300_000);
    });
});

describe('context usage estimation marker', () => {
    it('marks usage as exact when the latest message has provider usage', () => {
        expect(isContextUsageEstimated([
            { role: 'user', content: 'hello' },
            assistantWithUsage(),
        ])).toBe(false);
    });

    it('marks trailing messages and conversations without usage as estimated', () => {
        expect(isContextUsageEstimated([
            assistantWithUsage(),
            { role: 'user', content: 'next turn' },
        ])).toBe(true);
        expect(isContextUsageEstimated([
            { role: 'user', content: 'first turn' },
        ])).toBe(true);
    });

    it('ignores invalid assistant usage snapshots', () => {
        expect(isContextUsageEstimated([
            assistantWithUsage('error'),
        ])).toBe(true);
        expect(isContextUsageEstimated([
            { ...assistantWithUsage(), usage: { totalTokens: 0, input: 0, output: 0 } },
        ])).toBe(true);
        expect(isContextUsageEstimated([])).toBe(false);
    });
});

function model(provider: string, id: string, contextWindow: number) {
    return { provider, id, contextWindow };
}

function assistantWithUsage(stopReason = 'stop') {
    return {
        role: 'assistant',
        stopReason,
        usage: { totalTokens: 123, input: 100, output: 23, cacheRead: 0, cacheWrite: 0 },
    };
}

function jwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}
