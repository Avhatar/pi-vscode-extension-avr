import * as vscode from 'vscode';
import type { CodexUsageSnapshot, CodexUsageWindow, CodexUsageCredits } from '../shared/protocol';

const PERSIST_KEY = 'pi-agent.codexUsage';

export type CodexUsageListener = (snapshot: CodexUsageSnapshot | null) => void;

/**
 * Singleton holding the latest Codex subscription-usage snapshot for the
 * signed-in account. The data is global to the user (not per chat), so all
 * webviews share one instance and persist between window reloads.
 */
class CodexUsageStore {
    private _snapshot: CodexUsageSnapshot | null = null;
    private _memento: vscode.Memento | undefined;
    private _listeners = new Set<CodexUsageListener>();

    init(memento: vscode.Memento): void {
        this._memento = memento;
        const persisted = memento.get<CodexUsageSnapshot>(PERSIST_KEY);
        if (persisted) {
            this._snapshot = persisted;
        }
    }

    /**
     * Update from a Codex provider response. Returns true if anything changed
     * (and listeners were notified). Returns false when headers don't carry
     * subscription metadata — for example when the user is on an OPENAI_API_KEY
     * (token-billed) flow rather than a ChatGPT subscription.
     */
    updateFromHeaders(headers: Record<string, string>): boolean {
        const snapshot = parseCodexHeaders(headers);
        if (!snapshot) return false;
        this._snapshot = snapshot;
        void this._memento?.update(PERSIST_KEY, snapshot);
        for (const listener of this._listeners) {
            try { listener(snapshot); } catch { /* swallow */ }
        }
        return true;
    }

    getCurrent(): CodexUsageSnapshot | null {
        return this._snapshot;
    }

    onChange(listener: CodexUsageListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    clear(): void {
        this._snapshot = null;
        void this._memento?.update(PERSIST_KEY, undefined);
        for (const listener of this._listeners) {
            try { listener(null); } catch { /* swallow */ }
        }
    }
}

const instance = new CodexUsageStore();

export function getCodexUsageStore(): CodexUsageStore {
    return instance;
}

function parseCodexHeaders(headers: Record<string, string>): CodexUsageSnapshot | null {
    const planType = headers['x-codex-plan-type'];
    if (!planType) return null;

    const primary = parseWindow(headers, 'primary');
    const secondary = parseWindow(headers, 'secondary');
    const credits = parseCredits(headers);

    return {
        planType,
        activeLimit: headers['x-codex-active-limit'] || undefined,
        primary,
        secondary,
        credits,
        capturedAt: Date.now(),
    };
}

function parseWindow(headers: Record<string, string>, kind: 'primary' | 'secondary'): CodexUsageWindow | undefined {
    const used = numberOrUndefined(headers[`x-codex-${kind}-used-percent`]);
    const window = numberOrUndefined(headers[`x-codex-${kind}-window-minutes`]);
    const resetAfter = numberOrUndefined(headers[`x-codex-${kind}-reset-after-seconds`]);
    const resetAt = numberOrUndefined(headers[`x-codex-${kind}-reset-at`]);
    if (used === undefined || window === undefined || resetAfter === undefined || resetAt === undefined) {
        return undefined;
    }
    return {
        percentUsed: used,
        windowMinutes: window,
        resetAfterSeconds: resetAfter,
        resetAt,
    };
}

function parseCredits(headers: Record<string, string>): CodexUsageCredits | undefined {
    const balanceRaw = headers['x-codex-credits-balance'];
    const hasCreditsRaw = headers['x-codex-credits-has-credits'];
    const unlimitedRaw = headers['x-codex-credits-unlimited'];
    if (balanceRaw === undefined && hasCreditsRaw === undefined && unlimitedRaw === undefined) {
        return undefined;
    }
    return {
        balance: balanceRaw && balanceRaw.length > 0 ? balanceRaw : undefined,
        hasCredits: parseBool(hasCreditsRaw),
        unlimited: parseBool(unlimitedRaw),
    };
}

function numberOrUndefined(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function parseBool(value: string | undefined): boolean {
    if (!value) return false;
    return value.toLowerCase() === 'true';
}
