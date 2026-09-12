import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { extractCodexAccountId } from './codex-auth';
import {
    getCachedCodexCatalog,
    setCachedCodexCatalog,
} from './codex-catalog-cache';

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
// GPT-6 Astra declares `minimal_client_version: 0.153.0`, so any lower value
// hides it from the response entirely and the account catalog silently stops
// correcting it — it then keeps the bundled 272K window. Verified against the
// live endpoint: 0.144.0 returns seven models without Astra, 0.153.0 and newer
// return eight with identical metadata for the others. This value is used only
// to select compatible server catalog entries; Pi Code does not emulate Codex CLI.
const CODEX_MODELS_CLIENT_VERSION = '0.153.0';
const GPT_54_MODEL_IDS = ['gpt-5.4', 'gpt-5.5'] as const;
const GPT_56_MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
const GPT_6_MODEL_IDS = ['gpt-6-astra'] as const;

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

type CodexCostRates = {
    input: number;
    output: number;
    cacheRead: number;
};

type CodexLongContextExemption = {
    modelId: string;
    baseCost: CodexCostRates;
    longContextCost: CodexCostRates;
};

/** The mutable slice of a runtime model's cost table this module rewrites. */
type MutableModelCost = CodexCostRates & {
    cacheWrite: number;
    tiers?: (CodexCostRates & { inputTokensAbove: number; cacheWrite: number })[];
};

/**
 * The OpenAI Models API does not currently return context-window metadata.
 * Use the published direct-API limit while still allowing newer SDK metadata
 * and explicit values that differ from the known conservative default.
 *
 * Only the direct `openai` provider is corrected here. The bundled
 * `openai-codex` catalog lists every model at the same conservative 272K, but
 * those windows are plan-specific and are refreshed from the authenticated
 * Codex catalog by `applyCodexCatalogMetadata`, so hardcoding a documented
 * value for them would overwrite account truth with a guess.
 */
const DOCUMENTED_API_OVERRIDES: readonly ContextWindowOverride[] = [
    {
        provider: 'openai',
        modelIds: GPT_54_MODEL_IDS,
        upstreamValue: 272_000,
        correctedValue: 1_050_000,
    },
    {
        provider: 'openai',
        modelIds: GPT_56_MODEL_IDS,
        upstreamValue: 272_000,
        correctedValue: 1_050_000,
    },
    {
        provider: 'openai',
        modelIds: GPT_6_MODEL_IDS,
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
    runtime: Pick<ModelRuntime, 'getModels' | 'getAuth'>,
    log?: ModelMetadataLog,
    fetchImpl: typeof fetch = fetch,
): Promise<number> {
    let corrected = applyDocumentedApiMetadata(runtime);
    corrected += applyCodexLongContextExemptions(runtime);
    const accessToken = (await runtime.getAuth('openai-codex'))?.auth.apiKey;
    if (!accessToken) return corrected;

    let accountId: string;
    try {
        accountId = extractCodexAccountId(accessToken);
    } catch (error) {
        log?.(`Codex model metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return corrected;
    }

    try {
        // A catalog fetched for an older Codex client version is unusable rather
        // than merely stale: the entry list itself differs, so a version bump
        // waits for one fresh fetch instead of serving the previous shape.
        const cached = getCachedCodexCatalog(accountId);
        const cachedCatalog = cached?.clientVersion === CODEX_MODELS_CLIENT_VERSION
            ? cached
            : undefined;
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
            // runtime models when it arrives, so future reads see updated numbers.
            catalog = cachedCatalog.models;
            void refreshCodexCatalogInBackground(runtime, accountId, accessToken, log, fetchImpl);
        } else {
            // No cached entry — must wait once. Subsequent starts read from
            // the persistent cache instead.
            catalog = await fetchAndCacheCodexCatalog(accountId, accessToken, fetchImpl);
        }

        const updated = applyCodexCatalogMetadata(runtime, catalog);
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
    setCachedCodexCatalog(accountId, catalog, CODEX_MODELS_CLIENT_VERSION);
    return catalog;
}

/**
 * Fire-and-forget refresh for the stale-while-revalidate path. Errors are
 * swallowed (only logged) so a transient upstream failure never bubbles up
 * to the caller that already returned with stale data.
 */
async function refreshCodexCatalogInBackground(
    runtime: Pick<ModelRuntime, 'getModels'>,
    accountId: string,
    accessToken: string,
    log: ModelMetadataLog | undefined,
    fetchImpl: typeof fetch,
): Promise<void> {
    try {
        const catalog = await fetchAndCacheCodexCatalog(accountId, accessToken, fetchImpl);
        applyCodexCatalogMetadata(runtime, catalog);
    } catch (error) {
        log?.(`Codex catalog background refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Apply the documented direct OpenAI API limits in-place. */
export function applyDocumentedApiMetadata(
    runtime: Pick<ModelRuntime, 'getModels'>,
): number {
    let corrected = 0;
    for (const model of runtime.getModels()) {
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

/**
 * Apply the context window the authenticated Codex catalog declares.
 *
 * `context_window` is the conservative window the account starts with and
 * `max_context_window` is the ceiling the same account may use: the upstream
 * Codex client reads the first by default and clamps an explicit
 * `model_context_window` to the second. Pi Code has no such opt-in, so it uses
 * the ceiling — that is what makes a large-context model usable at all, and the
 * footer marks the point where the pricier long-context tier begins.
 */
export function applyCodexCatalogMetadata(
    runtime: Pick<ModelRuntime, 'getModels'>,
    catalog: readonly CodexCatalogModel[],
): number {
    const bySlug = new Map(catalog.map((model) => [model.slug, model]));
    let corrected = 0;
    for (const model of runtime.getModels()) {
        if (model.provider !== 'openai-codex') continue;
        const remote = bySlug.get(model.id);
        if (!remote) continue;
        const contextWindow = remote.maxContextWindow !== undefined
            && remote.maxContextWindow > remote.contextWindow
            ? remote.maxContextWindow
            : remote.contextWindow;
        if (model.contextWindow === contextWindow) continue;
        model.contextWindow = contextWindow;
        corrected += 1;
    }
    return corrected;
}

/**
 * OpenAI's rate card carves GPT-6 Astra out of the long-context multiplier
 * inside Codex: "GPT-6 Astra usage in Codex does not incur additional
 * long-context multipliers above 272K input tokens", while the same model on
 * the direct API — and every other Codex model — still pays 2x input and 1.5x
 * output above that threshold. The bundled catalog expresses the multiplier as
 * a `cost.tiers` entry, so the exemption has to remove it: Pi Code would
 * otherwise overstate Astra's Codex cost and, worse, warn about a pricier
 * window Codex does not charge for.
 *
 * As in `DOCUMENTED_API_OVERRIDES`, a correction applies only to the exact
 * published figures — a catalog quoting anything else knows more than this
 * constant does, and rewriting its tier would replace fresher data with a guess.
 */
const CODEX_LONG_CONTEXT_EXEMPTIONS: readonly CodexLongContextExemption[] = [
    {
        modelId: 'gpt-6-astra',
        baseCost: { input: 10, cacheRead: 1, output: 50 },
        longContextCost: { input: 20, cacheRead: 2, output: 75 },
    },
];

/** The Codex long-context threshold the exempted tiers above are keyed on. */
const CODEX_LONG_CONTEXT_THRESHOLD = 272_000;

/** Remove the long-context tier OpenAI does not charge inside Codex. */
export function applyCodexLongContextExemptions(
    runtime: Pick<ModelRuntime, 'getModels'>,
): number {
    let corrected = 0;
    for (const model of runtime.getModels()) {
        if (model.provider !== 'openai-codex') continue;
        const exemption = CODEX_LONG_CONTEXT_EXEMPTIONS.find(candidate => candidate.modelId === model.id);
        if (!exemption) continue;
        const cost = model.cost as MutableModelCost | undefined;
        if (!cost || !isExemptLongContextCost(cost, exemption)) continue;
        cost.tiers = cost.tiers!.filter(tier => tier.inputTokensAbove !== CODEX_LONG_CONTEXT_THRESHOLD);
        corrected += 1;
    }
    return corrected;
}

function isExemptLongContextCost(cost: MutableModelCost, exemption: CodexLongContextExemption): boolean {
    if (cost.input !== exemption.baseCost.input
        || cost.output !== exemption.baseCost.output
        || cost.cacheRead !== exemption.baseCost.cacheRead) {
        return false;
    }
    return !!cost.tiers?.some(tier =>
        tier.inputTokensAbove === CODEX_LONG_CONTEXT_THRESHOLD
        && tier.input === exemption.longContextCost.input
        && tier.output === exemption.longContextCost.output
        && tier.cacheRead === exemption.longContextCost.cacheRead,
    );
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
