interface QueueEntry {
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
    onAbort: () => void;
}

export class SubagentCoordinator {
    private activeCount = 0;
    private readonly queue: QueueEntry[] = [];
    private readonly shutdownController = new AbortController();
    private disposed = false;

    constructor(readonly maxConcurrency = 4) {
        if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
            throw new Error('Subagent maxConcurrency must be a positive integer.');
        }
    }

    get active(): number {
        return this.activeCount;
    }

    get queued(): number {
        return this.queue.length;
    }

    async schedule<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.disposed) throw abortError('Subagent coordinator is disposed.');
        const combined = combineAbortSignals([signal, this.shutdownController.signal]);
        let acquired = false;
        try {
            await this.acquire(combined.signal);
            acquired = true;
            if (combined.signal.aborted) throw abortError('Subagent run was cancelled before execution.');
            return await operation(combined.signal);
        } finally {
            combined.dispose();
            if (acquired) this.release();
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.shutdownController.abort();
        for (const entry of this.queue.splice(0)) {
            entry.signal.removeEventListener('abort', entry.onAbort);
            entry.reject(abortError('Subagent coordinator was disposed.'));
        }
    }

    private acquire(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.reject(abortError('Subagent run was cancelled while queued.'));
        if (this.activeCount < this.maxConcurrency) {
            this.activeCount += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const entry: QueueEntry = {
                signal,
                resolve: () => {
                    signal.removeEventListener('abort', entry.onAbort);
                    this.activeCount += 1;
                    resolve();
                },
                reject,
                onAbort: () => {
                    const index = this.queue.indexOf(entry);
                    if (index >= 0) this.queue.splice(index, 1);
                    reject(abortError('Subagent run was cancelled while queued.'));
                },
            };
            signal.addEventListener('abort', entry.onAbort, { once: true });
            this.queue.push(entry);
        });
    }

    private release(): void {
        this.activeCount = Math.max(0, this.activeCount - 1);
        while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
            const next = this.queue.shift()!;
            if (next.signal.aborted) {
                next.signal.removeEventListener('abort', next.onAbort);
                next.reject(abortError('Subagent run was cancelled while queued.'));
                continue;
            }
            next.resolve();
            break;
        }
    }
}

export function abortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
    signal: AbortSignal;
    dispose(): void;
} {
    const controller = new AbortController();
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const abort = (): void => controller.abort();
    for (const signal of signals) {
        if (!signal) continue;
        if (signal.aborted) {
            controller.abort();
            break;
        }
        signal.addEventListener('abort', abort, { once: true });
        listeners.push({ signal, listener: abort });
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
        },
    };
}
