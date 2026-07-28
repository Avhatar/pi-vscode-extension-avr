import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { RawStoragePort } from '../../core/ports/raw-storage';
import type { RawEntry, RawSessionSummary } from '../../shared/raw-protocol';

const MANIFEST_FILENAME = 'manifest.json';
const RAW_SUBDIR = 'raw';
const HASH_LENGTH = 32;
/**
 * Stream-parse threshold. Files smaller than this are read with a single
 * {@link fs.readFile} for simplicity; larger files use a line-by-line
 * reader to keep RSS bounded.
 */
const STREAM_READ_THRESHOLD_BYTES = 50 * 1024 * 1024;

interface ManifestEntry {
    hash: string;
    sessionPath: string;
    createdAtMs: number;
}

interface Manifest {
    version: 1;
    entries: Record<string, ManifestEntry>;
}

interface MetaSidecar {
    hash: string;
    mtimeMs: number;
    sizeBytes: number;
    entryCount: number;
    firstEntryAtMs?: number;
    lastEntryAtMs?: number;
    /** Persisted so `getNextSeq` need not rescan every activation. */
    lastSeq?: number;
}

/**
 * Node.js implementation of the RawMode storage port.
 *
 * Persists each Pi session's raw event stream as a JSONL file inside
 * `<globalStorageDir>/raw/`. Files are keyed by `sha256(sessionPath)` so
 * arbitrary filesystem characters in Pi session paths never leak into
 * disk names.
 */
export class NodeRawStorage implements RawStoragePort {
    private readonly _rootDir: string;
    private readonly _manifestFile: string;
    private _manifestReady?: Promise<void>;
    private _manifest: Manifest = { version: 1, entries: {} };
    private _mkdirOnce?: Promise<void>;
    /** Serializes every filesystem-touching manifest write. */
    private _manifestWriteChain: Promise<void> = Promise.resolve();

    constructor(globalStorageDir: string) {
        this._rootDir = path.join(globalStorageDir, RAW_SUBDIR);
        this._manifestFile = path.join(this._rootDir, MANIFEST_FILENAME);
    }

    getStorageDir(): string {
        return this._rootDir;
    }

    async append(sessionPath: string, line: string): Promise<void> {
        await this._ensureRootExists();
        await this._ensureManifestLoaded();
        const entry = await this._registerSession(sessionPath);
        const filePath = this._filePathForHash(entry.hash);
        await fs.appendFile(filePath, line + '\n', 'utf8');
        // Meta sidecar is a best-effort optimization; invalidate any stale
        // cached count so the next `list()` recomputes.
        await this._invalidateMeta(entry.hash);
    }

    async readRange(
        sessionPath: string,
        fromSeq: number,
        count: number,
    ): Promise<{ entries: RawEntry[]; hasMore: boolean; nextSeq: number }> {
        if (count <= 0) {
            return { entries: [], hasMore: false, nextSeq: fromSeq };
        }
        await this._ensureManifestLoaded();
        const hash = this._hashFor(sessionPath);
        const filePath = this._filePathForHash(hash);
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            return { entries: [], hasMore: false, nextSeq: fromSeq };
        }
        const useStream = stat.size >= STREAM_READ_THRESHOLD_BYTES;
        const entries: RawEntry[] = [];
        let hasMore = false;
        let peekedSeqAfter = fromSeq;
        if (useStream) {
            await this._streamRead(filePath, (entry) => {
                if (entry.seq < fromSeq) return 'continue';
                if (entries.length < count) {
                    entries.push(entry);
                    return 'continue';
                }
                hasMore = true;
                peekedSeqAfter = entry.seq;
                return 'stop';
            });
        } else {
            const buf = await fs.readFile(filePath, 'utf8');
            for (const raw of buf.split('\n')) {
                if (!raw) continue;
                let parsed: RawEntry;
                try {
                    parsed = JSON.parse(raw) as RawEntry;
                } catch {
                    continue;
                }
                if (parsed.seq < fromSeq) continue;
                if (entries.length < count) {
                    entries.push(parsed);
                    continue;
                }
                hasMore = true;
                peekedSeqAfter = parsed.seq;
                break;
            }
        }
        const nextSeq = hasMore
            ? peekedSeqAfter
            : (entries.at(-1)?.seq ?? fromSeq - 1) + 1;
        return { entries, hasMore, nextSeq };
    }

    async getNextSeq(sessionPath: string): Promise<number> {
        await this._ensureManifestLoaded();
        const hash = this._hashFor(sessionPath);
        const filePath = this._filePathForHash(hash);
        try {
            await fs.access(filePath);
        } catch {
            return 0;
        }
        const meta = await this._readMeta(hash);
        if (meta && meta.lastSeq !== undefined) {
            return meta.lastSeq + 1;
        }
        // Fall back to scanning the file without writing a sidecar. Session
        // startup calls this even when recording is disabled, so sequence
        // lookup must remain read-only.
        const summary = await this._summarize(
            hash,
            this._manifest.entries[hash]?.sessionPath ?? sessionPath,
            false,
        );
        return (summary?.lastSeq ?? -1) + 1;
    }

    async list(): Promise<RawSessionSummary[]> {
        await this._ensureManifestLoaded();
        const summaries: RawSessionSummary[] = [];
        for (const entry of Object.values(this._manifest.entries)) {
            const summary = await this._summarize(entry.hash, entry.sessionPath);
            if (!summary) continue;
            let orphaned = false;
            try {
                await fs.access(entry.sessionPath);
            } catch {
                orphaned = true;
            }
            summaries.push({
                sessionPath: entry.sessionPath,
                entryCount: summary.entryCount,
                sizeBytes: summary.sizeBytes,
                firstEntryAtMs: summary.firstEntryAtMs,
                lastEntryAtMs: summary.lastEntryAtMs,
                orphaned,
            });
        }
        summaries.sort((a, b) => (b.lastEntryAtMs ?? 0) - (a.lastEntryAtMs ?? 0));
        return summaries;
    }

    async deleteSession(sessionPath: string): Promise<void> {
        await this._ensureManifestLoaded();
        const hash = this._hashFor(sessionPath);
        const filePath = this._filePathForHash(hash);
        const metaPath = this._metaPathForHash(hash);
        await Promise.all([
            fs.rm(filePath, { force: true }),
            fs.rm(metaPath, { force: true }),
        ]);
        if (this._manifest.entries[hash]) {
            delete this._manifest.entries[hash];
            await this._writeManifest();
        }
    }

    async clearAll(): Promise<void> {
        // Drain any pending manifest write so a stale tmp-file rename cannot
        // race with the rmtree below.
        try {
            await this._manifestWriteChain;
        } catch {
            // Ignore prior failures — we're wiping the directory anyway.
        }
        await fs.rm(this._rootDir, { recursive: true, force: true });
        this._manifest = { version: 1, entries: {} };
        this._manifestReady = undefined;
        this._mkdirOnce = undefined;
        this._manifestWriteChain = Promise.resolve();
    }

    async getSessionFile(sessionPath: string): Promise<string | undefined> {
        await this._ensureManifestLoaded();
        const hash = this._hashFor(sessionPath);
        if (!this._manifest.entries[hash]) return undefined;
        return this._filePathForHash(hash);
    }

    // ── internals ──

    private _hashFor(sessionPath: string): string {
        return createHash('sha256').update(sessionPath).digest('hex').slice(0, HASH_LENGTH);
    }

    private _filePathForHash(hash: string): string {
        return path.join(this._rootDir, `${hash}.jsonl`);
    }

    private _metaPathForHash(hash: string): string {
        return path.join(this._rootDir, `${hash}.meta.json`);
    }

    private async _ensureRootExists(): Promise<void> {
        if (!this._mkdirOnce) {
            this._mkdirOnce = fs.mkdir(this._rootDir, { recursive: true }).then(() => undefined);
        }
        await this._mkdirOnce;
    }

    private async _ensureManifestLoaded(): Promise<void> {
        if (!this._manifestReady) {
            this._manifestReady = this._loadManifest();
        }
        await this._manifestReady;
    }

    private async _loadManifest(): Promise<void> {
        try {
            const buf = await fs.readFile(this._manifestFile, 'utf8');
            const parsed = JSON.parse(buf) as Manifest;
            if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
                this._manifest = parsed;
                return;
            }
        } catch {
            // First-time init or corrupted manifest; start fresh.
        }
        // Read-only operations must not create Raw Mode storage. The first
        // append/register call persists this empty manifest when recording is
        // actually enabled and produces data.
        this._manifest = { version: 1, entries: {} };
    }

    private async _registerSession(sessionPath: string): Promise<ManifestEntry> {
        const hash = this._hashFor(sessionPath);
        const existing = this._manifest.entries[hash];
        if (existing) return existing;
        const entry: ManifestEntry = { hash, sessionPath, createdAtMs: Date.now() };
        this._manifest.entries[hash] = entry;
        await this._writeManifest();
        return entry;
    }

    private _writeManifest(): Promise<void> {
        // Serialize manifest writes so concurrent register/delete/clear calls
        // cannot interleave a tmp-file rename against a rmtree.
        const snapshot = JSON.stringify(this._manifest, null, 2);
        this._manifestWriteChain = this._manifestWriteChain.then(async () => {
            await this._ensureRootExists();
            const tmp = this._manifestFile + '.tmp';
            await fs.writeFile(tmp, snapshot, 'utf8');
            await fs.rename(tmp, this._manifestFile);
        });
        return this._manifestWriteChain;
    }

    private async _invalidateMeta(hash: string): Promise<void> {
        const metaPath = this._metaPathForHash(hash);
        try {
            await fs.rm(metaPath, { force: true });
        } catch {
            // Meta is a cache; failure to invalidate is not fatal.
        }
    }

    private async _readMeta(hash: string): Promise<MetaSidecar | undefined> {
        const metaPath = this._metaPathForHash(hash);
        const filePath = this._filePathForHash(hash);
        try {
            const [metaBuf, stat] = await Promise.all([
                fs.readFile(metaPath, 'utf8'),
                fs.stat(filePath),
            ]);
            const parsed = JSON.parse(metaBuf) as MetaSidecar;
            if (parsed && parsed.mtimeMs === stat.mtimeMs && parsed.sizeBytes === stat.size) {
                return parsed;
            }
        } catch {
            // Missing or stale; will be recomputed by _summarize().
        }
        return undefined;
    }

    private async _writeMeta(meta: MetaSidecar): Promise<void> {
        const metaPath = this._metaPathForHash(meta.hash);
        try {
            await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');
        } catch {
            // Cache write failure is non-fatal.
        }
    }

    private async _summarize(
        hash: string,
        sessionPath: string,
        cacheResult: boolean = true,
    ): Promise<(MetaSidecar & { entryCount: number }) | undefined> {
        const filePath = this._filePathForHash(hash);
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            return undefined;
        }
        const cached = await this._readMeta(hash);
        if (cached) return cached;

        let entryCount = 0;
        let firstEntryAtMs: number | undefined;
        let lastEntryAtMs: number | undefined;
        let lastSeq: number | undefined;
        await this._streamRead(filePath, (entry) => {
            entryCount++;
            if (firstEntryAtMs === undefined) firstEntryAtMs = entry.timestampMs;
            lastEntryAtMs = entry.timestampMs;
            lastSeq = entry.seq;
            return 'continue';
        });
        const meta: MetaSidecar = {
            hash,
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
            entryCount,
            firstEntryAtMs,
            lastEntryAtMs,
            lastSeq,
        };
        if (cacheResult) await this._writeMeta(meta);
        // Reference sessionPath to keep signature symmetric with future use.
        void sessionPath;
        return meta;
    }

    private async _streamRead(
        filePath: string,
        visit: (entry: RawEntry) => 'continue' | 'stop',
    ): Promise<void> {
        const stream = createReadStream(filePath, { encoding: 'utf8' });
        const reader = createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of reader) {
                if (!line) continue;
                let parsed: RawEntry;
                try {
                    parsed = JSON.parse(line) as RawEntry;
                } catch {
                    continue;
                }
                if (visit(parsed) === 'stop') {
                    break;
                }
            }
        } finally {
            reader.close();
            stream.destroy();
        }
    }
}
