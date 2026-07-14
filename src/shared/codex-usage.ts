import type {
    CodexTurnUsage,
    CodexTurnWindowDelta,
    CodexUsageBucket,
    CodexUsageSnapshot,
    CodexUsageWindow,
} from './protocol';

export const CODEX_USAGE_STALE_MS = 15 * 60 * 1000;

export function normalizeCodexLimitId(value: string): string {
    return value.trim().toLowerCase().replace(/-/g, '_');
}

export function isCodexUsageStale(snapshot: CodexUsageSnapshot, now = Date.now()): boolean {
    return now - snapshot.capturedAt > CODEX_USAGE_STALE_MS;
}

/**
 * Select the bucket that best matches the active model. Codex may expose
 * dedicated model/feature buckets alongside the legacy default "codex" one.
 */
export function selectCodexUsageBucket(
    snapshot: CodexUsageSnapshot,
    modelId?: string,
): CodexUsageBucket | undefined {
    const normalizedModel = modelId ? normalizeCodexLimitId(modelId) : '';
    if (normalizedModel) {
        const exact = snapshot.buckets.find((bucket) => {
            const ids = [bucket.limitId, bucket.limitName]
                .filter((value): value is string => !!value)
                .map(normalizeCodexLimitId);
            return ids.includes(normalizedModel);
        });
        if (exact) return exact;
    }

    if (snapshot.activeLimit) {
        const activeId = normalizeCodexLimitId(snapshot.activeLimit);
        const active = snapshot.buckets.find((bucket) => normalizeCodexLimitId(bucket.limitId) === activeId);
        if (active) return active;
    }

    return snapshot.buckets.find((bucket) => normalizeCodexLimitId(bucket.limitId) === 'codex')
        ?? snapshot.buckets[0];
}

export function computeCodexTurnUsage(
    baseline: CodexUsageSnapshot | null,
    after: CodexUsageSnapshot | null,
    modelId?: string,
): CodexTurnUsage | undefined {
    if (!baseline || !after || after.capturedAt <= baseline.capturedAt) return undefined;

    const beforeBucket = selectCodexUsageBucket(baseline, modelId);
    const afterBucket = selectCodexUsageBucket(after, modelId);
    if (!beforeBucket || !afterBucket || beforeBucket.limitId !== afterBucket.limitId) return undefined;

    const primary = computeCodexWindowDelta(beforeBucket.primary, afterBucket.primary);
    const secondary = computeCodexWindowDelta(beforeBucket.secondary, afterBucket.secondary);
    if (!primary && !secondary) return undefined;
    return { primary, secondary, capturedAt: after.capturedAt };
}

export function computeCodexWindowDelta(
    before: CodexUsageWindow | undefined,
    after: CodexUsageWindow | undefined,
): CodexTurnWindowDelta | undefined {
    if (!before || !after) return undefined;
    if (before.windowMinutes !== after.windowMinutes) return undefined;
    if (before.resetAt !== after.resetAt) return undefined;
    const deltaPercent = after.percentUsed - before.percentUsed;
    // A missing baseline, reset, concurrent correction, or unchanged rounded
    // percentage is not attributable to this turn.
    if (deltaPercent <= 0) return undefined;
    return {
        windowMinutes: after.windowMinutes,
        beforePercent: before.percentUsed,
        afterPercent: after.percentUsed,
        deltaPercent,
    };
}
