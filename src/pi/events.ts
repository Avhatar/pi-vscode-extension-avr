import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';

export type EventHandler = (event: AgentSessionEvent) => void;

export class EventRouter {
    private _handlers = new Map<string, Set<EventHandler>>();
    private _globalHandlers = new Set<EventHandler>();

    on(eventType: string, handler: EventHandler): () => void {
        let set = this._handlers.get(eventType);
        if (!set) {
            set = new Set();
            this._handlers.set(eventType, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
    }

    onAll(handler: EventHandler): () => void {
        this._globalHandlers.add(handler);
        return () => this._globalHandlers.delete(handler);
    }

    dispatch(event: AgentSessionEvent): void {
        for (const handler of this._globalHandlers) {
            try {
                handler(event);
            } catch (_) { /* swallow listener errors */ }
        }
        const set = this._handlers.get(event.type);
        if (set) {
            for (const handler of set) {
                try {
                    handler(event);
                } catch (_) { /* swallow listener errors */ }
            }
        }
    }

    /** Returns a listener suitable for AgentSession.subscribe() */
    asSessionListener(): AgentSessionEventListener {
        return (event) => this.dispatch(event);
    }

    clear(): void {
        this._handlers.clear();
        this._globalHandlers.clear();
    }
}
