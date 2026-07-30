export interface ChatScrollMetrics {
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
}

const AUTO_FOLLOW_BOTTOM_TOLERANCE_PX = 2;

export function getDistanceFromScrollBottom(metrics: ChatScrollMetrics): number {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function shouldResumeAutoFollow(
    metrics: ChatScrollMetrics,
    tolerancePx = AUTO_FOLLOW_BOTTOM_TOLERANCE_PX,
): boolean {
    // Auto-follow may resume only when the user is effectively at the bottom.
    // A broader "near bottom" threshold would trap users who intentionally
    // scroll a few pixels upward while streaming output is still growing.
    return getDistanceFromScrollBottom(metrics) <= tolerancePx;
}
