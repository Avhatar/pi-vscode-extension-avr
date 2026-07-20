export interface DesktopShutdownRuntime {
    shutdown(): Promise<void>;
}

export interface DesktopShutdownCoordinatorOptions {
    readonly timeoutMs: number;
    readonly waitForActivation?: () => Promise<void>;
    readonly getRuntime: () => DesktopShutdownRuntime | undefined;
    readonly cleanup: () => Promise<void>;
    readonly now?: () => number;
    readonly timeout?: (timeoutMs: number) => Promise<void>;
}

export interface DesktopShutdownResult {
    readonly timedOut: boolean;
}

/** Idempotent, process-scoped shutdown with one absolute deadline for every stage. */
export class DesktopShutdownCoordinator {
    private pending?: Promise<DesktopShutdownResult>;

    constructor(private readonly options: DesktopShutdownCoordinatorOptions) {}

    shutdown(): Promise<DesktopShutdownResult> {
        this.pending ??= this.shutdownOnce();
        return this.pending;
    }

    private async shutdownOnce(): Promise<DesktopShutdownResult> {
        const now = this.options.now ?? Date.now;
        const deadline = now() + Math.max(0, this.options.timeoutMs);
        let timedOut = false;
        try {
            if (this.options.waitForActivation) {
                timedOut = !await this.runBounded(this.options.waitForActivation, deadline, now);
            }
            if (!timedOut) {
                const runtime = this.options.getRuntime();
                if (runtime) {
                    timedOut = !await this.runBounded(() => runtime.shutdown(), deadline, now);
                }
            }
        } finally {
            const cleanupCompleted = await this.runBounded(this.options.cleanup, deadline, now);
            timedOut ||= !cleanupCompleted;
        }
        return { timedOut };
    }

    private async runBounded(
        operation: () => Promise<void>,
        deadline: number,
        now: () => number,
    ): Promise<boolean> {
        const remainingMs = Math.max(0, deadline - now());
        const pending = operation();
        if (this.options.timeout) {
            return Promise.race([
                pending.then(() => true),
                this.options.timeout(remainingMs).then(() => false),
            ]);
        }
        return new Promise<boolean>((resolveResult, rejectResult) => {
            const timer = setTimeout(() => resolveResult(false), remainingMs);
            void pending.then(
                () => {
                    clearTimeout(timer);
                    resolveResult(true);
                },
                (error) => {
                    clearTimeout(timer);
                    rejectResult(error);
                },
            );
        });
    }
}
