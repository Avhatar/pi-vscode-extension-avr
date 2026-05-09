/**
 * Provider classification for prompt cache retention behaviour.
 *
 * Every model in Pi flows through one of a handful of API protocols
 * (anthropic-messages, openai-completions, openai-responses, bedrock-converse,
 * google-*, mistral-conversations). The `cacheRetention` option Pi exposes maps
 * to very different on-the-wire mechanics depending on which protocol and
 * which concrete backend is used. This helper distils that matrix into a
 * shape both the UI and the controller's auto-mode heuristic can read off
 * the model's `provider` field — without needing to import the full Pi model
 * registry just to look up cache support.
 *
 * Used by:
 * - the webview to render an informative tooltip on the cache chip
 * - `_computeEffectiveCache` to bias toward `long` for providers where the
 *   write surcharge is zero (so `long` strictly dominates `short`).
 */

export type CacheFamily =
    /** Anthropic-style explicit cache_control markers; `long` = 1h with ~2× write cost. */
    | 'anthropic'
    /** OpenAI-style prompt_cache_key + prompt_cache_retention; `long` = 24h, writes effectively free. */
    | 'openai'
    /** Backend caches automatically by prefix; cacheRetention option is largely cosmetic, but writes are free. */
    | 'auto'
    /** Provider has no caching wired in Pi (or in the upstream API). The chip is informational. */
    | 'unsupported'
    /** Unknown/heterogeneous (e.g. OpenRouter — depends on the routed backend). */
    | 'mixed';

export interface CacheCapability {
    family: CacheFamily;
    /** Human label for the "short" retention's TTL (e.g. "5 min", "auto"). */
    shortLabel: string;
    /** Human label for the "long" retention's TTL (e.g. "1 h", "24 h", "n/a"). */
    longLabel: string;
    /** True when cache writes carry no surcharge — `long` is then always at least as cheap as `short`. */
    writeFree: boolean;
    /** True when the chip currently has a real on-the-wire effect for this provider. */
    chipActive: boolean;
    /** Short note shown in the tooltip. */
    note: string;
}

const ANTHROPIC_PROVIDERS = new Set([
    'anthropic',
    'kimi-coding', // api.kimi.com/coding speaks anthropic-messages
]);

const OPENAI_PROVIDERS = new Set([
    'openai',
    'azure-openai-responses',
    'openai-codex',
]);

// Backends that auto-cache by prefix on their own; sending Pi's prompt_cache_*
// fields is harmless but rarely changes behaviour. Writes are typically free.
const AUTO_CACHE_PROVIDERS = new Set([
    'deepseek',
    'zai',
    'cerebras',
    'opencode',
    'opencode-go',
    'kimi-coding-zen', // hypothetical; opencode-zen lives under opencode
    'minimax',
    'minimax-cn',
    'google-antigravity',
]);

// Routed/aggregator backends — caching depends on the resolved upstream.
const MIXED_PROVIDERS = new Set([
    'openrouter',
    'vercel-ai-gateway',
    'huggingface',
    'fireworks',
    'github-copilot',
]);

const UNSUPPORTED_PROVIDERS = new Set([
    'mistral',
    'google',
    'google-vertex',
    'google-gemini-cli',
    'groq', // no prompt cache
    'xai',
]);

export function getCacheCapability(provider: string | undefined, modelId?: string): CacheCapability {
    if (!provider) {
        return {
            family: 'mixed',
            shortLabel: 'auto',
            longLabel: 'n/a',
            writeFree: false,
            chipActive: false,
            note: 'No model selected.',
        };
    }

    // Bedrock is split: Claude models go through the Anthropic cache_point path;
    // everything else (Llama, Qwen, Mistral on Bedrock) gets no cache markers.
    if (provider === 'amazon-bedrock') {
        const isClaude = !!modelId && modelId.toLowerCase().includes('claude');
        return isClaude
            ? {
                family: 'anthropic',
                shortLabel: '5 min',
                longLabel: '1 h',
                writeFree: false,
                chipActive: true,
                note: 'Bedrock + Claude: explicit cachePoint blocks. Long extends TTL to 1 h with a write surcharge.',
            }
            : {
                family: 'unsupported',
                shortLabel: 'n/a',
                longLabel: 'n/a',
                writeFree: false,
                chipActive: false,
                note: 'Bedrock non-Claude models do not get cache points from Pi.',
            };
    }

    if (ANTHROPIC_PROVIDERS.has(provider)) {
        return {
            family: 'anthropic',
            shortLabel: '5 min',
            longLabel: '1 h',
            writeFree: false,
            chipActive: true,
            note: 'Explicit cache_control markers. Long TTL = 1 h with ~2× write cost; short writes are ~1.25×.',
        };
    }

    if (OPENAI_PROVIDERS.has(provider)) {
        return {
            family: 'openai',
            shortLabel: '5 min',
            longLabel: '24 h',
            writeFree: true,
            chipActive: true,
            note: 'OpenAI-style prompt_cache_key + retention. Writes are free, so long is always at least as cheap as short.',
        };
    }

    if (AUTO_CACHE_PROVIDERS.has(provider)) {
        return {
            family: 'auto',
            shortLabel: 'auto',
            longLabel: 'auto',
            writeFree: true,
            chipActive: false,
            note: 'Provider auto-caches by prefix; the chip is informational. Cache hits are still reported in usage.',
        };
    }

    if (MIXED_PROVIDERS.has(provider)) {
        return {
            family: 'mixed',
            shortLabel: 'depends',
            longLabel: 'depends',
            writeFree: false,
            chipActive: true,
            note: 'Effective caching depends on the routed upstream provider.',
        };
    }

    if (UNSUPPORTED_PROVIDERS.has(provider)) {
        return {
            family: 'unsupported',
            shortLabel: 'n/a',
            longLabel: 'n/a',
            writeFree: false,
            chipActive: false,
            note: 'Pi does not wire prompt cache control for this provider.',
        };
    }

    // Unknown provider — assume mixed/best-effort.
    return {
        family: 'mixed',
        shortLabel: 'auto',
        longLabel: 'depends',
        writeFree: false,
        chipActive: true,
        note: `Unrecognised provider "${provider}"; cache behaviour depends on upstream.`,
    };
}
