import type {
    DeepSeekBalanceInfo,
    DeepSeekTurnUsage,
    DeepSeekUsageSnapshot,
} from './agent-protocol';

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
): DeepSeekTurnUsage | undefined {
    if (!isNonNegativeFinite(beforeSessionCost) || !isNonNegativeFinite(afterSessionCost)) return undefined;
    if (afterSessionCost < beforeSessionCost) return undefined;
    return {
        turnCost: normalizeCost(afterSessionCost - beforeSessionCost),
        sessionCost: normalizeCost(afterSessionCost),
        capturedAt,
    };
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
