import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

export interface PiSessionRuntimeState {
    readonly session: AgentSession;
    readonly sessionManager: SessionManager;
}

type SessionFactory<State extends PiSessionRuntimeState> = () => Promise<State>;
type SessionBinding = () => void;
type BindSession = (session: AgentSession) => SessionBinding;

/** Owns one active Pi SDK session and its host event binding. */
export class PiSessionRuntime {
    private _state: PiSessionRuntimeState | undefined;
    private _unbind: SessionBinding | undefined;
    private _sessionDisposed = false;
    private _transition: Promise<unknown> | undefined;
    private _disposePromise: Promise<void> | undefined;
    private _disposeRequested = false;

    constructor(private readonly _bindSession: BindSession) {}

    get session(): AgentSession | undefined {
        return this._state?.session;
    }

    get sessionManager(): SessionManager | undefined {
        return this._state?.sessionManager;
    }

    get isReady(): boolean {
        return this._state !== undefined;
    }

    start<State extends PiSessionRuntimeState>(create: SessionFactory<State>): Promise<State> {
        return this._runTransition(async () => {
            if (this._state !== undefined) {
                throw new Error('Session runtime already started');
            }
            return this._install(await create());
        });
    }

    replace<State extends PiSessionRuntimeState>(create: SessionFactory<State>): Promise<State> {
        return this._runTransition(async () => {
            if (!this._state) {
                throw new Error('No active session to replace');
            }
            this._invalidateCurrent();
            return this._install(await create());
        });
    }

    dispose(): Promise<void> {
        if (this._disposePromise) {
            return this._disposePromise;
        }
        this._disposeRequested = true;
        const pendingTransition = this._transition;
        this._disposePromise = (async () => {
            if (pendingTransition) {
                try {
                    await pendingTransition;
                } catch {
                    // The lifecycle caller receives the original transition failure.
                }
            }
            try {
                this._invalidateCurrent();
            } finally {
                this._state = undefined;
                this._sessionDisposed = false;
            }
        })();
        return this._disposePromise;
    }

    private _runTransition<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this._disposeRequested) {
            return Promise.reject(new Error('Session runtime is disposing'));
        }
        if (this._transition) {
            return Promise.reject(new Error('Session runtime transition already in progress'));
        }

        let resolveTransition!: (value: Result | PromiseLike<Result>) => void;
        let rejectTransition!: (reason?: unknown) => void;
        const transition = new Promise<Result>((resolve, reject) => {
            resolveTransition = resolve;
            rejectTransition = reject;
        });
        this._transition = transition;

        try {
            void operation().then(resolveTransition, rejectTransition);
        } catch (error) {
            rejectTransition(error);
        }

        return transition.finally(() => {
            if (this._transition === transition) {
                this._transition = undefined;
            }
        });
    }

    private _install<State extends PiSessionRuntimeState>(state: State): State {
        this._state = state;
        this._sessionDisposed = false;
        try {
            this._unbind = this._bindSession(state.session);
            return state;
        } catch (error) {
            try {
                this._invalidateCurrent();
            } catch {
                // Preserve the binding failure while still attempting complete cleanup.
            }
            throw error;
        }
    }

    private _invalidateCurrent(): void {
        const state = this._state;
        if (!state) {
            return;
        }

        const unbind = this._unbind;
        this._unbind = undefined;
        this._state = undefined;
        let firstError: unknown;
        try {
            unbind?.();
        } catch (error) {
            firstError = error;
        }

        if (!this._sessionDisposed) {
            this._sessionDisposed = true;
            try {
                state.session.dispose();
            } catch (error) {
                firstError ??= error;
            }
        }

        if (firstError !== undefined) {
            throw firstError;
        }
    }
}
