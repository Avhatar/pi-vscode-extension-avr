import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

const DASHSCOPE_INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DASHSCOPE_CN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

type QwenModel = {
    id: string;
    name: string;
    reasoning: boolean;
    input: ('text' | 'image')[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    compat?: any;
};

const ZERO_CACHE = { cacheRead: 0, cacheWrite: 0 } as const;

// DashScope's OpenAI-compatible endpoint diverges from OpenAI's chat-completions API
// in three ways that the Pi SDK auto-detect path does not catch for an unknown
// `provider === 'qwen'`/`qwen-cn`:
//   - `role: 'developer'` (the OpenAI Responses-API replacement for `system` on
//     reasoning models) is rejected with `400 'developer' is not one of
//     ['system','assistant','user','tool','function']`. The Pi SDK switches to
//     `developer` whenever `model.reasoning` is true and `supportsDeveloperRole`
//     is not explicitly false, so without this flag every Qwen3.6/3.5/QwQ turn
//     fails the moment a system prompt is attached.
//   - The OpenAI-only `store: false` parameter and `prompt_cache_key` /
//     `prompt_cache_retention` fields confuse DashScope; explicitly opt out.
const QWEN_COMPAT_BASE = {
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsLongCacheRetention: false,
} as const;
const QWEN_THINKING_COMPAT = { ...QWEN_COMPAT_BASE, thinkingFormat: 'qwen' } as const;

// IDs map directly to DashScope model IDs. Aliases without a date suffix
// (e.g. `qwen3-max`) resolve to whatever DashScope marks as the latest stable
// snapshot. Suffixed IDs (e.g. `qwen3.6-max-preview`, `qwen3-max-2026-01-23`)
// pin to a specific snapshot. Both work via the OpenAI-compatible endpoint.
const QWEN_MODELS: QwenModel[] = [
    // ── Qwen3.6 series (vision-language flagship) ──
    {
        id: 'qwen3.6-max-preview',
        name: 'Qwen3.6 Max Preview',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.2, output: 6.0, ...ZERO_CACHE },
        contextWindow: 262_144,
        maxTokens: 32_768,
        compat: QWEN_THINKING_COMPAT,
    },
    {
        id: 'qwen3.6-max',
        name: 'Qwen3.6 Max (latest)',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 1.2, output: 6.0, ...ZERO_CACHE },
        contextWindow: 262_144,
        maxTokens: 32_768,
        compat: QWEN_THINKING_COMPAT,
    },
    {
        id: 'qwen3.6-plus',
        name: 'Qwen3.6 Plus (latest)',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.4, output: 1.2, ...ZERO_CACHE },
        contextWindow: 131_072,
        maxTokens: 16_384,
        compat: QWEN_THINKING_COMPAT,
    },

    // ── Qwen3.5 series ──
    {
        id: 'qwen3.5-plus',
        name: 'Qwen3.5 Plus (latest)',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0.4, output: 1.2, ...ZERO_CACHE },
        contextWindow: 131_072,
        maxTokens: 16_384,
        compat: QWEN_THINKING_COMPAT,
    },

    // ── Qwen3 stable flagship ──
    {
        id: 'qwen3-max',
        name: 'Qwen3 Max (latest)',
        reasoning: false,
        input: ['text'],
        cost: { input: 1.2, output: 6.0, ...ZERO_CACHE },
        contextWindow: 262_144,
        maxTokens: 32_768,
        compat: QWEN_COMPAT_BASE,
    },

    // ── Coding ──
    {
        id: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus (latest)',
        reasoning: false,
        input: ['text'],
        cost: { input: 1.0, output: 5.0, ...ZERO_CACHE },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        compat: QWEN_COMPAT_BASE,
    },
    {
        id: 'qwen3-coder-flash',
        name: 'Qwen3 Coder Flash',
        reasoning: false,
        input: ['text'],
        cost: { input: 0.3, output: 1.5, ...ZERO_CACHE },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        compat: QWEN_COMPAT_BASE,
    },

    // ── General workhorses ──
    {
        id: 'qwen-plus',
        name: 'Qwen Plus (latest)',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.4, output: 1.2, ...ZERO_CACHE },
        contextWindow: 131_072,
        maxTokens: 16_384,
        compat: QWEN_THINKING_COMPAT,
    },
    {
        id: 'qwen-turbo',
        name: 'Qwen Turbo (latest)',
        reasoning: false,
        input: ['text'],
        cost: { input: 0.05, output: 0.2, ...ZERO_CACHE },
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        compat: QWEN_COMPAT_BASE,
    },

    // ── Reasoning specialist ──
    {
        id: 'qwq-plus',
        name: 'QwQ Plus (reasoning)',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.5, output: 1.5, ...ZERO_CACHE },
        contextWindow: 131_072,
        maxTokens: 16_384,
        compat: QWEN_THINKING_COMPAT,
    },

    // ── Pure vision (legacy 2.x VL line, still useful) ──
    {
        id: 'qwen-vl-max',
        name: 'Qwen VL Max',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 1.2, output: 4.8, ...ZERO_CACHE },
        contextWindow: 32_768,
        maxTokens: 8_192,
        compat: QWEN_COMPAT_BASE,
    },
    {
        id: 'qwen3-vl-plus',
        name: 'Qwen3 VL Plus',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0.21, output: 0.63, ...ZERO_CACHE },
        contextWindow: 131_072,
        maxTokens: 8_192,
        compat: QWEN_COMPAT_BASE,
    },
];

// Placeholder satisfies pi-coding-agent's `apiKey OR oauth required` validation in
// `registerProvider`. The actual key comes from ModelRuntime's runtime override,
// which takes precedence over this provider fallback. This placeholder is never
// sent to DashScope because registration only happens after Pi Code applies a real
// SecretStorage key (see `syncCustomProviders` in ../models.ts).
const REGISTRATION_APIKEY_PLACEHOLDER = 'managed-by-pi-code-vscode';

export function registerQwenProvider(runtime: ModelRuntime, baseUrl?: string): void {
    runtime.registerProvider('qwen', {
        api: 'openai-completions',
        baseUrl: baseUrl || DASHSCOPE_INTL_BASE_URL,
        apiKey: REGISTRATION_APIKEY_PLACEHOLDER,
        models: QWEN_MODELS,
    });
}

export function registerQwenCnProvider(runtime: ModelRuntime, baseUrl?: string): void {
    runtime.registerProvider('qwen-cn', {
        api: 'openai-completions',
        baseUrl: baseUrl || DASHSCOPE_CN_BASE_URL,
        apiKey: REGISTRATION_APIKEY_PLACEHOLDER,
        models: QWEN_MODELS.map((m) => ({ ...m })),
    });
}
