import type {
    CodexSpendControlLimit,
    CodexUsageBucket,
    CodexUsageCredits,
    CodexUsageSnapshot,
    CodexUsageWindow,
} from '../shared/protocol';
import { normalizeCodexLimitId } from '../shared/codex-usage';

/** Parse the authoritative JSON returned by the ChatGPT /wham/usage endpoint. */
export function parseCodexUsagePayload(payload: unknown, capturedAt = Date.now()): CodexUsageSnapshot {
    const root = asRecord(payload);
    if (!root) throw new Error('Codex usage response is not an object');

    const planType = stringOrUndefined(root.plan_type);
    const buckets: CodexUsageBucket[] = [];
    const defaultRateLimit = asRecord(root.rate_limit);
    if (defaultRateLimit) {
        buckets.push(parsePayloadBucket('codex', undefined, defaultRateLimit));
    }

    const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
    for (const value of additional) {
        const entry = asRecord(value);
        if (!entry) continue;
        const limitId = stringOrUndefined(entry.metered_feature);
        if (!limitId) continue;
        buckets.push(parsePayloadBucket(
            normalizeCodexLimitId(limitId),
            stringOrUndefined(entry.limit_name),
            asRecord(entry.rate_limit),
        ));
    }

    const spendControl = asRecord(root.spend_control);
    const reached = asRecord(root.rate_limit_reached_type);
    const resetCredits = asRecord(root.rate_limit_reset_credits);
    return {
        planType,
        buckets,
        credits: parsePayloadCredits(root.credits),
        individualLimit: parseIndividualLimit(spendControl?.individual_limit),
        rateLimitReachedType: stringOrUndefined(reached?.type),
        resetCreditsAvailable: nonNegativeIntegerOrUndefined(resetCredits?.available_count),
        capturedAt,
    };
}

/** Parse both the legacy default headers and current prefixed limit families. */
export function parseCodexHeaders(
    headers: Record<string, string>,
    capturedAt = Date.now(),
): CodexUsageSnapshot | null {
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        normalizedHeaders[key.toLowerCase()] = value;
    }

    const prefixes = new Set<string>();
    for (const name of Object.keys(normalizedHeaders)) {
        const match = /^x-(.+)-primary-used-percent$/.exec(name);
        if (match?.[1]?.startsWith('codex')) prefixes.add(match[1]);
    }
    if (Object.keys(normalizedHeaders).some((name) => name.startsWith('x-codex-'))) {
        prefixes.add('codex');
    }

    const buckets: CodexUsageBucket[] = [];
    for (const prefix of prefixes) {
        const primary = parseHeaderWindow(normalizedHeaders, `${prefix}-primary`);
        const secondary = parseHeaderWindow(normalizedHeaders, `${prefix}-secondary`);
        const limitName = normalizedHeaders[`x-${prefix}-limit-name`]?.trim() || undefined;
        if (primary || secondary || limitName) {
            buckets.push({
                limitId: normalizeCodexLimitId(prefix),
                limitName,
                primary,
                secondary,
            });
        }
    }

    const planType = normalizedHeaders['x-codex-plan-type']?.trim() || undefined;
    const activeLimit = normalizedHeaders['x-codex-active-limit']?.trim() || undefined;
    const credits = parseHeaderCredits(normalizedHeaders);
    if (!planType && !activeLimit && !credits && buckets.length === 0) return null;
    return { planType, activeLimit, buckets, credits, capturedAt };
}

function parsePayloadBucket(
    limitId: string,
    limitName: string | undefined,
    rateLimit: Record<string, unknown> | undefined,
): CodexUsageBucket {
    return {
        limitId,
        limitName,
        primary: parsePayloadWindow(rateLimit?.primary_window),
        secondary: parsePayloadWindow(rateLimit?.secondary_window),
    };
}

function parsePayloadWindow(value: unknown): CodexUsageWindow | undefined {
    const window = asRecord(value);
    if (!window) return undefined;
    const percentUsed = finiteNumberOrUndefined(window.used_percent);
    if (percentUsed === undefined) return undefined;
    const seconds = finiteNumberOrUndefined(window.limit_window_seconds);
    const resetAt = finiteNumberOrUndefined(window.reset_at);
    return {
        percentUsed: clampPercent(percentUsed),
        windowMinutes: seconds !== undefined && seconds >= 0 ? seconds / 60 : undefined,
        resetAt: resetAt !== undefined && resetAt > 0 ? resetAt : undefined,
    };
}

function parseHeaderWindow(headers: Record<string, string>, prefix: string): CodexUsageWindow | undefined {
    const percentUsed = finiteNumberOrUndefined(headers[`x-${prefix}-used-percent`]);
    if (percentUsed === undefined) return undefined;
    const windowMinutes = finiteNumberOrUndefined(headers[`x-${prefix}-window-minutes`]);
    const resetAt = finiteNumberOrUndefined(headers[`x-${prefix}-reset-at`]);
    return {
        percentUsed: clampPercent(percentUsed),
        windowMinutes: windowMinutes !== undefined && windowMinutes >= 0 ? windowMinutes : undefined,
        resetAt: resetAt !== undefined && resetAt > 0 ? resetAt : undefined,
    };
}

function parsePayloadCredits(value: unknown): CodexUsageCredits | undefined {
    const credits = asRecord(value);
    if (!credits) return undefined;
    const hasCredits = booleanOrUndefined(credits.has_credits);
    const unlimited = booleanOrUndefined(credits.unlimited);
    if (hasCredits === undefined || unlimited === undefined) return undefined;
    return {
        hasCredits,
        unlimited,
        balance: stringOrUndefined(credits.balance),
    };
}

function parseHeaderCredits(headers: Record<string, string>): CodexUsageCredits | undefined {
    const hasCredits = booleanOrUndefined(headers['x-codex-credits-has-credits']);
    const unlimited = booleanOrUndefined(headers['x-codex-credits-unlimited']);
    if (hasCredits === undefined || unlimited === undefined) return undefined;
    return {
        hasCredits,
        unlimited,
        balance: headers['x-codex-credits-balance']?.trim() || undefined,
    };
}

function parseIndividualLimit(value: unknown): CodexSpendControlLimit | undefined {
    const limit = asRecord(value);
    if (!limit) return undefined;
    const total = stringOrUndefined(limit.limit);
    const used = stringOrUndefined(limit.used);
    const remainingPercent = finiteNumberOrUndefined(limit.remaining_percent);
    const resetAt = finiteNumberOrUndefined(limit.reset_at);
    if (!total || !used || remainingPercent === undefined || resetAt === undefined) return undefined;
    return {
        limit: total,
        used,
        remainingPercent: clampPercent(remainingPercent),
        resetAt,
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
    const parsed = finiteNumberOrUndefined(value);
    return parsed !== undefined && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    if (value.toLowerCase() === 'true' || value === '1') return true;
    if (value.toLowerCase() === 'false' || value === '0') return false;
    return undefined;
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
}
