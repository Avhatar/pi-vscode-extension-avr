import type { TabInfo } from '../../shared/agent-protocol';
import { TabRegistry, type TabRemovalResult } from './tab-registry';

export interface ApplicationTab {
    readonly id: string;
    name: string;
    hasNotification: boolean;
    isStreamingLocal: boolean;
    isCompacting: boolean;
    disposeResources(): void | Promise<void>;
}

export interface RegisterTabOptions {
    readonly activate?: boolean;
}

export interface ActivateTabOptions {
    readonly clearNotification?: boolean;
}

/** Portable application-level lifecycle around caller-created tab runtimes. */
export class ChatApplication<TTab extends ApplicationTab> {
    constructor(readonly tabs: TabRegistry<TTab>) {}

    register(tab: TTab, options: RegisterTabOptions = {}): void {
        this.tabs.register(tab);
        if (options.activate) {
            this.tabs.activate(tab.id);
        }
    }

    activate(tabId: string, options: ActivateTabOptions = {}): boolean {
        const activated = this.tabs.activate(tabId);
        if (activated && options.clearNotification) {
            const tab = this.tabs.get(tabId);
            if (tab) {
                tab.hasNotification = false;
            }
        }
        return activated;
    }

    async remove(tabId: string): Promise<TabRemovalResult<TTab> | undefined> {
        const tab = this.tabs.get(tabId);
        if (!tab) return undefined;
        await tab.disposeResources();
        return this.tabs.remove(tabId);
    }

    isBusy(tab: TTab): boolean {
        return tab.isStreamingLocal || tab.isCompacting;
    }

    getTabInfos(): TabInfo[] {
        return this.tabs.list().map(tab => ({
            id: tab.id,
            name: tab.name,
            isActive: tab.id === this.tabs.activeId,
            isStreaming: this.isBusy(tab),
            hasNotification: tab.hasNotification,
        }));
    }
}
