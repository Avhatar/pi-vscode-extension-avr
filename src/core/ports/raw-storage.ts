import type { RawEntry, RawSessionSummary } from '../../shared/raw-protocol';

/**
 * Portable storage contract for the RawMode recorder.
 *
 * The recorder pushes each entry as one JSONL line via {@link append}; the
 * RawMode panel and Settings block read historical entries via
 * {@link readRange}. The extension host provides a concrete Node adapter
 * (see `src/adapters/vscode/raw-storage.ts`); other embeddings may
 * implement the port differently (e.g. IndexedDB in the browser).
 */
export interface RawStoragePort {
    /**
     * Append one already-serialized JSONL line for a given session file. The
     * line is provided by the recorder without a trailing newline; the adapter
     * is responsible for terminator handling (LF only, no CRLF).
     */
    append(sessionPath: string, line: string): Promise<void>;

    /**
     * Read up to {@link count} entries starting from {@link fromSeq}. When
     * {@link fromSeq} is 0 the very first entry is included. `hasMore` is
     * true when at least one entry exists past `nextSeq`.
     */
    readRange(
        sessionPath: string,
        fromSeq: number,
        count: number,
    ): Promise<{ entries: RawEntry[]; hasMore: boolean; nextSeq: number }>;

    /**
     * Return the smallest unused `seq` for a session (i.e. one past the last
     * persisted entry). Returns 0 when the session has no entries yet. Used to
     * continue numbering across host restarts.
     */
    getNextSeq(sessionPath: string): Promise<number>;

    /**
     * Enumerate all sessions that have any persisted entries.
     */
    list(): Promise<RawSessionSummary[]>;

    /**
     * Remove all persisted entries for a session, including any sidecar
     * metadata. No-op when the session is unknown.
     */
    deleteSession(sessionPath: string): Promise<void>;

    /**
     * Remove every raw file. Used by the "Clear All Raw Data" action.
     */
    clearAll(): Promise<void>;

    /**
     * Return the absolute filesystem path (or opaque identifier for
     * non-filesystem adapters) of the storage root. Displayed in Settings.
     */
    getStorageDir(): string;

    /**
     * Return the concrete path of the JSONL file backing a session, when
     * the adapter exposes files. Used by "Save As" and "Reveal in File
     * Explorer" actions. May return `undefined` if the adapter is not
     * file-backed or the session has no entries.
     */
    getSessionFile?(sessionPath: string): Promise<string | undefined>;
}
