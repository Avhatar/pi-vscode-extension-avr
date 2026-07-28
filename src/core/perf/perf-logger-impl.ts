import type { PerfLogger } from '../ports/perf-logger';
import type { PerfSink } from '../ports/perf-sink';

interface LoggerOptions {
    sink: PerfSink;
    baseMeta?: Record<string, unknown>;
    /** Injectable clock for tests. Defaults to `Date.now()` + hi-res via `performance.now()` when available. */
    now?: () => number;
    /** ISO timestamp source, defaults to `new Date().toISOString()`. */
    isoNow?: () => string;
}

function defaultNow(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function defaultIsoNow(): string {
    return new Date().toISOString();
}

/**
 * File-agnostic PerfLogger implementation. Writes structured JSONL records to
 * a {@link PerfSink}. Every record includes a millisecond timestamp, the scope
 * name, a phase (`begin`, `end`, or `event`), and optional metadata.
 *
 * Errors from `fn` never break the caller: the underlying error is re-thrown,
 * and the `end` record carries `ok: false` plus `errorMessage`.
 */
export class PerfLoggerImpl implements PerfLogger {
    private readonly _sink: PerfSink;
    private readonly _baseMeta: Record<string, unknown> | undefined;
    private readonly _now: () => number;
    private readonly _isoNow: () => string;

    constructor(options: LoggerOptions) {
        this._sink = options.sink;
        this._baseMeta = options.baseMeta;
        this._now = options.now ?? defaultNow;
        this._isoNow = options.isoNow ?? defaultIsoNow;
    }

    async time<T>(scope: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
        const start = this._now();
        this._emit({ scope, phase: 'begin', meta });
        try {
            const result = await fn();
            const durationMs = Math.round((this._now() - start) * 1000) / 1000;
            this._emit({ scope, phase: 'end', durationMs, ok: true, meta });
            return result;
        } catch (error) {
            const durationMs = Math.round((this._now() - start) * 1000) / 1000;
            const errorMessage = error instanceof Error ? error.message : String(error);
            this._emit({ scope, phase: 'end', durationMs, ok: false, errorMessage, meta });
            throw error;
        }
    }

    timeSync<T>(scope: string, fn: () => T, meta?: Record<string, unknown>): T {
        const start = this._now();
        this._emit({ scope, phase: 'begin', meta });
        try {
            const result = fn();
            const durationMs = Math.round((this._now() - start) * 1000) / 1000;
            this._emit({ scope, phase: 'end', durationMs, ok: true, meta });
            return result;
        } catch (error) {
            const durationMs = Math.round((this._now() - start) * 1000) / 1000;
            const errorMessage = error instanceof Error ? error.message : String(error);
            this._emit({ scope, phase: 'end', durationMs, ok: false, errorMessage, meta });
            throw error;
        }
    }

    event(scope: string, meta?: Record<string, unknown>): void {
        this._emit({ scope, phase: 'event', meta });
    }

    child(meta: Record<string, unknown>): PerfLogger {
        return new PerfLoggerImpl({
            sink: this._sink,
            baseMeta: { ...(this._baseMeta ?? {}), ...meta },
            now: this._now,
            isoNow: this._isoNow,
        });
    }

    async flush(): Promise<void> {
        await this._sink.flush();
    }

    private _emit(record: {
        scope: string;
        phase: 'begin' | 'end' | 'event';
        durationMs?: number;
        ok?: boolean;
        errorMessage?: string;
        meta?: Record<string, unknown>;
    }): void {
        const merged = this._baseMeta || record.meta
            ? { ...(this._baseMeta ?? {}), ...(record.meta ?? {}) }
            : undefined;
        const payload: Record<string, unknown> = {
            ts: this._isoNow(),
            scope: record.scope,
            phase: record.phase,
        };
        if (record.durationMs !== undefined) payload.durationMs = record.durationMs;
        if (record.ok !== undefined) payload.ok = record.ok;
        if (record.errorMessage !== undefined) payload.errorMessage = record.errorMessage;
        if (merged && Object.keys(merged).length > 0) payload.meta = merged;
        try {
            this._sink.write(JSON.stringify(payload));
        } catch {
            // Perf logging must never break the extension.
        }
    }
}
