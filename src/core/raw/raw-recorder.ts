import type { Logger } from '../ports/logger';
import type { RawStoragePort } from '../ports/raw-storage';
import type {
    RawEntry,
    RawEntryKind,
    RawRecorderMetaPayload,
} from '../../shared/raw-protocol';
import { RawEntryBuffer, DEFAULT_RAW_BUFFER_CAPACITY } from './raw-entry-buffer';

export type RawEntryListener = (entry: RawEntry) => void;

/** Symbolic prefix used while a recorder has not yet been bound to a Pi session file. */
export const PENDING_SESSION_PREFIX = 'pending:';

export interface RawRecorderOptions {
    storage: RawStoragePort;
    logger?: Logger;
    /** Ring buffer capacity for in-memory recent tail. Defaults to 5000. */
    capacity?: number;
    /** Clock injection for deterministic tests. Defaults to `Date.now`. */
    now?: () => number;
    /**
     * Continuation `seq`. Loaded by the caller from
     * {@link RawStoragePort.getNextSeq} when reopening an existing session.
     */
    initialSeq?: number;
    /** Concrete session path when known at construction time. */
    sessionPath?: string;
    /** Stable pending identity, used only when {@link sessionPath} is absent. */
    pendingId?: string;
}

/**
 * Per-session raw event recorder. Serializes every {@link record} call to
 * the underlying storage in the order supplied by the caller and keeps a
 * short in-memory tail for immediate delivery to attached panels.
 *
 * The recorder is deliberately tolerant of storage failures — it never
 * throws out of {@link record}. A storage failure is captured as a
 * `recorder_meta { kind: 'recorder_error' }` in-memory entry so the
 * timeline visibly shows a gap; the recorder does not attempt to
 * recursively persist the error report (which would risk an infinite
 * failure loop against the same broken adapter).
 */
export class RawRecorder {
    private readonly _buffer: RawEntryBuffer;
    private readonly _storage: RawStoragePort;
    private readonly _logger?: Logger;
    private readonly _now: () => number;
    private readonly _listeners = new Set<RawEntryListener>();
    private _sessionPath: string;
    private _nextSeq: number;
    private _closed = false;
    private _capturePaused = false;
    private _writeChain: Promise<void> = Promise.resolve();
    /** Buffer of raw JSONL lines pending flush to a concrete session path. */
    private _pendingLines: Array<{ entry: RawEntry; line: string }> = [];

    constructor(options: RawRecorderOptions) {
        this._storage = options.storage;
        this._logger = options.logger;
        this._now = options.now ?? Date.now;
        this._buffer = new RawEntryBuffer(options.capacity ?? DEFAULT_RAW_BUFFER_CAPACITY);
        this._nextSeq = Math.max(0, Math.trunc(options.initialSeq ?? 0));
        this._sessionPath = options.sessionPath
            ?? `${PENDING_SESSION_PREFIX}${options.pendingId ?? this._defaultPendingId()}`;
    }

    get sessionPath(): string {
        return this._sessionPath;
    }

    get isPending(): boolean {
        return this._sessionPath.startsWith(PENDING_SESSION_PREFIX);
    }

    get nextSeq(): number {
        return this._nextSeq;
    }

    snapshot(): RawEntry[] {
        return this._buffer.snapshot();
    }

    entriesSince(fromSeq: number): RawEntry[] {
        return this._buffer.entriesSince(fromSeq);
    }

    onEntry(listener: RawEntryListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * Record one event. Assigns `seq` and `timestampMs`, serializes to JSONL,
     * writes through the storage adapter, and fanouts to listeners after the
     * write settles (successfully or not). Returns the assigned entry so
     * callers can correlate metadata (e.g. tests).
     *
     * Ordering guarantee: writes are chained via an internal promise, so
     * disk order matches call order even if adapters are async.
     */
    record(kind: RawEntryKind, payload: unknown): RawEntry {
        if (this._closed || this._capturePaused) {
            // Silently drop after close or during an explicit data-clear
            // boundary. Pausing prevents an append from racing deletion.
            return {
                seq: -1,
                timestampMs: this._now(),
                sessionPath: this._sessionPath,
                kind,
                payload,
            };
        }
        const entry: RawEntry = {
            seq: this._nextSeq++,
            timestampMs: this._now(),
            sessionPath: this._sessionPath,
            kind,
            payload,
        };
        const line = this._serialize(entry);
        this._buffer.push(entry);
        if (this.isPending) {
            // Hold the line until bindSessionPath supplies a real target.
            this._pendingLines.push({ entry, line });
            this._notifyListeners(entry);
            return entry;
        }
        this._enqueueAppend(entry.sessionPath, line, entry);
        this._notifyListeners(entry);
        return entry;
    }

    /**
     * Move the recorder to a concrete session path. Any entries recorded
     * while pending are re-stamped with the bound path (both in-memory in
     * the ring buffer and in the JSONL flush) and appended to the target
     * file in original order. A `recorder_meta { kind: 'session_bind' }`
     * entry is emitted first so the timeline shows the boundary explicitly.
     */
    async bindSessionPath(newSessionPath: string): Promise<void> {
        if (this._closed) return;
        if (!newSessionPath || newSessionPath.startsWith(PENDING_SESSION_PREFIX)) {
            throw new Error(`bindSessionPath requires a concrete path, got ${newSessionPath}`);
        }
        if (this._sessionPath === newSessionPath) return;

        const wasPending = this.isPending;
        const previousPath = this._sessionPath;
        this._sessionPath = newSessionPath;
        // Reflect the new path on every already-buffered pending entry so a
        // snapshot reader sees a consistent sessionPath field.
        if (wasPending) {
            for (const { entry } of this._pendingLines) {
                entry.sessionPath = newSessionPath;
            }
            for (const buffered of this._buffer.snapshot()) {
                buffered.sessionPath = newSessionPath;
            }
        }

        // Emit a visible transition marker BEFORE the flush so replay sees it
        // ahead of the migrated batch.
        const meta: RawRecorderMetaPayload = {
            kind: 'session_bind',
            previousSessionPath: wasPending ? previousPath : undefined,
            boundSessionPath: newSessionPath,
        };
        this.record('recorder_meta', meta);

        if (wasPending && this._pendingLines.length > 0) {
            const pending = this._pendingLines;
            this._pendingLines = [];
            for (const { entry, line } of pending) {
                // Re-serialize so the persisted line reflects the new
                // sessionPath; keep original seq/timestamp/payload.
                const migratedLine = this._serialize(entry);
                this._enqueueAppend(newSessionPath, migratedLine, entry);
                // Buffered listeners already saw these events during record();
                // do not re-emit here.
                // Suppress unused-variable warnings; the destructure needs
                // both fields to keep the source pattern readable.
                void line;
            }
        }
    }

    /**
     * Delete this recorder's persisted stream without closing the live
     * recorder. Capture pauses before draining queued writes, then resumes at
     * sequence zero after deletion so an active chat can start a fresh stream.
     */
    async clearPersistedData(): Promise<void> {
        if (this._closed) {
            await this._storage.deleteSession(this._sessionPath);
            return;
        }
        this._pauseCaptureForDataClear();
        try {
            await this._flushWritesForDataClear();
            await this._storage.deleteSession(this._sessionPath);
            this._resetAfterDataClear();
        } finally {
            this._resumeCaptureAfterDataClear();
        }
    }

    /** Registry-only coordination for an atomic clear across live recorders. */
    _pauseCaptureForDataClear(): void {
        this._capturePaused = true;
    }

    /** Registry-only coordination for an atomic clear across live recorders. */
    async _flushWritesForDataClear(): Promise<void> {
        try {
            await this._writeChain;
        } catch {
            // Storage errors are already surfaced as recorder metadata.
        }
    }

    /** Registry-only coordination for an atomic clear across live recorders. */
    _resetAfterDataClear(): void {
        this._buffer.clear();
        this._pendingLines = [];
        this._nextSeq = 0;
    }

    /** Registry-only coordination for an atomic clear across live recorders. */
    _resumeCaptureAfterDataClear(): void {
        if (!this._closed) this._capturePaused = false;
    }

    /**
     * Idempotent shutdown. Flushes the outstanding write chain and stops
     * accepting further records.
     */
    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        try {
            await this._writeChain;
        } catch {
            // Errors already surfaced via recorder_meta / logger.
        }
    }

    private _serialize(entry: RawEntry): string {
        try {
            return JSON.stringify(entry);
        } catch (error) {
            // Payload contains something JSON.stringify cannot handle
            // (BigInt, circular ref, DOM node). Persist a structural
            // best-effort replacement so the recording keeps advancing.
            const reason = error instanceof Error ? error.message : String(error);
            const fallback = {
                ...entry,
                payload: { rawmodeSerializationError: reason },
            };
            return JSON.stringify(fallback);
        }
    }

    private _enqueueAppend(sessionPath: string, line: string, entry: RawEntry): void {
        this._writeChain = this._writeChain.then(async () => {
            try {
                await this._storage.append(sessionPath, line);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this._logger?.appendLine(`RawRecorder append failed (${sessionPath} seq=${entry.seq}): ${message}`);
                // Do not recursively persist. Just push an in-memory marker
                // so the ring / listeners see the failure. If we called
                // record('recorder_meta', ...) here it would re-enter the
                // write chain with the same broken adapter.
                const markerSeq = this._nextSeq++;
                const marker: RawEntry = {
                    seq: markerSeq,
                    timestampMs: this._now(),
                    sessionPath,
                    kind: 'recorder_meta',
                    payload: {
                        kind: 'recorder_error',
                        message,
                        where: `append(seq=${entry.seq})`,
                    } satisfies RawRecorderMetaPayload,
                };
                this._buffer.push(marker);
                this._notifyListeners(marker);
            }
        });
    }

    private _notifyListeners(entry: RawEntry): void {
        for (const listener of this._listeners) {
            try {
                listener(entry);
            } catch {
                // Listener errors must not stall the recorder. Any consumer
                // that throws here is buggy; swallow so the write chain
                // stays healthy.
            }
        }
    }

    private _defaultPendingId(): string {
        // Not cryptographic — just distinct enough per recorder instance.
        const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        return `${this._now().toString(36)}-${rand}`;
    }
}

/**
 * Process-wide registry of live recorders indexed by sessionPath. The
 * Pi session lifecycle populates this so that RawPanel instances can
 * look up their recorder without traversing controllers.
 */
export class RawRecorderRegistry {
    private readonly _byPath = new Map<string, RawRecorder>();
    private readonly _mountListeners = new Set<(recorder: RawRecorder) => void>();
    private readonly _dataClearedListeners = new Set<(sessionPath: string) => void>();
    private _dataClearChain: Promise<void> = Promise.resolve();

    get(sessionPath: string): RawRecorder | undefined {
        return this._byPath.get(sessionPath);
    }

    all(): RawRecorder[] {
        return [...this._byPath.values()];
    }

    /**
     * Register a recorder under its current sessionPath. Re-registers when
     * the recorder's sessionPath changes via `bindSessionPath` — call
     * `rebind` explicitly after each bind.
     */
    register(recorder: RawRecorder): void {
        this._byPath.set(recorder.sessionPath, recorder);
        for (const listener of this._mountListeners) {
            try { listener(recorder); } catch { /* ignore listener errors */ }
        }
    }

    /**
     * Update the registry entry when a recorder migrates from a pending
     * key to a concrete session path.
     */
    rebind(previousSessionPath: string, recorder: RawRecorder): void {
        if (previousSessionPath !== recorder.sessionPath) {
            this._byPath.delete(previousSessionPath);
        }
        this._byPath.set(recorder.sessionPath, recorder);
    }

    /**
     * Detach the recorder for a session. The persisted JSONL is untouched —
     * this only ends live streaming for the current session activation.
     */
    async dispose(sessionPath: string): Promise<void> {
        const recorder = this._byPath.get(sessionPath);
        if (!recorder) return;
        this._byPath.delete(sessionPath);
        await recorder.close();
    }

    /** Delete one stream without disposing its active recorder. */
    clearSessionData(storage: RawStoragePort, sessionPath: string): Promise<void> {
        return this._enqueueDataClear(async () => {
            const recorder = this.get(sessionPath);
            if (recorder) {
                await recorder.clearPersistedData();
            } else {
                await storage.deleteSession(sessionPath);
            }
        });
    }

    /**
     * Atomically clear all Raw Mode storage while keeping every live recorder
     * mounted. Capture is paused across the whole registry so no append can
     * race the directory removal; each recorder resumes from sequence zero.
     */
    clearAllData(storage: RawStoragePort): Promise<void> {
        return this._enqueueDataClear(async () => {
            const recorders = this.all();
            for (const recorder of recorders) recorder._pauseCaptureForDataClear();
            try {
                await Promise.all(recorders.map((recorder) => recorder._flushWritesForDataClear()));
                await storage.clearAll();
                for (const recorder of recorders) recorder._resetAfterDataClear();
            } finally {
                for (const recorder of recorders) recorder._resumeCaptureAfterDataClear();
            }
        });
    }

    private _enqueueDataClear(operation: () => Promise<void>): Promise<void> {
        const run = this._dataClearChain.then(operation, operation);
        this._dataClearChain = run.catch(() => undefined);
        return run;
    }

    onMount(listener: (recorder: RawRecorder) => void): () => void {
        this._mountListeners.add(listener);
        return () => this._mountListeners.delete(listener);
    }

    /**
     * Fire when the persisted JSONL for a session is destroyed (Clear or
     * Delete-from-history). RawPanels bound to that path should close
     * themselves — the data is gone.
     */
    notifyDataCleared(sessionPath: string): void {
        for (const listener of this._dataClearedListeners) {
            try { listener(sessionPath); } catch { /* ignore listener errors */ }
        }
    }

    onDataCleared(listener: (sessionPath: string) => void): () => void {
        this._dataClearedListeners.add(listener);
        return () => this._dataClearedListeners.delete(listener);
    }
}
