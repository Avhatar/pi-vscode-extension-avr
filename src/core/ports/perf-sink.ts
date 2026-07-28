/**
 * Sink port for {@link PerfLogger}. Receives already-serialised JSONL lines
 * (without trailing newline) and appends them to durable storage.
 *
 * Kept separate from the logger so the logger itself remains portable and
 * synchronous while the adapter handles IO buffering.
 */
export interface PerfSink {
    /** Append one JSONL record. Adapters may buffer; caller does not await. */
    write(line: string): void;
    /** Flush any pending writes to storage. Called on activation completion and dispose. */
    flush(): Promise<void>;
    /** Close underlying resources. Idempotent. */
    close(): Promise<void>;
}
