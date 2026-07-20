import type { StateStore } from '../core/ports/chat-platform';
import type { CodexUsageSnapshot } from '../shared/protocol';
import { CODEX_USAGE_STALE_MS, normalizeCodexLimitId } from '../shared/codex-usage';
import { getAuthStorage } from './auth';
import { parseCodexHeaders, parseCodexUsagePayload } from './codex-usage-parser';
import { extractCodexAccountId } from './codex-auth';

const PERSIST_KEY = 'pi-code.codexUsage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export type CodexUsageListener = (snapshot: CodexUsageSnapshot | null) => void;

/**
 * Holds account-global Codex subscription usage. Refreshes are explicitly
 * triggered when a chat opens and after a turn; there is intentionally no
 * polling timer.
 */
class CodexUsageStore {
    private _snapshot: CodexUsageSnapshot | null = null;
    private _memento: StateStore | undefined;
    private _listeners = new Set<CodexUsageListener>();
    private _refreshPromise: Promise<CodexUsageSnapshot | null> | undefined;

    init(memento: StateStore): void {
        this._memento = memento;
        const persisted = memento.get<CodexUsageSnapshot>(PERSIST_KEY);
        if (isPersistedSnapshotUsable(persisted)) {
            this._snapshot = persisted;
        } else if (persisted) {
            void memento.update(PERSIST_KEY, undefined);
        }
    }

    /** Merge opportunistic SSE response headers into the latest snapshot. */
    updateFromHeaders(headers: Record<string, string>): boolean {
        const update = parseCodexHeaders(headers);
        if (!update) return false;
        this._setSnapshot(mergeCodexUsageSnapshots(this._snapshot, update));
        return true;
    }

    /** Replace state with the authoritative account usage payload. */
    updateFromPayload(payload: unknown): CodexUsageSnapshot {
        const snapshot = parseCodexUsagePayload(payload);
        this._setSnapshot(snapshot);
        return snapshot;
    }

    /** Share concurrent open/turn-end refreshes instead of fanning out. */
    refresh(): Promise<CodexUsageSnapshot | null> {
        if (this._refreshPromise) return this._refreshPromise;
        const request = this._refreshFromApi();
        this._refreshPromise = request;
        void request.finally(() => {
            if (this._refreshPromise === request) this._refreshPromise = undefined;
        }).catch(() => undefined);
        return request;
    }

    getCurrent(): CodexUsageSnapshot | null {
        return this._snapshot;
    }

    onChange(listener: CodexUsageListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    clear(): void {
        const hadSnapshot = this._snapshot !== null;
        this._snapshot = null;
        void this._memento?.update(PERSIST_KEY, undefined);
        if (!hadSnapshot) return;
        for (const listener of this._listeners) {
            try { listener(null); } catch { /* Listener failures must not break auth/session flow. */ }
        }
    }

    private async _refreshFromApi(): Promise<CodexUsageSnapshot | null> {
        const authStorage = await getAuthStorage();
        const accessToken = await authStorage.getApiKey('openai-codex', { includeFallback: false });
        if (!accessToken) {
            this.clear();
            return null;
        }

        const response = await fetch(CODEX_USAGE_URL, {
            method: 'GET',
            headers: {
                authorization: `Bearer ${accessToken}`,
                'chatgpt-account-id': extractCodexAccountId(accessToken),
                accept: 'application/json',
                originator: 'pi',
            },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) this.clear();
            throw new Error(`Codex usage refresh failed with HTTP ${response.status}`);
        }
        return this.updateFromPayload(await response.json());
    }

    private _setSnapshot(snapshot: CodexUsageSnapshot): void {
        this._snapshot = snapshot;
        void this._memento?.update(PERSIST_KEY, snapshot);
        for (const listener of this._listeners) {
            try { listener(snapshot); } catch { /* Listener failures must not break provider flow. */ }
        }
    }
}

const instance = new CodexUsageStore();

export function getCodexUsageStore(): CodexUsageStore {
    return instance;
}

function mergeCodexUsageSnapshots(
    current: CodexUsageSnapshot | null,
    update: CodexUsageSnapshot,
): CodexUsageSnapshot {
    if (!current) return update;
    const byId = new Map(current.buckets.map((bucket) => [normalizeCodexLimitId(bucket.limitId), bucket]));
    for (const bucket of update.buckets) {
        const key = normalizeCodexLimitId(bucket.limitId);
        const previous = byId.get(key);
        byId.set(key, previous ? {
            ...previous,
            ...bucket,
            primary: bucket.primary ?? previous.primary,
            secondary: bucket.secondary ?? previous.secondary,
        } : bucket);
    }
    return {
        ...current,
        ...update,
        planType: update.planType ?? current.planType,
        activeLimit: update.activeLimit ?? current.activeLimit,
        buckets: [...byId.values()],
        credits: update.credits ?? current.credits,
        individualLimit: update.individualLimit ?? current.individualLimit,
        rateLimitReachedType: update.rateLimitReachedType ?? current.rateLimitReachedType,
        resetCreditsAvailable: update.resetCreditsAvailable ?? current.resetCreditsAvailable,
    };
}

function isPersistedSnapshotUsable(value: unknown): value is CodexUsageSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const snapshot = value as Partial<CodexUsageSnapshot>;
    return Array.isArray(snapshot.buckets)
        && typeof snapshot.capturedAt === 'number'
        && Number.isFinite(snapshot.capturedAt)
        && Date.now() - snapshot.capturedAt <= CODEX_USAGE_STALE_MS;
}
