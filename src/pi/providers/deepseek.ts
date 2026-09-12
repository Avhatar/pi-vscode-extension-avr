import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

const DEEPSEEK_PROVIDER_ID = 'deepseek';

/** DeepSeek's current Flash SKU, released 2026-09-10 (text + image, tool calling). */
export const DEEPSEEK_FLASH_MODEL_ID = 'deepseek-flash';
export const DEEPSEEK_FLASH_MODEL_NAME = 'DeepSeek V4.1 Flash';

/**
 * V4.1 Flash inherits V4 Flash's limits and provider quirks (1M context, 384K
 * output, `supportsDeveloperRole: false`,
 * `requiresReasoningContentOnAssistantMessages: true`, the `deepseek` thinking
 * format and its level map), so the flash entry is the correct metadata
 * template. Cloning it keeps those fields in sync with whatever the bundled SDK
 * catalog declares instead of freezing a hand-written copy.
 */
const TEMPLATE_MODEL_ID = 'deepseek-v4-flash';

/**
 * V4 Flash and V4 Flash Vision Exp were retired with the V4.1 release; DeepSeek
 * temporarily routes both ids to V4.1 Flash. They therefore serve a multimodal
 * model at V4.1 prices, whatever the catalog that predates the release says.
 * `deepseek-v4-pro` is absent on purpose — it is still served under its own id.
 */
const ROUTED_MODEL_IDS: readonly string[] = [TEMPLATE_MODEL_ID, 'deepseek-v4-flash-vision-exp'];

/** V4.1 Flash prices, USD per 1M tokens, as published on 2026-09-10. */
const FLASH_COST = { input: 0.15, output: 0.6, cacheRead: 0.003 };

/**
 * The V4 Flash prices every pre-V4.1 catalog carries. Corrections apply only to
 * this exact triple, matching `DOCUMENTED_API_OVERRIDES` in `model-metadata.ts`:
 * a catalog quoting anything else knows something this constant does not, and
 * overwriting it would replace fresher data with a guess.
 */
const RETIRED_FLASH_COST = { input: 0.14, output: 0.28, cacheRead: 0.0028 };

type ProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];
type ProviderModelConfig = NonNullable<ProviderConfig['models']>[number];
type RuntimeModel = ReturnType<ModelRuntime['getModels']>[number];

export type DeepSeekFlashRuntime = Pick<ModelRuntime, 'getModel' | 'getModels' | 'registerProvider'>;

/**
 * Temporary shim: expose DeepSeek V4.1 Flash until the Pi SDK ships it.
 *
 * `models.dev` already lists `deepseek-flash`, but the bundled Pi catalog is
 * generated from that source at release time and the newest published SDK
 * predates the model, so the entry is missing: the model cannot be picked at
 * all, and the two retired ids that still reach it carry stale metadata —
 * `deepseek-v4-flash` claims `input: ['text']`, which makes the chat panel
 * refuse image attachments (`supportsImages` is derived from `model.input`) and
 * the image-compat guard strip images from the history, and both ids quote V4
 * prices, which understates every turn cost recorded against the DeepSeek
 * balance ledger.
 *
 * The shim composes over the built-in provider instead of replacing it:
 * `registerProvider` layers on top of the SDK provider, so API-key resolution
 * (`DEEPSEEK_API_KEY` plus our SecretStorage runtime override) and streaming
 * keep coming from the built-in DeepSeek provider. Because the extension layer
 * replaces the provider's model list wholesale, the existing models are cloned
 * rather than re-declared by hand — the SDK catalog stays the single source of
 * truth for everything except the added entry and the two corrections.
 *
 * It retires itself: once a Pi release lists `deepseek-flash`, `getModel` finds
 * it and no extension layer is registered at all. That also drops the legacy
 * corrections, which is correct — a catalog new enough to carry V4.1 Flash is
 * regenerated from a `models.dev` that has already repriced the routed ids. The
 * same check makes repeated calls (every `prepareModelRuntime`) idempotent.
 *
 * @returns whether this call registered the model.
 */
export function registerDeepSeekFlashModel(runtime: DeepSeekFlashRuntime): boolean {
    if (runtime.getModel(DEEPSEEK_PROVIDER_ID, DEEPSEEK_FLASH_MODEL_ID)) return false;

    const baseModels = runtime.getModels(DEEPSEEK_PROVIDER_ID);
    const template = baseModels.find((model) => model.id === TEMPLATE_MODEL_ID);
    // An unknown catalog shape (provider absent, or flash renamed) means the
    // assumptions behind the cloned metadata no longer hold — leave the
    // built-in provider untouched instead of guessing.
    if (!template) return false;

    runtime.registerProvider(DEEPSEEK_PROVIDER_ID, {
        models: [
            ...baseModels.map((model) => correctRoutedModel(toProviderModelConfig(model))),
            {
                ...toProviderModelConfig(template),
                id: DEEPSEEK_FLASH_MODEL_ID,
                name: DEEPSEEK_FLASH_MODEL_NAME,
                input: ['text', 'image'],
                cost: { ...template.cost, ...FLASH_COST },
            },
        ],
    });
    return true;
}

/**
 * Bring a retired id in line with the model it actually reaches. Image input is
 * a property of that routing rather than a value read off the catalog, so it is
 * added whenever it is missing; the price is only corrected when the entry
 * still quotes the superseded V4 numbers.
 */
function correctRoutedModel(model: ProviderModelConfig): ProviderModelConfig {
    if (!ROUTED_MODEL_IDS.includes(model.id)) return model;
    const corrected = { ...model };
    if (!corrected.input.includes('image')) corrected.input = [...corrected.input, 'image'];
    if (isRetiredFlashCost(corrected.cost)) corrected.cost = { ...corrected.cost, ...FLASH_COST };
    return corrected;
}

function isRetiredFlashCost(cost: ProviderModelConfig['cost']): boolean {
    return !!cost
        && cost.input === RETIRED_FLASH_COST.input
        && cost.output === RETIRED_FLASH_COST.output
        && cost.cacheRead === RETIRED_FLASH_COST.cacheRead;
}

function toProviderModelConfig(model: RuntimeModel): ProviderModelConfig {
    return { ...model, input: [...model.input], cost: { ...model.cost } } as ProviderModelConfig;
}
