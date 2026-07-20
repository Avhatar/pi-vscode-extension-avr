import type { Logger } from '../../core/ports/logger';

export type NodeLogSink = (message: string) => void;

/** Node logger adapter with an injectable sink for files, stderr, or tests. */
export class NodeLogger implements Logger {
    constructor(private readonly _sink: NodeLogSink = console.log) {}

    appendLine(message: string): void {
        this._sink(message);
    }
}
