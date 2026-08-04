import { createHash } from 'node:crypto';
import type { StateStore } from '../core/ports/chat-platform';
import type { DeepSeekUsageSnapshot } from '../shared/agent-protocol';
import { parseDeepSeekBalancePayload } from '../shared/deepseek-usage';
import { getProviderAccessToken } from './auth';

const PERSIST_KEY = 'pi-code.deepSeekUsage';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

interface DeepSeekDailyLedger {
    date: string;
    keyFingerprint: string;
    cost: number;
}

interface PersistedDeepSeekUsage {
    ledgers: DeepSeekDailyLedger[];
}

export interface DeepSeekUsageStoreOptions {
    getAccessToken?: () => Promise<string | undefined>;
    fetch?: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
    now?: () => number;
}

export type DeepSeekUsageListener = (snapshot: DeepSeekUsageSnapshot | null) => void;

/** Account-global DeepSeek balance plus locally attributable daily Pi Code spend. */
export class DeepSeekUsageStore {
    private readonly _getAccessToken: () => Promise<string | undefined>;
    private readonly _fetch: NonNullable<DeepSeekUsageStoreOptions['fetch']>;
    private readonly _now: () => number;
    private _memento: StateStore | undefined;
    private _snapshot: DeepSeekUsageSnapshot | null = null;
    private _snapshotFingerprint: string | undefined;
    private _activeFingerprint: string | undefined;
    private _ledgers: DeepSeekDailyLedger[] = [];
    private _listeners = new Set<DeepSeekUsageListener>();
    private _refreshPromise: Promise<DeepSeekUsageSnapshot | null> | undefined;
    private _generation = 0;

    constructor(options: DeepSeekUsageStoreOptions = {}) {
        this._getAccessToken = options.getAccessToken ?? (() => getProviderAccessToken('deepseek'));
        this._fetch = options.fetch ?? ((url, init) => fetch(url, init));
        this._now = options.now ?? Date.now;
    }

    init(memento: StateStore): void {
        this._memento = memento;
        const persisted = memento.get<PersistedDeepSeekUsage>(PERSIST_KEY);
        if (isPersistedUsage(persisted)) {
            this._ledgers = persisted.ledgers;
        } else if (persisted) {
            void memento.update(PERSIST_KEY, undefined);
        }
    }

    getCurrent(): DeepSeekUsageSnapshot | null {
        return this._snapshot;
    }

    getActiveFingerprint(): string | undefined {
        return this._activeFingerprint;
    }

    onChange(listener: DeepSeekUsageListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    refresh(): Promise<DeepSeekUsageSnapshot | null> {
        if (this._refreshPromise) return this._refreshPromise;
        const generation = this._generation;
        const request = this._refreshFromApi(generation);
        this._refreshPromise = request;
        void request.finally(() => {
            if (this._refreshPromise === request) this._refreshPromise = undefined;
        }).catch(() => undefined);
        return request;
    }

    async recordTurnCost(cost: number, expectedFingerprint?: string): Promise<boolean> {
        if (!Number.isFinite(cost) || cost <= 0) return false;
        const token = await this._getAccessToken();
        if (!token) return false;
        const fingerprint = fingerprintToken(token);
        if (expectedFingerprint && expectedFingerprint !== fingerprint) return false;
        this._activeFingerprint = fingerprint;
        const ledger = this._ensureLedger(fingerprint);
        ledger.cost = normalizeCost(ledger.cost + cost);
        await this._persistLedgers();
        if (this._snapshot && this._snapshotFingerprint === fingerprint) {
            this._setSnapshot({
                ...this._snapshot,
                todayCost: ledger.cost,
                todayDate: ledger.date,
            }, fingerprint);
        }
        return true;
    }

    clear(): void {
        const hadSnapshot = this._snapshot !== null;
        this._generation++;
        this._refreshPromise = undefined;
        this._snapshot = null;
        this._snapshotFingerprint = undefined;
        this._activeFingerprint = undefined;
        if (hadSnapshot) this._notify(null);
    }

    private async _refreshFromApi(generation: number): Promise<DeepSeekUsageSnapshot | null> {
        const accessToken = await this._getAccessToken();
        if (generation !== this._generation) return null;
        if (!accessToken) {
            this.clear();
            return null;
        }
        const fingerprint = fingerprintToken(accessToken);
        const ledger = this._ensureLedger(fingerprint);
        await this._persistLedgers();
        let response: Pick<Response, 'ok' | 'status' | 'json'>;
        try {
            response = await this._fetch(DEEPSEEK_BALANCE_URL, {
                method: 'GET',
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/json',
                },
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            if (generation !== this._generation) return null;
            throw error;
        }
        if (generation !== this._generation) return null;
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) this.clear();
            throw new Error(`DeepSeek balance refresh failed with HTTP ${response.status}`);
        }
        const now = this._now();
        const snapshot = parseDeepSeekBalancePayload(
            await response.json(),
            now,
            ledger.cost,
            ledger.date,
        );
        if (generation !== this._generation) return null;
        this._activeFingerprint = fingerprint;
        this._setSnapshot(snapshot, fingerprint);
        return snapshot;
    }

    private _ensureLedger(keyFingerprint: string): DeepSeekDailyLedger {
        const date = localDateKey(this._now());
        this._ledgers = this._ledgers.filter((ledger) => ledger.date === date);
        let ledger = this._ledgers.find((candidate) => candidate.keyFingerprint === keyFingerprint);
        if (!ledger) {
            ledger = { date, keyFingerprint, cost: 0 };
            this._ledgers.push(ledger);
        }
        return ledger;
    }

    private async _persistLedgers(): Promise<void> {
        await this._memento?.update(PERSIST_KEY, { ledgers: this._ledgers });
    }

    private _setSnapshot(snapshot: DeepSeekUsageSnapshot, fingerprint: string): void {
        this._snapshot = snapshot;
        this._snapshotFingerprint = fingerprint;
        this._notify(snapshot);
    }

    private _notify(snapshot: DeepSeekUsageSnapshot | null): void {
        for (const listener of this._listeners) {
            try { listener(snapshot); } catch { /* Listener failures must not break auth/session flow. */ }
        }
    }
}

const instance = new DeepSeekUsageStore();

export function getDeepSeekUsageStore(): DeepSeekUsageStore {
    return instance;
}

function localDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function fingerprintToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function isPersistedUsage(value: unknown): value is PersistedDeepSeekUsage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const persisted = value as Partial<PersistedDeepSeekUsage>;
    return Array.isArray(persisted.ledgers) && persisted.ledgers.every(isPersistedLedger);
}

function isPersistedLedger(value: unknown): value is DeepSeekDailyLedger {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const ledger = value as Partial<DeepSeekDailyLedger>;
    return typeof ledger.date === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(ledger.date)
        && typeof ledger.keyFingerprint === 'string'
        && ledger.keyFingerprint.length > 0
        && typeof ledger.cost === 'number'
        && Number.isFinite(ledger.cost)
        && ledger.cost >= 0;
}

function normalizeCost(value: number): number {
    return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
