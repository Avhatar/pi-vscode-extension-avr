import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

type ContextWindowOverride = {
    provider: string;
    modelIds: readonly string[];
    upstreamValue: number;
    correctedValue: number;
};

/**
 * Temporary corrections for inaccurate GPT-5.6 metadata in the bundled Pi SDK.
 *
 * The authenticated Codex model catalog reports a 272k window for subscription
 * access, while the direct OpenAI API model documentation reports 1.05M. Only
 * replace the known upstream values so explicit user overrides remain intact.
 */
const CONTEXT_WINDOW_OVERRIDES: readonly ContextWindowOverride[] = [
    {
        provider: 'openai-codex',
        modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        upstreamValue: 372_000,
        correctedValue: 272_000,
    },
    {
        provider: 'openai',
        modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        upstreamValue: 272_000,
        correctedValue: 1_050_000,
    },
];

/** Apply known metadata corrections in-place and return the number changed. */
export function applyModelMetadataCorrections(
    registry: Pick<ModelRegistry, 'getAll'>,
): number {
    let corrected = 0;

    for (const model of registry.getAll()) {
        const override = CONTEXT_WINDOW_OVERRIDES.find(candidate =>
            candidate.provider === model.provider
            && candidate.modelIds.includes(model.id)
            && candidate.upstreamValue === model.contextWindow,
        );
        if (!override) continue;

        model.contextWindow = override.correctedValue;
        corrected += 1;
    }

    return corrected;
}
