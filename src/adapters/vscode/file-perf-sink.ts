import { promises as fs, createWriteStream, WriteStream } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { PerfSink } from '../../core/ports/perf-sink';

export interface FilePerfSinkHandle {
    sink: PerfSink;
    /** Full path to the file that will receive JSONL records. */
    filePath: string;
    /** Short id assigned to this activation run. Included in the file name. */
    runId: string;
}

/**
 * Create a per-activation JSONL perf log under `${dir}/perf/`. The file name
 * embeds both a compact ISO timestamp and a random `runId`, so multiple runs
 * (including F5 dev host, packaged install, remote windows) never collide.
 *
 * Directory creation is best-effort at construction time. Actual writes are
 * buffered by the underlying `WriteStream`; call `flush()` to persist and
 * `close()` on deactivation.
 */
export async function createFilePerfSink(dir: string, header?: Record<string, unknown>): Promise<FilePerfSinkHandle> {
    const perfDir = join(dir, 'perf');
    await fs.mkdir(perfDir, { recursive: true });

    const runId = randomBytes(4).toString('hex');
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const filePath = join(perfDir, `${stamp}-${runId}.jsonl`);

    const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    const sink = new WriteStreamPerfSink(stream);

    // Header record so a log file is self-describing when copied out.
    sink.write(JSON.stringify({
        ts: now.toISOString(),
        scope: 'perf.header',
        phase: 'event',
        meta: { runId, ...(header ?? {}) },
    }));

    return { sink, filePath, runId };
}

class WriteStreamPerfSink implements PerfSink {
    private _closed = false;
    constructor(private readonly _stream: WriteStream) {
        this._stream.on('error', () => {
            // Swallow — perf logging is diagnostic only. A broken sink must
            // never surface as an activation error.
            this._closed = true;
        });
    }

    write(line: string): void {
        if (this._closed) return;
        try {
            this._stream.write(line + '\n');
        } catch {
            this._closed = true;
        }
    }

    async flush(): Promise<void> {
        if (this._closed) return;
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 200);
            this._stream.write('', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 500);
            this._stream.end(() => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
}
