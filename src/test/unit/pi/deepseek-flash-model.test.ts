import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    DEEPSEEK_FLASH_MODEL_ID,
    DEEPSEEK_FLASH_MODEL_NAME,
    registerDeepSeekFlashModel,
} from '../../../pi/providers/deepseek';
import { getTestModelRuntime, initTestInfra } from '../../setup';

const DEEPSEEK_COMPAT = {
    supportsStore: false,
    supportsDeveloperRole: false,
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
};

const THINKING_LEVEL_MAP = {
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    max: 'max',
};

/** The V4 Flash prices every catalog predating V4.1 Flash still carries. */
const RETIRED_COST = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 };
/** The prices DeepSeek published for V4.1 Flash on 2026-09-10. */
const CURRENT_COST = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };
/** The off-peak V4 Pro prices DeepSeek published on 2026-09-10. */
const CURRENT_PRO_COST = { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 };

/** Mirrors the metadata the bundled Pi catalog ships for DeepSeek. */
function flashModel(id = 'deepseek-v4-flash', name = 'DeepSeek V4 Flash') {
    return {
        id,
        name,
        api: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        provider: 'deepseek',
        reasoning: true,
        input: ['text'],
        cost: { ...RETIRED_COST },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: { ...DEEPSEEK_COMPAT },
        thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    };
}

function visionModel() {
    return {
        ...flashModel('deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp'),
        input: ['text', 'image'],
    };
}

function proModel() {
    return {
        ...flashModel('deepseek-v4-pro', 'DeepSeek V4 Pro'),
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    };
}

/** The three entries a pre-V4.1 SDK catalog carries. */
function catalogModels() {
    return [flashModel(), visionModel(), proModel()];
}

function createRuntime(models: any[]) {
    let current = [...models];
    const registerProvider = vi.fn((providerId: string, config: any) => {
        // Mirror the SDK's extension layer: a provided model list replaces the
        // provider's models, and every entry belongs to that provider.
        current = [
            ...current.filter((model) => model.provider !== providerId),
            ...config.models.map((model: any) => ({ ...model, provider: providerId })),
        ];
    });
    return {
        registerProvider,
        getModel: (provider: string, id: string) =>
            current.find((model) => model.provider === provider && model.id === id),
        getModels: (provider?: string) =>
            provider ? current.filter((model) => model.provider === provider) : current,
    };
}

describe('DeepSeek V4.1 Flash catalog shim', () => {
    it('appends the new model to the catalog models', () => {
        const runtime = createRuntime(catalogModels());

        expect(registerDeepSeekFlashModel(runtime as any)).toBe(true);
        expect(runtime.registerProvider).toHaveBeenCalledTimes(1);

        const [providerId, config] = runtime.registerProvider.mock.calls[0];
        expect(providerId).toBe('deepseek');
        expect(config.models.map((model: any) => model.id)).toEqual([
            'deepseek-v4-flash',
            'deepseek-v4-flash-vision-exp',
            'deepseek-v4-pro',
            DEEPSEEK_FLASH_MODEL_ID,
        ]);
    });

    it('derives the new entry from the flash template and only restates what changed', () => {
        const runtime = createRuntime(catalogModels());
        registerDeepSeekFlashModel(runtime as any);

        const flash = runtime.getModel('deepseek', DEEPSEEK_FLASH_MODEL_ID);
        const template = flashModel();
        expect(flash).toMatchObject({
            name: DEEPSEEK_FLASH_MODEL_NAME,
            input: ['text', 'image'],
            cost: CURRENT_COST,
            api: template.api,
            baseUrl: template.baseUrl,
            reasoning: template.reasoning,
            contextWindow: template.contextWindow,
            maxTokens: template.maxTokens,
            compat: template.compat,
            thinkingLevelMap: template.thinkingLevelMap,
        });
    });

    it('corrects the retired ids DeepSeek routes to V4.1 Flash', () => {
        const runtime = createRuntime(catalogModels());
        registerDeepSeekFlashModel(runtime as any);

        expect(runtime.getModel('deepseek', 'deepseek-v4-flash')).toMatchObject({
            name: 'DeepSeek V4 Flash',
            input: ['text', 'image'],
            cost: CURRENT_COST,
            compat: DEEPSEEK_COMPAT,
        });
        expect(runtime.getModel('deepseek', 'deepseek-v4-flash-vision-exp')).toMatchObject({
            input: ['text', 'image'],
            cost: CURRENT_COST,
        });
    });

    it('reprices V4 Pro without giving it image input', () => {
        const runtime = createRuntime(catalogModels());
        registerDeepSeekFlashModel(runtime as any);

        // DeepSeek kept serving V4 Pro under its own id and reversed the
        // announced reroute to V4.1 Flash, so only its prices moved.
        expect(runtime.getModel('deepseek', 'deepseek-v4-pro')).toMatchObject({
            input: ['text'],
            cost: CURRENT_PRO_COST,
        });
    });

    it('keeps prices the SDK already changed', () => {
        const repriced = { ...flashModel(), cost: { input: 0.2, output: 0.8, cacheRead: 0.004, cacheWrite: 0 } };
        const repricedPro = { ...proModel(), cost: { input: 0.7, output: 2.1, cacheRead: 0.03, cacheWrite: 0 } };
        const runtime = createRuntime([repriced, repricedPro]);

        registerDeepSeekFlashModel(runtime as any);

        expect(runtime.getModel('deepseek', 'deepseek-v4-flash')!.cost).toEqual(repriced.cost);
        expect(runtime.getModel('deepseek', 'deepseek-v4-pro')!.cost).toEqual(repricedPro.cost);
        // The new entry still carries the published V4.1 prices rather than
        // inheriting an unrecognized template cost.
        expect(runtime.getModel('deepseek', DEEPSEEK_FLASH_MODEL_ID)!.cost).toMatchObject(CURRENT_COST);
    });

    it('does not mutate the runtime models it clones', () => {
        const models = catalogModels();
        const runtime = createRuntime(models);

        registerDeepSeekFlashModel(runtime as any);

        expect(models[0].input).toEqual(['text']);
        expect(models[0].cost).toEqual(RETIRED_COST);
    });

    it('is a no-op once the model is already registered', () => {
        const runtime = createRuntime(catalogModels());

        expect(registerDeepSeekFlashModel(runtime as any)).toBe(true);
        expect(registerDeepSeekFlashModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).toHaveBeenCalledTimes(1);
    });

    it('retires itself when the SDK catalog ships V4.1 Flash', () => {
        const shipped = {
            ...flashModel(DEEPSEEK_FLASH_MODEL_ID, DEEPSEEK_FLASH_MODEL_NAME),
            input: ['text', 'image'],
            cost: { ...CURRENT_COST },
        };
        const runtime = createRuntime([...catalogModels(), shipped]);

        expect(registerDeepSeekFlashModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).not.toHaveBeenCalled();
    });

    it('leaves the provider alone when the template model is missing', () => {
        const runtime = createRuntime([{ ...flashModel('deepseek-v5-flash', 'DeepSeek V5 Flash') }]);

        expect(registerDeepSeekFlashModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).not.toHaveBeenCalled();
    });

    it('leaves an unconfigured provider alone', () => {
        const runtime = createRuntime([]);

        expect(registerDeepSeekFlashModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).not.toHaveBeenCalled();
    });
});

// The shim's whole design rests on how the SDK composes an extension model list
// over a built-in provider, so assert it against the real runtime rather than a
// stand-in. Both branches are valid outcomes: the shim registers the model, or a
// future SDK catalog already ships it.
describe('DeepSeek V4.1 Flash shim against the bundled SDK catalog', () => {
    beforeAll(async () => {
        await initTestInfra();
    });

    it('exposes an image-capable V4.1 Flash entry with the provider quirks intact', () => {
        const runtime = getTestModelRuntime();
        registerDeepSeekFlashModel(runtime);

        const flash = runtime.getModel('deepseek', DEEPSEEK_FLASH_MODEL_ID);
        expect(flash?.input).toContain('image');
        expect(flash?.api).toBe('openai-completions');
        expect(flash?.baseUrl).toBe('https://api.deepseek.com');
        expect(flash?.contextWindow).toBe(1_000_000);
        // DeepSeek rejects the OpenAI `developer` role and needs reasoning
        // content echoed back, so the cloned compat flags must survive.
        expect(flash?.compat).toMatchObject({
            supportsDeveloperRole: false,
            requiresReasoningContentOnAssistantMessages: true,
        });
        expect(flash?.cost).toMatchObject({ input: 0.15, output: 0.6 });
    });

    it('keeps the routed legacy ids usable and repriced', () => {
        const runtime = getTestModelRuntime();
        registerDeepSeekFlashModel(runtime);

        const legacy = runtime.getModel('deepseek', 'deepseek-v4-flash');
        expect(legacy?.input).toContain('image');
        expect(legacy?.cost).toMatchObject({ input: 0.15, output: 0.6 });
        expect(runtime.getModel('deepseek', 'deepseek-v4-flash-vision-exp')?.input).toContain('image');
        // V4 Pro keeps its own id and text-only input, with the current prices.
        const pro = runtime.getModel('deepseek', 'deepseek-v4-pro');
        expect(pro?.input).toEqual(['text']);
        expect(pro?.cost).toMatchObject(CURRENT_PRO_COST);
    });

    it('keeps other providers untouched', () => {
        const runtime = getTestModelRuntime();
        const anthropicBefore = runtime.getModels('anthropic').length;

        registerDeepSeekFlashModel(runtime);

        expect(runtime.getModels('anthropic').length).toBe(anthropicBefore);
    });
});
