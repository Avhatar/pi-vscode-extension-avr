export interface DisposableLike {
    dispose(): void;
}

export type TypedEvent<T> = (
    listener: (event: T) => void,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
) => DisposableLike;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type FireArguments<T> = IsAny<T> extends true
    ? [event: T]
    : [T] extends [void] ? [event?: T] : [event: T];

/** Minimal platform-neutral event primitive for the shared agent runtime. */
export class TypedEventEmitter<T> implements DisposableLike {
    private readonly listeners = new Set<(event: T) => void>();
    private disposed = false;

    readonly event: TypedEvent<T> = (listener, thisArgs, disposables) => {
        const callback = (event: T): void => listener.call(thisArgs, event);
        let active = !this.disposed;
        if (active) this.listeners.add(callback);
        const subscription = {
            dispose: () => {
                if (!active) return;
                active = false;
                this.listeners.delete(callback);
            },
        };
        disposables?.push(subscription);
        return subscription;
    };

    fire(...args: FireArguments<T>): void {
        if (this.disposed) return;
        const event = args[0] as T;
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                // One listener must not prevent delivery to the remaining listeners.
            }
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.listeners.clear();
    }
}
