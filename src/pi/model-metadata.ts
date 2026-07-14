import type { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { extractCodexAccountId } from './codex-auth';

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
// GPT-5.6 requires Codex client 0.144.0 or newer. This value is used only to
// select compatible server catalog entries; Pi Code does not emulate Codex CLI.
const CODEX_MODELS_CLIENT_VERSION = '0.144.0';
const GPT_56_MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;

export type ModelMetadataLog = (message: string) => void;

type CodexCatalogModel = {
    slug: string;
    contextWindow: number;
    maxContextWindow?: number;
    effectiveContextWindowPercent?: number;
};

type ContextWindowOverride = {
    provider: string;
    modelIds: readonly string[];
    upstreamValue: number;
    correctedValue: number;
};

/**
 * The OpenAI Models API does not currently return context-window metadata.
 * Use the published direct-API limit while still allowing newer SDK metadata
 * and explicit values that differ from the known conservative default.
 */
const DOCUMENTED_API_OVERRIDES: readonly ContextWindowOverride[] = [
    {
        provider: 'openai',
        modelIds: GPT_56_MODEL_IDS,
        upstreamValue: 272_000,
        correctedValue: 1_050_000,
    },
];

const CODEX_CATALOG_CACHE_MS = 60_000;
const catalogRequests = new Map<string, Promise<CodexCatalogModel[]>>();
const catalogCache = new Map<string, { models: CodexCatalogModel[]; capturedAt: number }>();

/**
 * Refresh account-specific Codex context windows and direct-API fallbacks.
 * Codex failures are non-fatal: the bundled Pi catalog remains available.
 */
export async function refreshModelMetadata(
    registry: Pick<ModelRegistry, 'getAll'>,
    authStorage: Pick<AuthStorage, 'getApiKey'>,
    log?: ModelMetadataLog,
    fetchImpl: typeof fetch = fetch,
): Promise<number> {
    let corrected = applyDocumentedApiMetadata(registry);
    const accessToken = await authStorage.getApiKey('openai-codex', { includeFallback: false });
    if (!accessToken) return corrected;

    let accountId: string;
    try {
        accountId = extractCodexAccountId(accessToken);
    } catch (error) {
        log?.(`Codex model metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return corrected;
    }

    try {
        const cachedCatalog = catalogCache.get(accountId);
        let catalog: CodexCatalogModel[];
        if (cachedCatalog && Date.now() - cachedCatalog.capturedAt <= CODEX_CATALOG_CACHE_MS) {
            catalog = cachedCatalog.models;
        } else {
            let request = catalogRequests.get(accountId);
            if (!request) {
                request = fetchCodexCatalog(accessToken, accountId, fetchImpl);
                catalogRequests.set(accountId, request);
                void request.finally(() => {
                    if (catalogRequests.get(accountId) === request) catalogRequests.delete(accountId);
                }).catch(() => undefined);
            }
            catalog = await request;
            catalogCache.set(accountId, { models: catalog, capturedAt: Date.now() });
        }
        const updated = applyCodexCatalogMetadata(registry, catalog);
        corrected += updated;
        const gpt56 = catalog.find((model) => GPT_56_MODEL_IDS.includes(model.slug as typeof GPT_56_MODEL_IDS[number]));
        if (gpt56) {
            const effective = gpt56.effectiveContextWindowPercent;
            log?.(
                `Codex model catalog: GPT-5.6 context ${gpt56.contextWindow.toLocaleString()} tokens`
                + (effective !== undefined ? ` (${effective}% effective)` : ''),
            );
        }
    } catch (error) {
        log?.(`Codex model metadata refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return corrected;
}

/** Apply the documented direct OpenAI API limits in-place. */
export function applyDocumentedApiMetadata(
    registry: Pick<ModelRegistry, 'getAll'>,
): number {
    let corrected = 0;
    for (const model of registry.getAll()) {
        const override = DOCUMENTED_API_OVERRIDES.find(candidate =>
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

/** Apply context windows returned by the authenticated Codex catalog. */
export function applyCodexCatalogMetadata(
    registry: Pick<ModelRegistry, 'getAll'>,
    catalog: readonly CodexCatalogModel[],
): number {
    const bySlug = new Map(catalog.map((model) => [model.slug, model]));
    let corrected = 0;
    for (const model of registry.getAll()) {
        if (model.provider !== 'openai-codex') continue;
        const remote = bySlug.get(model.id);
        if (!remote || model.contextWindow === remote.contextWindow) continue;
        model.contextWindow = remote.contextWindow;
        corrected += 1;
    }
    return corrected;
}

/** Parse only catalog fields that affect context accounting. */
export function parseCodexModelCatalog(payload: unknown): CodexCatalogModel[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Codex models response is not an object');
    }
    const models = (payload as Record<string, unknown>).models;
    if (!Array.isArray(models)) throw new Error('Codex models response has no model list');

    const parsed: CodexCatalogModel[] = [];
    for (const value of models) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
        const contextWindow = positiveInteger(entry.context_window)
            ?? positiveInteger(entry.max_context_window);
        if (!slug || contextWindow === undefined) continue;
        parsed.push({
            slug,
            contextWindow,
            maxContextWindow: positiveInteger(entry.max_context_window),
            effectiveContextWindowPercent: positiveInteger(entry.effective_context_window_percent),
        });
    }
    if (parsed.length === 0) throw new Error('Codex models response has no context metadata');
    return parsed;
}

async function fetchCodexCatalog(
    accessToken: string,
    accountId: string,
    fetchImpl: typeof fetch,
): Promise<CodexCatalogModel[]> {
    const url = new URL(CODEX_MODELS_URL);
    url.searchParams.set('client_version', CODEX_MODELS_CLIENT_VERSION);
    const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'chatgpt-account-id': accountId,
            accept: 'application/json',
            originator: 'pi',
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return parseCodexModelCatalog(await response.json());
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined;
}
