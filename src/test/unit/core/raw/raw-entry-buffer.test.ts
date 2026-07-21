import { describe, it, expect } from 'vitest';
import { RawEntryBuffer, DEFAULT_RAW_BUFFER_CAPACITY } from '../../../../core/raw/raw-entry-buffer';
import type { RawEntry } from '../../../../shared/raw-protocol';

function makeEntry(seq: number, kind: RawEntry['kind'] = 'agent_start'): RawEntry {
    return { seq, timestampMs: seq, sessionPath: '/s.jsonl', kind, payload: { seq } };
}

describe('RawEntryBuffer', () => {
    it('rejects non-positive capacity', () => {
        expect(() => new RawEntryBuffer(0)).toThrow();
        expect(() => new RawEntryBuffer(-3)).toThrow();
        expect(() => new RawEntryBuffer(1.5)).toThrow();
    });

    it('defaults to 5000 capacity', () => {
        const buf = new RawEntryBuffer();
        expect(buf.capacity).toBe(DEFAULT_RAW_BUFFER_CAPACITY);
        expect(buf.capacity).toBe(5000);
    });

    it('preserves insertion order in snapshot()', () => {
        const buf = new RawEntryBuffer(10);
        for (let i = 0; i < 5; i++) buf.push(makeEntry(i));
        expect(buf.snapshot().map(e => e.seq)).toEqual([0, 1, 2, 3, 4]);
        expect(buf.size()).toBe(5);
    });

    it('evicts oldest entries when capacity is exceeded (FIFO ring)', () => {
        const buf = new RawEntryBuffer(3);
        buf.push(makeEntry(1));
        buf.push(makeEntry(2));
        buf.push(makeEntry(3));
        buf.push(makeEntry(4));
        buf.push(makeEntry(5));
        expect(buf.snapshot().map(e => e.seq)).toEqual([3, 4, 5]);
        expect(buf.size()).toBe(3);
    });

    it('entriesSince returns only entries with seq strictly greater than fromSeq', () => {
        const buf = new RawEntryBuffer(10);
        for (let i = 1; i <= 5; i++) buf.push(makeEntry(i));
        expect(buf.entriesSince(0).map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(buf.entriesSince(2).map(e => e.seq)).toEqual([3, 4, 5]);
        expect(buf.entriesSince(5).map(e => e.seq)).toEqual([]);
        expect(buf.entriesSince(100).map(e => e.seq)).toEqual([]);
    });

    it('latestSeq reflects the newest buffered entry', () => {
        const buf = new RawEntryBuffer(10);
        expect(buf.latestSeq()).toBeUndefined();
        buf.push(makeEntry(7));
        expect(buf.latestSeq()).toBe(7);
        buf.push(makeEntry(8));
        expect(buf.latestSeq()).toBe(8);
    });

    it('clear empties the buffer', () => {
        const buf = new RawEntryBuffer(3);
        buf.push(makeEntry(1));
        buf.push(makeEntry(2));
        buf.clear();
        expect(buf.size()).toBe(0);
        expect(buf.snapshot()).toEqual([]);
        expect(buf.latestSeq()).toBeUndefined();
    });
});
