import { describe, expect, it } from 'vitest';
import { parseCodexHeaders, parseCodexUsagePayload } from '../../../pi/codex-usage-parser';
import {
    computeCodexTurnUsage,
    computeCodexWindowDelta,
    isCodexUsageStale,
    selectCodexUsageBucket,
} from '../../../shared/codex-usage';
import type { CodexUsageSnapshot } from '../../../shared/protocol';

describe('Codex usage parsing', () => {
    it('parses current account usage payloads with additional buckets and account controls', () => {
        const snapshot = parseCodexUsagePayload({
            plan_type: 'prolite',
            rate_limit: {
                primary_window: {
                    used_percent: 42,
                    limit_window_seconds: 18_000,
                    reset_after_seconds: 120,
                    reset_at: 1_800_000_000,
                },
                secondary_window: {
                    used_percent: 5,
                    limit_window_seconds: 604_800,
                    reset_after_seconds: 1_000,
                    reset_at: 1_800_500_000,
                },
            },
            credits: { has_credits: true, unlimited: false, balance: '125.5' },
            spend_control: {
                individual_limit: {
                    limit: '25000',
                    used: '8000',
                    remaining_percent: 68,
                    reset_at: 1_801_000_000,
                },
            },
            additional_rate_limits: [{
                limit_name: 'gpt-5.6-luna',
                metered_feature: 'codex_luna',
                rate_limit: {
                    primary_window: {
                        used_percent: 12,
                        limit_window_seconds: 18_000,
                        reset_at: 1_800_000_000,
                    },
                },
            }],
            rate_limit_reached_type: { type: 'workspace_member_usage_limit_reached' },
            rate_limit_reset_credits: { available_count: 2 },
        }, 1234);

        expect(snapshot.planType).toBe('prolite');
        expect(snapshot.capturedAt).toBe(1234);
        expect(snapshot.buckets).toHaveLength(2);
        expect(snapshot.buckets[0]).toMatchObject({
            limitId: 'codex',
            primary: { percentUsed: 42, windowMinutes: 300, resetAt: 1_800_000_000 },
            secondary: { percentUsed: 5, windowMinutes: 10_080, resetAt: 1_800_500_000 },
        });
        expect(snapshot.buckets[1]).toMatchObject({
            limitId: 'codex_luna',
            limitName: 'gpt-5.6-luna',
            primary: { percentUsed: 12, windowMinutes: 300 },
        });
        expect(snapshot.credits).toEqual({ hasCredits: true, unlimited: false, balance: '125.5' });
        expect(snapshot.individualLimit).toEqual({
            limit: '25000',
            used: '8000',
            remainingPercent: 68,
            resetAt: 1_801_000_000,
        });
        expect(snapshot.rateLimitReachedType).toBe('workspace_member_usage_limit_reached');
        expect(snapshot.resetCreditsAvailable).toBe(2);
    });

    it('accepts current partial headers without plan type or reset-after headers', () => {
        const snapshot = parseCodexHeaders({
            'X-Codex-Primary-Used-Percent': '12.5',
            'X-Codex-Primary-Window-Minutes': '300',
            'X-Codex-Primary-Reset-At': '1800000000',
            'X-Codex-Luna-Primary-Used-Percent': '7',
            'X-Codex-Luna-Limit-Name': 'gpt-5.6-luna',
            'X-Codex-Credits-Has-Credits': '1',
            'X-Codex-Credits-Unlimited': '0',
        }, 4321);

        expect(snapshot).not.toBeNull();
        expect(snapshot?.planType).toBeUndefined();
        expect(snapshot?.buckets).toEqual([
            {
                limitId: 'codex',
                limitName: undefined,
                primary: { percentUsed: 12.5, windowMinutes: 300, resetAt: 1_800_000_000 },
                secondary: undefined,
            },
            {
                limitId: 'codex_luna',
                limitName: 'gpt-5.6-luna',
                primary: { percentUsed: 7, windowMinutes: undefined, resetAt: undefined },
                secondary: undefined,
            },
        ]);
        expect(snapshot?.credits).toEqual({ hasCredits: true, unlimited: false, balance: undefined });
    });
});

describe('Codex usage selection and turn deltas', () => {
    const before: CodexUsageSnapshot = {
        planType: 'plus',
        buckets: [
            {
                limitId: 'codex',
                primary: { percentUsed: 20, windowMinutes: 300, resetAt: 2_000 },
            },
            {
                limitId: 'codex_luna',
                limitName: 'gpt-5.6-luna',
                primary: { percentUsed: 10, windowMinutes: 300, resetAt: 2_000 },
            },
        ],
        capturedAt: 1_000,
    };

    it('selects a model-specific bucket before the default bucket', () => {
        expect(selectCodexUsageBucket(before, 'gpt-5.6-luna')?.limitId).toBe('codex_luna');
        expect(selectCodexUsageBucket(before, 'gpt-5.6-sol')?.limitId).toBe('codex');
    });

    it('computes a delta only from matching observed windows', () => {
        const after: CodexUsageSnapshot = {
            ...before,
            buckets: before.buckets.map((bucket) => bucket.limitId === 'codex_luna'
                ? { ...bucket, primary: { ...bucket.primary!, percentUsed: 12.5 } }
                : bucket),
            capturedAt: 2_000,
        };

        expect(computeCodexTurnUsage(before, after, 'gpt-5.6-luna')?.primary).toMatchObject({
            beforePercent: 10,
            afterPercent: 12.5,
            deltaPercent: 2.5,
        });
        expect(computeCodexTurnUsage(null, after, 'gpt-5.6-luna')).toBeUndefined();
        expect(computeCodexWindowDelta(
            before.buckets[1].primary,
            { percentUsed: 1, windowMinutes: 300, resetAt: 3_000 },
        )).toBeUndefined();
    });

    it('marks snapshots stale after fifteen minutes', () => {
        expect(isCodexUsageStale(before, before.capturedAt + 15 * 60_000)).toBe(false);
        expect(isCodexUsageStale(before, before.capturedAt + 15 * 60_000 + 1)).toBe(true);
    });
});
