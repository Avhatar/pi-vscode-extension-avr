import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NodeRawStorage } from '../../../../adapters/vscode/raw-storage';
import type { RawEntry } from '../../../../shared/raw-protocol';

function serialize(entry: RawEntry): string {
    return JSON.stringify(entry);
}

async function makeSessionFile(dir: string, name: string): Promise<string> {
    const p = path.join(dir, name);
    await fs.writeFile(p, '', 'utf8');
    return p;
}

describe('NodeRawStorage', () => {
    let tmp: string;
    let sessionsDir: string;
    let storage: NodeRawStorage;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-storage-'));
        sessionsDir = path.join(tmp, 'sessions');
        await fs.mkdir(sessionsDir, { recursive: true });
        storage = new NodeRawStorage(tmp);
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('appends JSONL lines and reads them back in seq order', async () => {
        const sess = await makeSessionFile(sessionsDir, 'a.jsonl');
        const entries: RawEntry[] = [];
        for (let i = 0; i < 5; i++) {
            const e: RawEntry = { seq: i, timestampMs: 1000 + i, sessionPath: sess, kind: 'agent_start', payload: { i } };
            entries.push(e);
            await storage.append(sess, serialize(e));
        }
        const { entries: read, hasMore } = await storage.readRange(sess, 0, 100);
        expect(read.map(e => e.seq)).toEqual([0, 1, 2, 3, 4]);
        expect(hasMore).toBe(false);
    });

    it('readRange respects count and hasMore', async () => {
        const sess = await makeSessionFile(sessionsDir, 'b.jsonl');
        for (let i = 0; i < 5; i++) {
            const e: RawEntry = { seq: i, timestampMs: i, sessionPath: sess, kind: 'agent_start', payload: {} };
            await storage.append(sess, serialize(e));
        }
        const page1 = await storage.readRange(sess, 0, 3);
        expect(page1.entries.map(e => e.seq)).toEqual([0, 1, 2]);
        expect(page1.hasMore).toBe(true);
        expect(page1.nextSeq).toBe(3);
        const page2 = await storage.readRange(sess, page1.nextSeq, 3);
        expect(page2.entries.map(e => e.seq)).toEqual([3, 4]);
        expect(page2.hasMore).toBe(false);
    });

    it('readRange returns empty when session is unknown', async () => {
        const missing = path.join(sessionsDir, 'ghost.jsonl');
        const res = await storage.readRange(missing, 0, 10);
        expect(res.entries).toEqual([]);
        expect(res.hasMore).toBe(false);
    });

    it('getNextSeq returns 0 for empty, and last+1 after appends', async () => {
        const sess = await makeSessionFile(sessionsDir, 'c.jsonl');
        expect(await storage.getNextSeq(sess)).toBe(0);
        await storage.append(sess, serialize({
            seq: 0, timestampMs: 1, sessionPath: sess, kind: 'agent_start', payload: {},
        }));
        await storage.append(sess, serialize({
            seq: 1, timestampMs: 2, sessionPath: sess, kind: 'turn_start', payload: {},
        }));
        expect(await storage.getNextSeq(sess)).toBe(2);
    });

    it('getNextSeq continues numbering across storage instances (JSONL is authoritative)', async () => {
        const sess = await makeSessionFile(sessionsDir, 'd.jsonl');
        await storage.append(sess, serialize({
            seq: 0, timestampMs: 1, sessionPath: sess, kind: 'agent_start', payload: {},
        }));
        await storage.append(sess, serialize({
            seq: 1, timestampMs: 2, sessionPath: sess, kind: 'turn_start', payload: {},
        }));
        const storage2 = new NodeRawStorage(tmp);
        expect(await storage2.getNextSeq(sess)).toBe(2);
    });

    it('list summarizes every known session sorted by lastActivity desc', async () => {
        const sessA = await makeSessionFile(sessionsDir, 'A.jsonl');
        const sessB = await makeSessionFile(sessionsDir, 'B.jsonl');
        await storage.append(sessA, serialize({
            seq: 0, timestampMs: 100, sessionPath: sessA, kind: 'agent_start', payload: {},
        }));
        await storage.append(sessA, serialize({
            seq: 1, timestampMs: 200, sessionPath: sessA, kind: 'turn_start', payload: {},
        }));
        await storage.append(sessB, serialize({
            seq: 0, timestampMs: 300, sessionPath: sessB, kind: 'agent_start', payload: {},
        }));
        const summaries = await storage.list();
        expect(summaries.length).toBe(2);
        expect(summaries[0]!.sessionPath).toBe(sessB);
        expect(summaries[0]!.entryCount).toBe(1);
        expect(summaries[0]!.lastEntryAtMs).toBe(300);
        expect(summaries[1]!.sessionPath).toBe(sessA);
        expect(summaries[1]!.entryCount).toBe(2);
        expect(summaries[1]!.firstEntryAtMs).toBe(100);
        expect(summaries[1]!.lastEntryAtMs).toBe(200);
    });

    it('flags summaries as orphaned when the Pi session file is gone', async () => {
        const sess = await makeSessionFile(sessionsDir, 'E.jsonl');
        await storage.append(sess, serialize({
            seq: 0, timestampMs: 1, sessionPath: sess, kind: 'agent_start', payload: {},
        }));
        await fs.rm(sess);
        const [summary] = await storage.list();
        expect(summary!.orphaned).toBe(true);
        expect(summary!.sessionPath).toBe(sess);
    });

    it('deleteSession removes JSONL + meta and prunes the manifest', async () => {
        const sess = await makeSessionFile(sessionsDir, 'F.jsonl');
        await storage.append(sess, serialize({
            seq: 0, timestampMs: 1, sessionPath: sess, kind: 'agent_start', payload: {},
        }));
        const file = await storage.getSessionFile(sess);
        expect(file).toBeTruthy();
        await fs.access(file!);
        await storage.deleteSession(sess);
        await expect(fs.access(file!)).rejects.toBeTruthy();
        expect(await storage.list()).toEqual([]);
        expect(await storage.getSessionFile(sess)).toBeUndefined();
    });

    it('clearAll drops the whole raw folder and reinitializes on next append', async () => {
        const sessA = await makeSessionFile(sessionsDir, 'G.jsonl');
        const sessB = await makeSessionFile(sessionsDir, 'H.jsonl');
        for (const p of [sessA, sessB]) {
            await storage.append(p, serialize({
                seq: 0, timestampMs: 1, sessionPath: p, kind: 'agent_start', payload: {},
            }));
        }
        await storage.clearAll();
        await expect(fs.access(storage.getStorageDir())).rejects.toBeTruthy();
        expect(await storage.list()).toEqual([]);
        // Reappend after clear: adapter should recreate the folder.
        await storage.append(sessA, serialize({
            seq: 0, timestampMs: 1, sessionPath: sessA, kind: 'agent_start', payload: {},
        }));
        const roundTrip = await storage.readRange(sessA, 0, 10);
        expect(roundTrip.entries.length).toBe(1);
    });

    it('hashes long or exotic sessionPath values into fixed-length filenames', async () => {
        const evil = path.join(sessionsDir, 'weird 空 ✓ 名.jsonl');
        await makeSessionFile(sessionsDir, 'weird 空 ✓ 名.jsonl');
        await storage.append(evil, serialize({
            seq: 0, timestampMs: 1, sessionPath: evil, kind: 'agent_start', payload: {},
        }));
        const files = await fs.readdir(storage.getStorageDir());
        const jsonl = files.find(f => f.endsWith('.jsonl'));
        expect(jsonl).toBeDefined();
        // Filename should be 32-char hex + .jsonl, not the original path.
        expect(jsonl!.replace(/\.jsonl$/, '')).toMatch(/^[0-9a-f]{32}$/);
    });

    it('storageDir is exposed and stable', () => {
        expect(storage.getStorageDir()).toBe(path.join(tmp, 'raw'));
    });
});
