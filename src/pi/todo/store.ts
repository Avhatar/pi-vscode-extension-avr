import { EMPTY_STATE, type TaskState } from './types';

type Listener = (state: TaskState) => void;

// Per-PiSessionManager state cell. Owns the in-memory `TaskState` and
// fans out change notifications to subscribers (the chat controller
// pushes snapshots to the sidebar webview).
//
// `replaceState` is used by replay (full overwrite from a branch
// snapshot). `commit` is used by the tool reducer (after a successful
// mutation). Both notify listeners.
export class TodoStore {
    private state: TaskState = { tasks: [], nextId: EMPTY_STATE.nextId };
    private listeners = new Set<Listener>();

    getState(): TaskState {
        return this.state;
    }

    replaceState(next: TaskState): void {
        this.state = next;
        this.notify();
    }

    commit(next: TaskState): void {
        this.state = next;
        this.notify();
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        const snapshot = this.state;
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch {
                // Listener errors must not crash the reducer / replay path.
            }
        }
    }
}
