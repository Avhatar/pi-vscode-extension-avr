import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    DEEPSEEK_VISION_MODEL_ID,
    DEEPSEEK_VISION_MODEL_NAME,
    registerDeepSeekVisionModel,
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
    low: null,
    medium: null,
    high: 'high',
    max: 'max',
};

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
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: { ...DEEPSEEK_COMPAT },
        thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    };
}

function proModel() {
    return {
        ...flashModel('deepseek-v4-pro', 'DeepSeek V4 Pro'),
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    };
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

describe('DeepSeek vision model shim', () => {
    it('adds the vision model on top of the catalog models', () => {
        const runtime = createRuntime([flashModel(), proModel()]);

        expect(registerDeepSeekVisionModel(runtime as any)).toBe(true);
        expect(runtime.registerProvider).toHaveBeenCalledTimes(1);

        const [providerId, config] = runtime.registerProvider.mock.calls[0];
        expect(providerId).toBe('deepseek');
        expect(config.models.map((model: any) => model.id)).toEqual([
            'deepseek-v4-flash',
            'deepseek-v4-pro',
            DEEPSEEK_VISION_MODEL_ID,
        ]);
    });

    it('derives the vision entry from the flash model and only widens its input', () => {
        const runtime = createRuntime([flashModel(), proModel()]);
        registerDeepSeekVisionModel(runtime as any);

        const vision = runtime.getModel('deepseek', DEEPSEEK_VISION_MODEL_ID);
        const flash = flashModel();
        expect(vision).toMatchObject({
            name: DEEPSEEK_VISION_MODEL_NAME,
            input: ['text', 'image'],
            api: flash.api,
            baseUrl: flash.baseUrl,
            reasoning: flash.reasoning,
            cost: flash.cost,
            contextWindow: flash.contextWindow,
            maxTokens: flash.maxTokens,
            compat: flash.compat,
            thinkingLevelMap: flash.thinkingLevelMap,
        });
    });

    it('preserves the existing text-only models', () => {
        const runtime = createRuntime([flashModel(), proModel()]);
        registerDeepSeekVisionModel(runtime as any);

        expect(runtime.getModel('deepseek', 'deepseek-v4-flash')).toMatchObject({
            input: ['text'],
            compat: DEEPSEEK_COMPAT,
            cost: flashModel().cost,
        });
        expect(runtime.getModel('deepseek', 'deepseek-v4-pro')).toMatchObject({
            input: ['text'],
            cost: proModel().cost,
        });
    });

    it('does not clone the template model input array', () => {
        const models = [flashModel(), proModel()];
        const runtime = createRuntime(models);
        registerDeepSeekVisionModel(runtime as any);

        expect(runtime.getModel('deepseek', 'deepseek-v4-flash')!.input).toEqual(['text']);
    });

    it('is a no-op once the model is already registered', () => {
        const runtime = createRuntime([flashModel(), proModel()]);

        expect(registerDeepSeekVisionModel(runtime as any)).toBe(true);
        expect(registerDeepSeekVisionModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).toHaveBeenCalledTimes(1);
    });

    it('retires itself when the SDK catalog ships the vision model', () => {
        const shipped = {
            ...flashModel(DEEPSEEK_VISION_MODEL_ID, 'DeepSeek V4 Flash Vision Exp'),
            input: ['text', 'image'],
        };
        const runtime = createRuntime([flashModel(), proModel(), shipped]);

        expect(registerDeepSeekVisionModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).not.toHaveBeenCalled();
    });

    it('leaves the provider alone when the template model is missing', () => {
        const runtime = createRuntime([{ ...flashModel('deepseek-v5-flash', 'DeepSeek V5 Flash') }]);

        expect(registerDeepSeekVisionModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).not.toHaveBeenCalled();
    });

    it('leaves an unconfigured provider alone', () => {
        const runtime = createRuntime([]);

        expect(registerDeepSeekVisionModel(runtime as any)).toBe(false);
        expect(runtime.registerProvider).not.toHaveBeenCalled();
    });
});

// The shim's whole design rests on how the SDK composes an extension model list
// over a built-in provider, so assert it against the real runtime rather than a
// stand-in. Both branches are valid outcomes: the shim registers the model, or a
// future SDK catalog already ships it.
describe('DeepSeek vision model shim against the bundled SDK catalog', () => {
    beforeAll(async () => {
        await initTestInfra();
    });

    it('exposes an image-capable DeepSeek model without losing the text-only ones', () => {
        const runtime = getTestModelRuntime();
        registerDeepSeekVisionModel(runtime);

        const vision = runtime.getModel('deepseek', DEEPSEEK_VISION_MODEL_ID);
        expect(vision?.input).toContain('image');
        expect(vision?.api).toBe('openai-completions');
        expect(vision?.baseUrl).toBe('https://api.deepseek.com');

        const flash = runtime.getModel('deepseek', 'deepseek-v4-flash');
        expect(flash?.input).toEqual(['text']);
        // DeepSeek rejects the OpenAI `developer` role and needs reasoning
        // content echoed back, so the cloned compat flags must survive.
        expect(flash?.compat).toMatchObject({
            supportsDeveloperRole: false,
            requiresReasoningContentOnAssistantMessages: true,
        });
        expect(runtime.getModel('deepseek', 'deepseek-v4-pro')).toBeDefined();
    });

    it('keeps other providers untouched', () => {
        const runtime = getTestModelRuntime();
        const anthropicBefore = runtime.getModels('anthropic').length;

        registerDeepSeekVisionModel(runtime);

        expect(runtime.getModels('anthropic').length).toBe(anthropicBefore);
    });
});
