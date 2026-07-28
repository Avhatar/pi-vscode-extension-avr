import type { StateStore } from '../core/ports/chat-platform';

/**
 * Persistent, cross-reload cache for the Codex model catalog. The catalog
 * (context windows, effective %) is fetched from
 * `https://chatgpt.com/backend-api/codex/models` and, without persistence,
 * every new chat tab paid ~300-1300 ms of network latency waiting on that
 * endpoint. Persisting the catalog to global storage (keyed by ChatGPT
 * account ID) lets subsequent starts apply the last-known catalog
 * immediately while a background refresh runs.
 */

const STORE_KEY = 'pi-code.codexCatalog';

export interface CachedCatalogModel {
    slug: string;
    contextWindow: number;
    maxContextWindow?: number;
    effectiveContextWindowPercent?: number;
}

export interface CachedCatalogEntry {
    models: CachedCatalogModel[];
    capturedAt: number;
}

let store: StateStore | undefined;
let inMemory: Record<string, CachedCatalogEntry> = {};

/**
 * Wire the cache to the extension's global storage. Called once at activation.
 * When called without a `StateStore` (e.g. from unit tests), the cache still
 * works but does not persist across restarts.
 */
export function initCodexCatalogCache(memento: StateStore): void {
    store = memento;
    const persisted = memento.get<Record<string, CachedCatalogEntry>>(STORE_KEY);
    if (persisted && typeof persisted === 'object') {
        const restored: Record<string, CachedCatalogEntry> = {};
        for (const [accountId, entry] of Object.entries(persisted)) {
            if (isValidEntry(entry)) restored[accountId] = entry;
        }
        inMemory = restored;
    }
}

export function getCachedCodexCatalog(accountId: string): CachedCatalogEntry | undefined {
    return inMemory[accountId];
}

export function setCachedCodexCatalog(accountId: string, models: CachedCatalogModel[]): void {
    inMemory[accountId] = { models, capturedAt: Date.now() };
    if (store) void store.update(STORE_KEY, inMemory);
}

/** Test-only. Resets both memory and any persisted state. */
export function _resetCodexCatalogCacheForTests(): void {
    inMemory = {};
    if (store) void store.update(STORE_KEY, undefined);
    store = undefined;
}

function isValidEntry(value: unknown): value is CachedCatalogEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<CachedCatalogEntry>;
    return Array.isArray(entry.models)
        && typeof entry.capturedAt === 'number'
        && entry.capturedAt > 0;
}
