import type { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { extractCodexAccountId } from './codex-auth';
import {
    getCachedCodexCatalog,
    setCachedCodexCatalog,
} from './codex-catalog-cache';

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

/**
 * The Codex model catalog changes rarely (new frontier model releases). A
 * 24-hour freshness window is comfortably below the frequency of upstream
 * changes but keeps the extension responsive for the whole workday. Stale
 * entries (older than this) are still applied immediately from the persistent
 * cache while a background refresh runs — see `refreshModelMetadata` below.
 */
const CODEX_CATALOG_FRESH_TTL_MS = 24 * 60 * 60_000;
const catalogRequests = new Map<string, Promise<CodexCatalogModel[]>>();

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
        const cachedCatalog = getCachedCodexCatalog(accountId);
        const isFresh = cachedCatalog
            ? Date.now() - cachedCatalog.capturedAt <= CODEX_CATALOG_FRESH_TTL_MS
            : false;

        let catalog: CodexCatalogModel[];
        if (cachedCatalog && isFresh) {
            catalog = cachedCatalog.models;
        } else if (cachedCatalog) {
            // Stale cache: apply the last-known catalog immediately so the
            // caller does not block on the network, then refresh in the
            // background. The refreshed catalog is mutated onto the shared
            // registry when it arrives, so future reads see updated numbers.
            catalog = cachedCatalog.models;
            void refreshCodexCatalogInBackground(registry, accountId, accessToken, log, fetchImpl);
        } else {
            // No cached entry — must wait once. Subsequent starts read from
            // the persistent cache instead.
            catalog = await fetchAndCacheCodexCatalog(accountId, accessToken, fetchImpl);
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

/**
 * Shared network entry point: coalesces concurrent callers behind one
 * outstanding request per account, then updates the persistent cache on
 * success. The in-flight `Map` keeps a single fetch alive when multiple
 * tabs open before the first one settles.
 */
async function fetchAndCacheCodexCatalog(
    accountId: string,
    accessToken: string,
    fetchImpl: typeof fetch,
): Promise<CodexCatalogModel[]> {
    let request = catalogRequests.get(accountId);
    if (!request) {
        request = fetchCodexCatalog(accessToken, accountId, fetchImpl);
        catalogRequests.set(accountId, request);
        void request.finally(() => {
            if (catalogRequests.get(accountId) === request) catalogRequests.delete(accountId);
        }).catch(() => undefined);
    }
    const catalog = await request;
    setCachedCodexCatalog(accountId, catalog);
    return catalog;
}

/**
 * Fire-and-forget refresh for the stale-while-revalidate path. Errors are
 * swallowed (only logged) so a transient upstream failure never bubbles up
 * to the caller that already returned with stale data.
 */
async function refreshCodexCatalogInBackground(
    registry: Pick<ModelRegistry, 'getAll'>,
    accountId: string,
    accessToken: string,
    log: ModelMetadataLog | undefined,
    fetchImpl: typeof fetch,
): Promise<void> {
    try {
        const catalog = await fetchAndCacheCodexCatalog(accountId, accessToken, fetchImpl);
        applyCodexCatalogMetadata(registry, catalog);
    } catch (error) {
        log?.(`Codex catalog background refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
