import type {
    DeepSeekBalanceInfo,
    DeepSeekTurnUsage,
    DeepSeekUsageSnapshot,
} from './agent-protocol';

/** Peak hours run at twice the off-peak rate. */
const DEEPSEEK_PEAK_MULTIPLIER = 2;

/** UTC [startHour, endHour) windows DeepSeek charges peak rates in, weekdays only. */
const DEEPSEEK_PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [[1, 4], [6, 10]];

export function parseDeepSeekBalancePayload(
    payload: unknown,
    capturedAt: number,
    todayCost: number,
    todayDate: string,
): DeepSeekUsageSnapshot {
    if (!isRecord(payload) || typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
        throw new Error('Invalid DeepSeek balance response');
    }

    const balanceInfos: DeepSeekBalanceInfo[] = payload.balance_infos.map((value) => {
        if (!isRecord(value) || typeof value.currency !== 'string') {
            throw new Error('Invalid DeepSeek balance response');
        }
        return {
            currency: value.currency,
            totalBalance: parseBalance(value.total_balance),
            grantedBalance: parseBalance(value.granted_balance),
            toppedUpBalance: parseBalance(value.topped_up_balance),
        };
    });

    return {
        isAvailable: payload.is_available,
        balanceInfos,
        todayCost: normalizeCost(todayCost),
        todayDate,
        capturedAt,
    };
}

export function computeDeepSeekTurnUsage(
    beforeSessionCost: number | undefined,
    afterSessionCost: number | undefined,
    capturedAt: number,
    rateMultiplier: number,
): DeepSeekTurnUsage | undefined {
    if (!isNonNegativeFinite(beforeSessionCost) || !isNonNegativeFinite(afterSessionCost)) return undefined;
    if (afterSessionCost < beforeSessionCost) return undefined;
    return {
        turnCost: normalizeCost((afterSessionCost - beforeSessionCost) * rateMultiplier),
        sessionCost: normalizeCost(afterSessionCost),
        capturedAt,
    };
}

/**
 * DeepSeek bills peak and off-peak rates, with off-peak at half of peak. Peak
 * hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; every other
 * hour is off-peak.
 *
 * The SDK prices DeepSeek turns at the off-peak rates, so the peak multiplier
 * has to be applied where the spend is accounted. It is evaluated once, when
 * the turn starts: a turn spans several provider requests and DeepSeek prices
 * each request when it arrives, which this cannot model exactly.
 */
export function deepSeekRateMultiplier(at: number): number {
    return isDeepSeekPeakHour(at) ? DEEPSEEK_PEAK_MULTIPLIER : 1;
}

/** Whether `at` falls inside one of DeepSeek's weekday peak windows. */
export function isDeepSeekPeakHour(at: number): boolean {
    const date = new Date(at);
    const day = date.getUTCDay();
    if (day === 0 || day === 6) return false;
    const hour = date.getUTCHours();
    return DEEPSEEK_PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

export function formatUsdAmount(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '$0.0';
    if (value > 0 && value < 0.00005) return '<$0.0001';
    const compact = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return `$${compact.includes('.') ? compact : `${compact}.0`}`;
}

function parseBalance(value: unknown): number {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error('Invalid DeepSeek balance response');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('Invalid DeepSeek balance response');
    }
    return parsed;
}

function isNonNegativeFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeCost(value: number): number {
    return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
