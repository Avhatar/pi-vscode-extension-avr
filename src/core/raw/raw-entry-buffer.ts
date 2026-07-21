import type { RawEntry } from '../../shared/raw-protocol';

export const DEFAULT_RAW_BUFFER_CAPACITY = 5000;

/**
 * Fixed-capacity ring buffer for the most recent {@link RawEntry} instances.
 *
 * The buffer is used to serve `raw.snapshot` messages to newly attached
 * panels without hitting disk for the recent tail. Older entries are read
 * from the storage adapter on demand.
 *
 * Semantics:
 *   - inserts preserve chronological order of `seq`;
 *   - `snapshot()` and `entriesSince()` return newest-last ordering (the
 *     natural order in which entries were pushed);
 *   - when the buffer is full, pushing a new entry evicts the oldest one
 *     (classic FIFO ring).
 */
export class RawEntryBuffer {
    private readonly _entries: RawEntry[] = [];

    constructor(private readonly _capacity: number = DEFAULT_RAW_BUFFER_CAPACITY) {
        if (!Number.isInteger(_capacity) || _capacity <= 0) {
            throw new Error(`RawEntryBuffer capacity must be a positive integer, got ${_capacity}`);
        }
    }

    get capacity(): number {
        return this._capacity;
    }

    size(): number {
        return this._entries.length;
    }

    push(entry: RawEntry): void {
        this._entries.push(entry);
        if (this._entries.length > this._capacity) {
            // Trim from the head. `shift()` is fine for the sizes we expect
            // (thousands, not millions); a proper ring index buys nothing
            // measurable here and complicates snapshot/range logic.
            this._entries.splice(0, this._entries.length - this._capacity);
        }
    }

    /** Copy of all buffered entries, newest last. */
    snapshot(): RawEntry[] {
        return this._entries.slice();
    }

    /**
     * Return every buffered entry whose `seq` is strictly greater than
     * {@link fromSeq}. Used when a panel resumes streaming after a
     * temporary detach.
     */
    entriesSince(fromSeq: number): RawEntry[] {
        // Entries are appended in seq order, so we can slice from the first
        // matching position rather than scanning the whole buffer.
        for (let i = 0; i < this._entries.length; i++) {
            if (this._entries[i]!.seq > fromSeq) {
                return this._entries.slice(i);
            }
        }
        return [];
    }

    /**
     * Highest `seq` currently in the buffer, or `undefined` if empty. Used
     * by callers to reason about the buffer/storage boundary.
     */
    latestSeq(): number | undefined {
        if (this._entries.length === 0) return undefined;
        return this._entries[this._entries.length - 1]!.seq;
    }

    clear(): void {
        this._entries.length = 0;
    }
}
