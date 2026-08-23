import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

const DEEPSEEK_PROVIDER_ID = 'deepseek';

/** DeepSeek's vision SKU, announced 2026-08-21 (text + image, tool calling supported). */
export const DEEPSEEK_VISION_MODEL_ID = 'deepseek-v4-flash-vision-exp';
export const DEEPSEEK_VISION_MODEL_NAME = 'DeepSeek V4 Flash Vision (exp)';

/**
 * The vision SKU is priced and limited exactly like `deepseek-v4-flash`
 * (1M context, 384K output, identical per-token cost), so the flash entry is
 * the correct metadata template. Cloning it also keeps `compat` — DeepSeek
 * needs `supportsDeveloperRole: false` and
 * `requiresReasoningContentOnAssistantMessages: true` — and `thinkingLevelMap`
 * in sync with whatever the bundled SDK catalog declares.
 */
const VISION_TEMPLATE_MODEL_ID = 'deepseek-v4-flash';

type ProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];
type ProviderModelConfig = NonNullable<ProviderConfig['models']>[number];
type RuntimeModel = ReturnType<ModelRuntime['getModels']>[number];

export type DeepSeekVisionRuntime = Pick<ModelRuntime, 'getModel' | 'getModels' | 'registerProvider'>;

/**
 * Temporary shim: expose DeepSeek's vision model until the Pi SDK ships it.
 *
 * `models.dev` already lists `deepseek-v4-flash-vision-exp` with
 * `input: ["text","image"]`, but the bundled Pi catalog is generated from that
 * source at release time and the newest published SDK predates the model, so
 * the entry is missing and the chat panel refuses image attachments for every
 * DeepSeek model (`supportsImages` is derived from `model.input`).
 *
 * The shim composes over the built-in provider instead of replacing it:
 * `registerProvider` layers on top of the SDK provider, so API-key resolution
 * (`DEEPSEEK_API_KEY` plus our SecretStorage runtime override) and streaming
 * keep coming from the built-in DeepSeek provider. Because the extension layer
 * replaces the provider's model list wholesale, the existing models are cloned
 * verbatim rather than re-declared by hand — the SDK catalog stays the single
 * source of truth for everything except the one added entry.
 *
 * It retires itself: once a Pi release lists the model, `getModel` finds it and
 * no extension layer is registered at all. The same check makes repeated calls
 * (every `prepareModelRuntime`) idempotent.
 *
 * @returns whether this call registered the model.
 */
export function registerDeepSeekVisionModel(runtime: DeepSeekVisionRuntime): boolean {
    if (runtime.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_VISION_MODEL_ID)) return false;

    const baseModels = runtime.getModels(DEEPSEEK_PROVIDER_ID);
    const template = baseModels.find((model) => model.id === VISION_TEMPLATE_MODEL_ID);
    // An unknown catalog shape (provider absent, or flash renamed) means the
    // assumptions behind the cloned metadata no longer hold — leave the
    // built-in provider untouched instead of guessing.
    if (!template) return false;

    runtime.registerProvider(DEEPSEEK_PROVIDER_ID, {
        models: [
            ...baseModels.map(toProviderModelConfig),
            {
                ...toProviderModelConfig(template),
                id: DEEPSEEK_VISION_MODEL_ID,
                name: DEEPSEEK_VISION_MODEL_NAME,
                input: ['text', 'image'],
            },
        ],
    });
    return true;
}

function toProviderModelConfig(model: RuntimeModel): ProviderModelConfig {
    return { ...model, input: [...model.input] } as ProviderModelConfig;
}
