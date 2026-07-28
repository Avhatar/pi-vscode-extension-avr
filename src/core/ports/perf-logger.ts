/**
 * Platform-neutral performance logger port.
 *
 * A `PerfLogger` records timing information for named scopes so activation,
 * session bring-up, and per-tab operations can be analysed offline. Adapters
 * decide where the data lands (file, stdout, memory).
 *
 * All methods must be safe to call even when logging is disabled: production
 * code should be able to keep call sites unconditional and swap in the
 * `NOOP_PERF_LOGGER` when the user has not opted in.
 */
export interface PerfLogger {
    /**
     * Time an async operation. Emits a `begin` marker, runs `fn`, then emits
     * an `end` marker with `durationMs` and `ok` flag. Errors are re-thrown
     * after being reported.
     */
    time<T>(scope: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T>;

    /**
     * Synchronous counterpart to `time`. Prefer `time` unless the callee is
     * genuinely synchronous — avoids one microtask hop.
     */
    timeSync<T>(scope: string, fn: () => T, meta?: Record<string, unknown>): T;

    /**
     * Emit a single point-in-time event (no duration). Useful for markers
     * like "activation reached wire-up phase" that do not enclose a call.
     */
    event(scope: string, meta?: Record<string, unknown>): void;

    /**
     * Derive a child logger whose emitted events are decorated with the
     * given metadata (e.g. `{ tabId: 'tab-3' }`). Child meta merges into the
     * parent's; child keys win on collision.
     */
    child(meta: Record<string, unknown>): PerfLogger;

    /**
     * Flush any buffered events to durable storage. Adapters that write
     * synchronously may make this a no-op.
     */
    flush(): Promise<void>;
}

export const NOOP_PERF_LOGGER: PerfLogger = {
    async time(_scope, fn) { return fn(); },
    timeSync(_scope, fn) { return fn(); },
    event() { /* no-op */ },
    child() { return NOOP_PERF_LOGGER; },
    async flush() { /* no-op */ },
};
