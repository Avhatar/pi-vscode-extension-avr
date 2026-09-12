import { describe, expect, it, vi } from 'vitest';
import type { StateStore } from '../../../core/ports/chat-platform';
import { DeepSeekUsageStore } from '../../../pi/deepseek-usage-store';
import {
    computeDeepSeekTurnUsage,
    deepSeekRateMultiplier,
    formatUsdAmount,
    isDeepSeekPeakHour,
    parseDeepSeekBalancePayload,
} from '../../../shared/deepseek-usage';
import { isServerMessage } from '../../../shared/protocol-runtime';

class MemoryStateStore implements StateStore {
    readonly values = new Map<string, unknown>();

    get<T>(key: string, fallback?: T): T | undefined {
        return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
    }
}

describe('DeepSeek usage accounting', () => {
    it('parses the official balance payload and rejects malformed balances', () => {
        expect(parseDeepSeekBalancePayload({
            is_available: true,
            balance_infos: [{
                currency: 'USD',
                total_balance: '12.34567',
                granted_balance: '0.50',
                topped_up_balance: '11.84567',
            }],
        }, 1234, 0.0042, '2026-07-30')).toEqual({
            isAvailable: true,
            balanceInfos: [{
                currency: 'USD',
                totalBalance: 12.34567,
                grantedBalance: 0.5,
                toppedUpBalance: 11.84567,
            }],
            todayCost: 0.0042,
            todayDate: '2026-07-30',
            capturedAt: 1234,
        });

        expect(() => parseDeepSeekBalancePayload({
            is_available: true,
            balance_infos: [{ currency: 'USD', total_balance: 'not-a-number' }],
        }, 1, 0, '2026-07-30')).toThrow('Invalid DeepSeek balance response');
    });

    it('accepts DeepSeek balance snapshots on the typed server protocol', () => {
        expect(isServerMessage({
            type: 'deepSeekUsage',
            usage: {
                isAvailable: true,
                balanceInfos: [{
                    currency: 'USD',
                    totalBalance: 10,
                    grantedBalance: 1,
                    toppedUpBalance: 9,
                }],
                todayCost: 0.0042,
                todayDate: '2026-07-30',
                capturedAt: 1234,
            },
        })).toBe(true);
    });

    it('computes turn and cumulative session cost from monotonic SDK totals', () => {
        expect(computeDeepSeekTurnUsage(1.25, 1.2542, 5000, 1)).toEqual({
            turnCost: 0.0042,
            sessionCost: 1.2542,
            capturedAt: 5000,
        });
        expect(computeDeepSeekTurnUsage(undefined, 1.2, 5000, 1)).toBeUndefined();
        expect(computeDeepSeekTurnUsage(2, 1, 5000, 1)).toBeUndefined();
    });

    it('books a turn at the peak multiplier when it started inside a peak window', () => {
        expect(computeDeepSeekTurnUsage(1.25, 1.2542, 5000, 2)).toEqual({
            turnCost: 0.0084,
            sessionCost: 1.2542,
            capturedAt: 5000,
        });
    });

    it('treats only DeepSeek weekday peak windows as peak', () => {
        // Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 2, 30))).toBe(true);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 6, 0))).toBe(true);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 9, 59))).toBe(true);

        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 0, 59))).toBe(false);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 1, 0))).toBe(true);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 3, 59))).toBe(true);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 4, 0))).toBe(false);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 5, 59))).toBe(false);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 10, 0))).toBe(false);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 14, 23, 0))).toBe(false);

        // 2026-09-12 and 2026-09-13 are a Saturday and a Sunday.
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 12, 2, 0))).toBe(false);
        expect(isDeepSeekPeakHour(Date.UTC(2026, 8, 13, 8, 0))).toBe(false);

        expect(deepSeekRateMultiplier(Date.UTC(2026, 8, 14, 2, 0))).toBe(2);
        expect(deepSeekRateMultiplier(Date.UTC(2026, 8, 14, 12, 0))).toBe(1);
    });

    it('formats USD with at most four decimals while keeping tiny non-zero costs visible', () => {
        expect(formatUsdAmount(12.34567)).toBe('$12.3457');
        expect(formatUsdAmount(12.3)).toBe('$12.3');
        expect(formatUsdAmount(0)).toBe('$0.0');
        expect(formatUsdAmount(0.00004)).toBe('<$0.0001');
    });

    it('fetches balances and persists a per-key local-day spend ledger', async () => {
        let now = new Date(2026, 6, 30, 12, 0, 0).getTime();
        let accessToken = 'first-key';
        const memento = new MemoryStateStore();
        const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({
            ok: true,
            status: 200,
            json: async () => ({
                is_available: true,
                balance_infos: [{
                    currency: 'USD',
                    total_balance: '10.25',
                    granted_balance: '0',
                    topped_up_balance: '10.25',
                }],
            }),
        }));
        const store = new DeepSeekUsageStore({
            getAccessToken: async () => accessToken,
            fetch,
            now: () => now,
        });
        store.init(memento);

        await store.recordTurnCost(0.0012);
        await store.recordTurnCost(0.003);
        await expect(store.refresh()).resolves.toMatchObject({
            todayCost: 0.0042,
            balanceInfos: [{ currency: 'USD', totalBalance: 10.25 }],
        });
        expect(fetch).toHaveBeenCalledWith(
            'https://api.deepseek.com/user/balance',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({ authorization: 'Bearer first-key' }),
            }),
        );

        const restored = new DeepSeekUsageStore({
            getAccessToken: async () => accessToken,
            fetch,
            now: () => now,
        });
        restored.init(memento);
        await expect(restored.refresh()).resolves.toMatchObject({ todayCost: 0.0042 });

        now = new Date(2026, 6, 31, 12, 0, 0).getTime();
        await restored.recordTurnCost(0.002);
        await expect(restored.refresh()).resolves.toMatchObject({ todayCost: 0.002 });

        accessToken = 'second-key';
        await restored.recordTurnCost(0.005);
        await expect(restored.refresh()).resolves.toMatchObject({ todayCost: 0.005 });
        await expect(restored.recordTurnCost(1, 'different-account')).resolves.toBe(false);
        await expect(restored.refresh()).resolves.toMatchObject({ todayCost: 0.005 });

        accessToken = 'first-key';
        await restored.recordTurnCost(0.001);
        await expect(restored.refresh()).resolves.toMatchObject({ todayCost: 0.003 });
    });

    it('does not let an in-flight response from a replaced key overwrite the new account', async () => {
        let accessToken = 'first-key';
        const pending = new Map<string, (total: string) => void>();
        const fetch = vi.fn(async (_url: string, init: RequestInit) => new Promise<{
            ok: boolean;
            status: number;
            json(): Promise<unknown>;
        }>((resolve) => {
            const token = String((init.headers as Record<string, string>).authorization).slice('Bearer '.length);
            pending.set(token, (total) => resolve({
                ok: true,
                status: 200,
                json: async () => ({
                    is_available: true,
                    balance_infos: [{
                        currency: 'USD',
                        total_balance: total,
                        granted_balance: '0',
                        topped_up_balance: total,
                    }],
                }),
            }));
        }));
        const store = new DeepSeekUsageStore({
            getAccessToken: async () => accessToken,
            fetch,
            now: () => new Date(2026, 7, 3, 12, 0, 0).getTime(),
        });
        store.init(new MemoryStateStore());

        const first = store.refresh();
        await vi.waitFor(() => expect(pending.has('first-key')).toBe(true));
        accessToken = 'second-key';
        store.clear();
        const second = store.refresh();
        await vi.waitFor(() => expect(pending.has('second-key')).toBe(true));

        pending.get('second-key')?.('20');
        await expect(second).resolves.toMatchObject({
            balanceInfos: [{ totalBalance: 20 }],
        });
        pending.get('first-key')?.('10');
        await expect(first).resolves.toBeNull();
        expect(store.getCurrent()).toMatchObject({
            balanceInfos: [{ totalBalance: 20 }],
        });
    });
});
