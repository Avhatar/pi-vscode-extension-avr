import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestModelRuntime, initTestInfra } from '../../setup';
import { higherRateAboveTokens, isContextUsageEstimated } from '../../../pi/context-usage';
import {
    applyCodexCatalogMetadata,
    applyCodexLongContextExemptions,
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
        const runtime = { getModels: () => models } as any;

        expect(applyDocumentedApiMetadata(runtime)).toBe(3);
        expect(models.filter(item => item.provider === 'openai-codex')
            .every(item => item.contextWindow === 372_000)).toBe(true);
        expect(models.filter(item => item.provider === 'openai')
            .every(item => item.contextWindow === 1_050_000)).toBe(true);
    });

    it('corrects the GPT-6 Astra window on the direct API but leaves Codex to its catalog', () => {
        const models = [
            model('openai', 'gpt-6-astra', 272_000),
            model('openai-codex', 'gpt-6-astra', 272_000),
        ];
        const runtime = { getModels: () => models } as any;

        expect(applyDocumentedApiMetadata(runtime)).toBe(1);
        expect(models[0].contextWindow).toBe(1_050_000);
        // Codex windows are plan-specific; `applyCodexCatalogMetadata` owns them.
        expect(models[1].contextWindow).toBe(272_000);
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
        expect(applyCodexCatalogMetadata({ getModels: () => models } as any, catalog)).toBe(2);
        expect(models.map(item => item.contextWindow)).toEqual([272_000, 272_000, 1_050_000]);
    });

    it('tracks later Codex catalog changes instead of pinning the first value', () => {
        const models = [model('openai-codex', 'gpt-5.6-luna', 272_000)];
        const catalog = parseCodexModelCatalog({
            models: [{ slug: 'gpt-5.6-luna', context_window: 372_000 }],
        });

        expect(applyCodexCatalogMetadata({ getModels: () => models } as any, catalog)).toBe(1);
        expect(models[0].contextWindow).toBe(372_000);
        expect(applyCodexCatalogMetadata({ getModels: () => models } as any, catalog)).toBe(0);
    });

    it('uses the account ceiling when the catalog reports a larger max_context_window', () => {
        const models = [
            model('openai-codex', 'gpt-6-astra', 272_000),
            model('openai-codex', 'gpt-5.6-sol', 272_000),
            model('openai-codex', 'gpt-5.5', 272_000),
        ];
        const catalog = parseCodexModelCatalog({ models: [
            { slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 },
            { slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 872_000 },
            { slug: 'gpt-5.5', context_window: 272_000, max_context_window: 272_000 },
        ] });

        expect(applyCodexCatalogMetadata({ getModels: () => models } as any, catalog)).toBe(2);
        expect(models.map(item => item.contextWindow)).toEqual([872_000, 872_000, 272_000]);
    });

    it('corrects the documented direct-API window of GPT-5.4 and GPT-5.5 only outside Codex', () => {
        const models = [
            model('openai', 'gpt-5.4', 272_000),
            model('openai', 'gpt-5.5', 272_000),
            model('openai-codex', 'gpt-5.4', 272_000),
            model('openai-codex', 'gpt-5.5', 272_000),
            model('openai', 'gpt-5.4-mini', 400_000),
        ];

        expect(applyDocumentedApiMetadata({ getModels: () => models } as any)).toBe(2);
        expect(models.map(item => item.contextWindow)).toEqual([
            1_050_000, 1_050_000, 272_000, 272_000, 400_000,
        ]);
    });

    it('drops the long-context tier OpenAI does not charge for Astra inside Codex', () => {
        const models = [
            codexAstra(),
            // The same model on the direct API still pays the multiplier.
            {
                ...codexAstra(),
                provider: 'openai',
            },
        ];

        expect(applyCodexLongContextExemptions({ getModels: () => models } as any)).toBe(1);
        expect((models[0] as any).cost.tiers).toEqual([]);
        expect((models[1] as any).cost.tiers).toHaveLength(1);
        // Idempotent: the guard can no longer match once the tier is gone.
        expect(applyCodexLongContextExemptions({ getModels: () => models } as any)).toBe(0);
    });

    it('leaves a Codex Astra entry alone when its catalog quotes other prices', () => {
        const models = [{
            ...codexAstra(),
            cost: { ...codexAstra().cost, input: 11 },
        }];

        expect(applyCodexLongContextExemptions({ getModels: () => models } as any)).toBe(0);
        expect((models[0] as any).cost.tiers).toHaveLength(1);
    });

    it('fetches Codex metadata with the current account credentials', async () => {
        const token = jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
        });
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            models: [{
                slug: 'gpt-5.6-sol',
                context_window: 272_000,
                effective_context_window_percent: 95,
            }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const models = [model('openai-codex', 'gpt-5.6-sol', 372_000)];
        const runtime = {
            getModels: () => models,
            getAuth: vi.fn().mockResolvedValue({ auth: { apiKey: token } }),
        };

        expect(await refreshModelMetadata(
            runtime as any,
            undefined,
            fetchImpl as any,
        )).toBe(1);
        expect(models[0].contextWindow).toBe(272_000);
        expect(String(fetchImpl.mock.calls[0][0])).toContain('/backend-api/codex/models?client_version=0.153.0');
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
        const fetchImpl = vi.fn();
        setCachedCodexCatalog('account-cache', [{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }], '0.153.0');
        const models = [model('openai-codex', 'gpt-5.6-sol', 372_000)];
        const runtime = {
            getModels: () => models,
            getAuth: vi.fn().mockResolvedValue({ auth: { apiKey: token } }),
        };

        expect(await refreshModelMetadata(
            runtime as any,
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
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.6-sol', context_window: 300_000 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        // Seed a very old entry so the freshness check treats it as stale.
        setCachedCodexCatalog('account-stale', [{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }], '0.153.0');
        const seeded = getCachedCodexCatalog('account-stale');
        if (seeded) seeded.capturedAt = Date.now() - (48 * 60 * 60_000);
        const models = [model('openai-codex', 'gpt-5.6-sol', 372_000)];
        const runtime = {
            getModels: () => models,
            getAuth: vi.fn().mockResolvedValue({ auth: { apiKey: token } }),
        };

        // refreshModelMetadata resolves synchronously with the stale value.
        await refreshModelMetadata(
            runtime as any,
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

    it('refetches a catalog captured for an older Codex client version', async () => {
        const token = jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'account-versioned' },
        });
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            models: [{
                slug: 'gpt-6-astra',
                context_window: 272_000,
                max_context_window: 872_000,
            }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        // A fresh entry, but fetched before Astra became visible at 0.153.0.
        setCachedCodexCatalog('account-versioned', [{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }], '0.144.0');
        const models = [model('openai-codex', 'gpt-6-astra', 272_000)];
        const runtime = {
            getModels: () => models,
            getAuth: vi.fn().mockResolvedValue({ auth: { apiKey: token } }),
        };

        await refreshModelMetadata(runtime as any, undefined, fetchImpl as any);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(models[0].contextWindow).toBe(872_000);
        expect(getCachedCodexCatalog('account-versioned')?.clientVersion).toBe('0.153.0');
    });
});

describe('higher-rate context threshold', () => {
    it('reads the lowest tier threshold off the model cost table', () => {
        expect(higherRateAboveTokens({
            cost: { tiers: [{ inputTokensAbove: 400_000 }, { inputTokensAbove: 272_000 }] },
        })).toBe(272_000);
        expect(higherRateAboveTokens({ cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })).toBeUndefined();
        expect(higherRateAboveTokens({ cost: { tiers: [] } })).toBeUndefined();
        expect(higherRateAboveTokens(undefined)).toBeUndefined();
        expect(higherRateAboveTokens({})).toBeUndefined();
    });

    it('ignores unusable thresholds', () => {
        expect(higherRateAboveTokens({ cost: { tiers: [{ inputTokensAbove: 0 }] } })).toBeUndefined();
        expect(higherRateAboveTokens({ cost: { tiers: [{ inputTokensAbove: -1 }] } })).toBeUndefined();
        expect(higherRateAboveTokens({ cost: { tiers: [{ inputTokensAbove: 'many' }] } })).toBeUndefined();
        expect(higherRateAboveTokens({ cost: { tiers: [{ inputTokensAbove: 272_000 }, null] } })).toBe(272_000);
    });

    it('drops the Astra Codex tier so the warning cannot fire there', () => {
        const astra = codexAstra();

        expect(higherRateAboveTokens(astra)).toBe(272_000);
        expect(applyCodexLongContextExemptions({ getModels: () => [astra] } as any)).toBe(1);
        expect(higherRateAboveTokens(astra)).toBeUndefined();
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

describe('Codex long-context exemption against the bundled SDK catalog', () => {
    beforeAll(async () => {
        await initTestInfra();
    });

    it('still matches the published figures the exemption is guarded on', () => {
        const astra: any = getTestModelRuntime().getModel('openai-codex', 'gpt-6-astra');
        expect(astra).toBeDefined();

        // The exemption fires only on these exact numbers, so a catalog that
        // reprices Astra silently skips it. Re-check OpenAI's Work and Codex
        // rate card before widening either expectation.
        expect(astra.cost).toMatchObject({ input: 10, output: 50, cacheRead: 1 });
        expect(astra.cost.tiers).toEqual([
            expect.objectContaining({ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2 }),
        ]);

        // Applying it to a copy leaves the shared runtime untouched.
        const copy = { provider: 'openai-codex', id: 'gpt-6-astra', cost: { ...astra.cost, tiers: [...astra.cost.tiers] } };
        expect(applyCodexLongContextExemptions({ getModels: () => [copy] } as any)).toBe(1);
        expect(copy.cost.tiers).toEqual([]);
        expect(higherRateAboveTokens(copy)).toBeUndefined();
    });

    it('rewrites the real runtime model in place and is idempotent', () => {
        const runtime = getTestModelRuntime();
        const astra: any = runtime.getModel('openai-codex', 'gpt-6-astra');
        const tiers = [...astra.cost.tiers];

        try {
            expect(applyCodexLongContextExemptions(runtime)).toBe(1);
            expect(runtime.getModel('openai-codex', 'gpt-6-astra')!.cost.tiers).toEqual([]);
            expect(higherRateAboveTokens(runtime.getModel('openai-codex', 'gpt-6-astra'))).toBeUndefined();
            expect(applyCodexLongContextExemptions(runtime)).toBe(0);
        } finally {
            // The runtime is shared across this file's tests.
            astra.cost.tiers = tiers;
        }
    });
});

function model(provider: string, id: string, contextWindow: number) {
    return { provider, id, contextWindow };
}

/** The bundled Codex entry for GPT-6 Astra, long-context tier included. */
function codexAstra() {
    return {
        provider: 'openai-codex',
        id: 'gpt-6-astra',
        contextWindow: 872_000,
        cost: {
            input: 10,
            output: 50,
            cacheRead: 1,
            cacheWrite: 12.5,
            tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
        },
    };
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
