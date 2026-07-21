import { describe, it, expect } from 'vitest';
import type {
    RawEntry,
    RawClientMessage,
    RawServerMessage,
    RawStorageStats,
    RawSessionSummary,
    RawModeSettingsClientMessage,
    RawModeSettingsServerMessage,
} from '../../../shared/raw-protocol';
import { RAW_HARNESS_EVENT_KINDS, RAW_SESSION_ONLY_EVENT_KINDS } from '../../../shared/raw-protocol';
import type { SettingsClientMessage, SettingsServerMessage } from '../../../shared/protocol';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

describe('Raw protocol types', () => {
    it('enumerates harness-level and session-only event kinds without overlap or duplicates', () => {
        const harness = new Set<string>(RAW_HARNESS_EVENT_KINDS);
        const sessionOnly = new Set<string>(RAW_SESSION_ONLY_EVENT_KINDS);
        // No duplicates within each list.
        expect(harness.size).toBe(RAW_HARNESS_EVENT_KINDS.length);
        expect(sessionOnly.size).toBe(RAW_SESSION_ONLY_EVENT_KINDS.length);
        // The session-only list must not overlap with the harness list; that is
        // the entire reason it exists.
        for (const kind of sessionOnly) {
            expect(harness.has(kind)).toBe(false);
        }
    });

    it('round-trips a RawEntry losslessly through JSON', () => {
        const entry: RawEntry = {
            seq: 42,
            timestampMs: 1_700_000_000_000,
            sessionPath: '/home/user/.pi/sessions/abc.jsonl',
            kind: 'before_provider_payload',
            payload: {
                model: 'claude-4.7',
                messages: [{ role: 'user', content: 'hello' }],
                headers: { authorization: 'Bearer sk-do-not-redact' },
            },
        };
        const round = JSON.parse(JSON.stringify(entry)) as RawEntry;
        expect(round).toEqual(entry);
    });

    it('accepts arbitrary payload shapes without narrowing', () => {
        const scalars: RawEntry[] = [
            { seq: 1, timestampMs: 1, sessionPath: 's', kind: 'stream_chunk', payload: 'text' },
            { seq: 2, timestampMs: 2, sessionPath: 's', kind: 'stream_chunk', payload: 12345 },
            { seq: 3, timestampMs: 3, sessionPath: 's', kind: 'stream_chunk', payload: null },
            { seq: 4, timestampMs: 4, sessionPath: 's', kind: 'stream_chunk', payload: [1, 'x'] },
        ];
        for (const e of scalars) {
            expect(JSON.parse(JSON.stringify(e))).toEqual(e);
        }
    });

    it('client/server message unions serialize by discriminator', () => {
        const clients: RawClientMessage[] = [
            { type: 'raw.subscribe', sessionPath: '/s.jsonl' },
            { type: 'raw.unsubscribe', sessionPath: '/s.jsonl' },
            { type: 'raw.loadRange', sessionPath: '/s.jsonl', fromSeq: 0, count: 100 },
            { type: 'raw.requestCopy', sessionPath: '/s.jsonl' },
            { type: 'raw.requestSaveAs', sessionPath: '/s.jsonl' },
            { type: 'raw.revealStorage' },
        ];
        const servers: RawServerMessage[] = [
            { type: 'raw.snapshot', sessionPath: '/s.jsonl', entries: [], hasMore: false, nextSeq: 0 },
            {
                type: 'raw.append',
                sessionPath: '/s.jsonl',
                entry: { seq: 1, timestampMs: 0, sessionPath: '/s.jsonl', kind: 'agent_start', payload: {} },
            },
            { type: 'raw.range', sessionPath: '/s.jsonl', entries: [], hasMore: true, nextSeq: 500 },
            { type: 'raw.sessionInfo', sessionPath: '/s.jsonl', displayTitle: 'Chat A', orphaned: false },
            { type: 'raw.copyDone', sessionPath: '/s.jsonl', ok: true },
            { type: 'raw.saveAsDone', sessionPath: '/s.jsonl', ok: false, message: 'cancelled' },
        ];
        for (const msg of clients) {
            expect(JSON.parse(JSON.stringify(msg)).type).toBe(msg.type);
        }
        for (const msg of servers) {
            expect(JSON.parse(JSON.stringify(msg)).type).toBe(msg.type);
        }
    });

    it('storage summary and stats round-trip losslessly', () => {
        const summary: RawSessionSummary = {
            sessionPath: '/s1.jsonl',
            displayTitle: 'Auth refactor',
            entryCount: 128,
            sizeBytes: 4096,
            firstEntryAtMs: 1_700_000_000_000,
            lastEntryAtMs: 1_700_000_600_000,
            orphaned: false,
        };
        const stats: RawStorageStats = {
            sessions: [summary],
            totalEntries: 128,
            totalSizeBytes: 4096,
            storageDir: '/var/tmp/raw',
        };
        expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
    });

    it('RawMode messages join the SettingsClientMessage/SettingsServerMessage unions', () => {
        const clientRaw: RawModeSettingsClientMessage = { type: 'rawMode.getStats' };
        const serverRaw: RawModeSettingsServerMessage = {
            type: 'rawMode.stats',
            stats: { sessions: [], totalEntries: 0, totalSizeBytes: 0, storageDir: '/x' },
        };
        const client: SettingsClientMessage = clientRaw;
        const server: SettingsServerMessage = serverRaw;
        expect(client.type).toBe('rawMode.getStats');
        expect(server.type).toBe('rawMode.stats');
    });

    it('RawMode client union enumerates every intended action', () => {
        type Actions = RawModeSettingsClientMessage['type'];
        type Expected = 'rawMode.getStats' | 'rawMode.clearAll' | 'rawMode.clearSession'
            | 'rawMode.revealStorage' | 'rawMode.openView';
        const check: Expect<Equal<Actions, Expected>> = true;
        expect(check).toBe(true);
    });
});
