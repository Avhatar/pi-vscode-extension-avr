export interface TabRemovalResult<T> {
    readonly tab: T;
    readonly wasActive: boolean;
    readonly activeId: string;
}

/**
 * Portable generic registry for tab-typed items with deterministic
 * insertion-order membership and at-most-one active selection.
 *
 * The registry owns no lifecycle, disposal, or host integration.
 */
export class TabRegistry<T extends { readonly id: string }> {
    private readonly _map = new Map<string, T>();
    private _activeId = '';

    get size(): number {
        return this._map.size;
    }

    get activeId(): string {
        return this._activeId;
    }

    get active(): T | undefined {
        return this._activeId ? this._map.get(this._activeId) : undefined;
    }

    has(id: string): boolean {
        return this._map.has(id);
    }

    get(id: string): T | undefined {
        return this._map.get(id);
    }

    keys(): IterableIterator<string> {
        return this._map.keys();
    }

    values(): IterableIterator<T> {
        return this._map.values();
    }

    entries(): IterableIterator<[string, T]> {
        return this._map.entries();
    }

    /** Returns a snapshot of all tabs in insertion order. */
    list(): readonly T[] {
        return [...this._map.values()];
    }

    find(predicate: (tab: T) => boolean): T | undefined {
        for (const tab of this._map.values()) {
            if (predicate(tab)) return tab;
        }
        return undefined;
    }

    /** Register a tab without changing the active selection. */
    register(tab: T): void {
        this._map.set(tab.id, tab);
    }

    /** Activate a present, non-current tab. */
    activate(id: string): boolean {
        if (!this._map.has(id) || id === this._activeId) return false;
        this._activeId = id;
        return true;
    }

    /**
     * Remove one tab. Removing the active tab selects the first remaining
     * insertion-order tab, or clears the active selection when none remain.
     */
    remove(id: string): TabRemovalResult<T> | undefined {
        const tab = this._map.get(id);
        if (!tab) return undefined;

        const wasActive = id === this._activeId;
        this._map.delete(id);
        if (wasActive) {
            this._activeId = this._map.keys().next().value ?? '';
        }
        return { tab, wasActive, activeId: this._activeId };
    }
}
