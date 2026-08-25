import { describe, expect, it } from 'vitest';
import {
    TURN_METRICS_CUSTOM_TYPE,
    TURN_METRICS_TOOL_DURATION_LIMIT,
    collectPersistedTurnMetrics,
    parsePersistedTurnMetrics,
} from '../../../shared/turn-metrics';

function entry(data: unknown, customType = TURN_METRICS_CUSTOM_TYPE): unknown {
    return { type: 'custom', customType, data, id: 'e1', parentId: undefined };
}

describe('persisted turn metrics replay', () => {
    it('reads metrics entries and ignores every other branch entry', () => {
        const metrics = collectPersistedTurnMetrics([
            { type: 'message', message: { role: 'assistant', timestamp: 1 } },
            entry({ status: 'completed' }, 'pi-code.turn-lifecycle'),
            entry({ key: '1700', turnDurationMs: 4000 }),
            'not an entry',
            null,
        ]);

        expect(metrics).toEqual([{ key: '1700', turnDurationMs: 4000 }]);
    });

    it('takes the newest write for a key, so a late background settle wins', () => {
        const metrics = collectPersistedTurnMetrics([
            entry({
                key: '1700',
                subagentStats: [{
                    agentId: 'bg', name: 'Explorer', status: 'active', durationMs: 4000,
                }],
            }),
            entry({
                key: '1700',
                subagentStats: [{
                    agentId: 'bg', name: 'Explorer', status: 'completed', durationMs: 14_000,
                }],
            }),
        ]);

        expect(metrics).toHaveLength(1);
        expect(metrics[0].subagentStats).toEqual([{
            agentId: 'bg',
            name: 'Explorer',
            status: 'completed',
            durationMs: 14_000,
            queueWaitMs: 0,
            toolDurationMs: 0,
            toolCalls: 0,
        }]);
    });

    it('keeps replay order by first appearance of each key', () => {
        const metrics = collectPersistedTurnMetrics([
            entry({ key: 'a', turnDurationMs: 1 }),
            entry({ key: 'b', turnDurationMs: 2 }),
            entry({ key: 'a', turnDurationMs: 3 }),
        ]);

        expect(metrics.map((item) => [item.key, item.turnDurationMs]))
            .toEqual([['a', 3], ['b', 2]]);
    });
});

describe('persisted turn metrics parsing', () => {
    it('drops a payload with no usable key', () => {
        expect(parsePersistedTurnMetrics(undefined)).toBeUndefined();
        expect(parsePersistedTurnMetrics({ turnDurationMs: 10 })).toBeUndefined();
        expect(parsePersistedTurnMetrics({ key: '' })).toBeUndefined();
        expect(parsePersistedTurnMetrics('1700')).toBeUndefined();
    });

    it('ignores unusable numbers rather than storing them', () => {
        expect(parsePersistedTurnMetrics({
            key: '1700',
            turnDurationMs: Number.NaN,
            modelWaitMs: -5,
            compactionMs: 'soon',
            messageEndTime: 1_700_000_000,
        })).toEqual({ key: '1700', messageEndTime: 1_700_000_000 });
    });

    it('omits empty breakdowns so a restored turn is not given blank sections', () => {
        expect(parsePersistedTurnMetrics({
            key: '1700',
            toolStats: [],
            subagentStats: 'nope',
            toolDurations: {},
        })).toEqual({ key: '1700' });
    });

    it('repairs tool durations and bounds how many one turn can carry', () => {
        const overflowing: Record<string, unknown> = { bad: 'x', negative: -10 };
        for (let index = 0; index < TURN_METRICS_TOOL_DURATION_LIMIT + 25; index++) {
            overflowing[`call-${index}`] = index + 1;
        }

        const parsed = parsePersistedTurnMetrics({ key: '1700', toolDurations: overflowing });

        expect(Object.keys(parsed?.toolDurations ?? {}))
            .toHaveLength(TURN_METRICS_TOOL_DURATION_LIMIT);
        expect(parsed?.toolDurations).not.toHaveProperty('bad');
        expect(parsed?.toolDurations).not.toHaveProperty('negative');
    });
});
