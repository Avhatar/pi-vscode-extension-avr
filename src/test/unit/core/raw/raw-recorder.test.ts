import { describe, it, expect, beforeEach } from 'vitest';
import { RawRecorder, RawRecorderRegistry, PENDING_SESSION_PREFIX } from '../../../../core/raw/raw-recorder';
import type { RawStoragePort } from '../../../../core/ports/raw-storage';
import type { RawEntry, RawSessionSummary } from '../../../../shared/raw-protocol';

class MemoryStorage implements RawStoragePort {
    lines = new Map<string, string[]>();
    appendCalls: Array<{ sessionPath: string; line: string }> = [];
    /** Optional injected failure for one specific append. */
    failOnce?: string;

    async append(sessionPath: string, line: string): Promise<void> {
        this.appendCalls.push({ sessionPath, line });
        if (this.failOnce && this.failOnce === sessionPath) {
            this.failOnce = undefined;
            throw new Error('injected storage failure');
        }
        const arr = this.lines.get(sessionPath) ?? [];
        arr.push(line);
        this.lines.set(sessionPath, arr);
    }
    async readRange(sessionPath: string, fromSeq: number, count: number) {
        const parsed = (this.lines.get(sessionPath) ?? []).map(l => JSON.parse(l) as RawEntry);
        const start = parsed.findIndex(e => e.seq >= fromSeq);
        const slice = start === -1 ? [] : parsed.slice(start, start + count);
        const hasMore = start !== -1 && start + count < parsed.length;
        const nextSeq = hasMore ? parsed[start + count]!.seq : (parsed.at(-1)?.seq ?? -1) + 1;
        return { entries: slice, hasMore, nextSeq };
    }
    async getNextSeq(sessionPath: string): Promise<number> {
        const arr = this.lines.get(sessionPath) ?? [];
        if (arr.length === 0) return 0;
        const last = JSON.parse(arr.at(-1)!) as RawEntry;
        return last.seq + 1;
    }
    async list(): Promise<RawSessionSummary[]> { return []; }
    async deleteSession(sessionPath: string): Promise<void> { this.lines.delete(sessionPath); }
    async clearAll(): Promise<void> { this.lines.clear(); }
    getStorageDir(): string { return '/mem'; }
}

class FrozenClock {
    private _t = 1_000_000;
    now = (): number => ++this._t;
}

describe('RawRecorder', () => {
    let storage: MemoryStorage;
    let clock: FrozenClock;
    beforeEach(() => {
        storage = new MemoryStorage();
        clock = new FrozenClock();
    });

    it('assigns monotonically increasing seq starting from initialSeq', () => {
        const rec = new RawRecorder({
            storage, now: clock.now, sessionPath: '/s.jsonl', initialSeq: 10,
        });
        const a = rec.record('agent_start', { hello: 'world' });
        const b = rec.record('turn_start', { turn: 1 });
        expect(a.seq).toBe(10);
        expect(b.seq).toBe(11);
        expect(rec.nextSeq).toBe(12);
    });

    it('persists entries as JSONL lines in call order', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        rec.record('agent_start', { a: 1 });
        rec.record('turn_start', { t: 1 });
        rec.record('turn_end', { t: 1 });
        await rec.close();
        const lines = storage.lines.get('/s.jsonl')!;
        expect(lines.map(l => JSON.parse(l).kind)).toEqual(['agent_start', 'turn_start', 'turn_end']);
        // Every persisted line JSON.parses to the same object shape as the returned entry.
        for (const l of lines) {
            const parsed = JSON.parse(l) as RawEntry;
            expect(parsed.sessionPath).toBe('/s.jsonl');
            expect(typeof parsed.seq).toBe('number');
            expect(typeof parsed.timestampMs).toBe('number');
        }
    });

    it('emits listener notifications after record()', () => {
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        const received: RawEntry[] = [];
        rec.onEntry(e => received.push(e));
        rec.record('agent_start', {});
        rec.record('turn_start', {});
        expect(received.map(e => e.kind)).toEqual(['agent_start', 'turn_start']);
    });

    it('starts pending when no sessionPath given and flushes to concrete file on bind', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, pendingId: 'test' });
        expect(rec.isPending).toBe(true);
        expect(rec.sessionPath).toBe(`${PENDING_SESSION_PREFIX}test`);
        rec.record('agent_start', { pre: 'bind' });
        rec.record('turn_start', { pre: 'bind' });
        // Nothing hits storage yet.
        expect(storage.appendCalls.length).toBe(0);

        await rec.bindSessionPath('/real.jsonl');
        await rec.close();

        expect(rec.isPending).toBe(false);
        // session_bind meta + 2 migrated entries.
        const lines = storage.lines.get('/real.jsonl')!;
        expect(lines.length).toBe(3);
        const kinds = lines.map(l => JSON.parse(l).kind);
        // The recorder_meta { session_bind } is emitted between the buffered
        // entries and the migrated flush, so its seq is 2 (after the two
        // pre-bind entries). Persisted order is: migrated pending entries
        // (seq 0, 1) then the session_bind marker (seq 2)? Actually the
        // recorder emits the marker via record() which appends to the new
        // path immediately — so persisted order is [session_bind, migrated0,
        // migrated1]. Verify that ordering.
        expect(kinds).toEqual(['recorder_meta', 'agent_start', 'turn_start']);
        // All persisted lines carry the bound sessionPath.
        for (const l of lines) {
            expect((JSON.parse(l) as RawEntry).sessionPath).toBe('/real.jsonl');
        }
    });

    it('rewrites the sessionPath on already-buffered entries after bind', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, pendingId: 't2' });
        rec.record('agent_start', {});
        await rec.bindSessionPath('/final.jsonl');
        const snap = rec.snapshot();
        for (const e of snap) {
            expect(e.sessionPath).toBe('/final.jsonl');
        }
    });

    it('rejects non-concrete bindings', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, pendingId: 't3' });
        await expect(rec.bindSessionPath('')).rejects.toThrow();
        await expect(rec.bindSessionPath('pending:x')).rejects.toThrow();
    });

    it('captures storage failure as a recorder_error marker without throwing', async () => {
        storage.failOnce = '/s.jsonl';
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        const received: RawEntry[] = [];
        rec.onEntry(e => received.push(e));
        rec.record('agent_start', {});
        await rec.close();
        const markers = received.filter(e => e.kind === 'recorder_meta');
        expect(markers.length).toBe(1);
        const payload = markers[0]!.payload as { kind: string; message: string; where: string };
        expect(payload.kind).toBe('recorder_error');
        expect(payload.message).toMatch(/injected/);
    });

    it('drops record() after close() without throwing', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        rec.record('agent_start', {});
        await rec.close();
        expect(() => rec.record('turn_start', {})).not.toThrow();
        // Second close is a no-op.
        await rec.close();
    });

    it('handles unserializable payloads via a fallback structure', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        const circular: any = { a: 1 };
        circular.self = circular;
        rec.record('agent_start', circular);
        await rec.close();
        const line = storage.lines.get('/s.jsonl')![0]!;
        const parsed = JSON.parse(line) as RawEntry;
        expect((parsed.payload as any).rawmodeSerializationError).toBeTypeOf('string');
    });

    it('clears persisted data without closing the active recorder', async () => {
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        rec.record('agent_start', { before: true });
        await rec.clearPersistedData();

        expect(storage.lines.has('/s.jsonl')).toBe(false);
        const resumed = rec.record('turn_start', { after: true });
        await rec.close();

        expect(resumed.seq).toBe(0);
        expect((storage.lines.get('/s.jsonl') ?? []).map(line => JSON.parse(line).kind))
            .toEqual(['turn_start']);
    });

    it('entriesSince skips already-seen entries', () => {
        const rec = new RawRecorder({ storage, now: clock.now, sessionPath: '/s.jsonl' });
        const e1 = rec.record('agent_start', {});
        const e2 = rec.record('turn_start', {});
        const e3 = rec.record('turn_end', {});
        expect(rec.entriesSince(e1.seq).map(e => e.seq)).toEqual([e2.seq, e3.seq]);
    });
});

describe('RawRecorderRegistry', () => {
    it('registers, rebinds, and disposes recorders', async () => {
        const registry = new RawRecorderRegistry();
        const storage = new MemoryStorage();
        const rec = new RawRecorder({ storage, pendingId: 'a' });
        registry.register(rec);
        expect(registry.get(rec.sessionPath)).toBe(rec);
        const prev = rec.sessionPath;
        await rec.bindSessionPath('/final.jsonl');
        registry.rebind(prev, rec);
        expect(registry.get(prev)).toBeUndefined();
        expect(registry.get('/final.jsonl')).toBe(rec);
        await registry.dispose('/final.jsonl');
        expect(registry.get('/final.jsonl')).toBeUndefined();
    });

    it('clears all persisted data while keeping live recorders registered', async () => {
        const registry = new RawRecorderRegistry();
        const storage = new MemoryStorage();
        const first = new RawRecorder({ storage, sessionPath: '/first.jsonl' });
        const second = new RawRecorder({ storage, sessionPath: '/second.jsonl' });
        registry.register(first);
        registry.register(second);
        first.record('agent_start', {});
        second.record('agent_start', {});

        await registry.clearAllData(storage);
        expect(storage.lines.size).toBe(0);
        expect(registry.get('/first.jsonl')).toBe(first);
        expect(registry.get('/second.jsonl')).toBe(second);

        expect(first.record('turn_start', {}).seq).toBe(0);
        expect(second.record('turn_start', {}).seq).toBe(0);
        await first.close();
        await second.close();
    });

    it('serializes overlapping per-session and clear-all requests', async () => {
        const registry = new RawRecorderRegistry();
        const storage = new MemoryStorage();
        const rec = new RawRecorder({ storage, sessionPath: '/first.jsonl' });
        registry.register(rec);
        rec.record('agent_start', {});

        await Promise.all([
            registry.clearAllData(storage),
            registry.clearSessionData(storage, '/first.jsonl'),
        ]);

        expect(registry.get('/first.jsonl')).toBe(rec);
        expect(rec.record('turn_start', {}).seq).toBe(0);
        await rec.close();
        expect((storage.lines.get('/first.jsonl') ?? []).map(line => JSON.parse(line).seq))
            .toEqual([0]);
    });

    it('fires mount listeners on register', () => {
        const registry = new RawRecorderRegistry();
        const storage = new MemoryStorage();
        const seen: string[] = [];
        registry.onMount(r => seen.push(r.sessionPath));
        const rec = new RawRecorder({ storage, sessionPath: '/x.jsonl' });
        registry.register(rec);
        expect(seen).toEqual(['/x.jsonl']);
    });
});
