import { describe, expect, it, vi } from 'vitest';
import { ChatApplication, type ApplicationTab } from '../../../../core/chat/chat-application';
import { TabRegistry } from '../../../../core/chat/tab-registry';

function createTab(id: string): ApplicationTab {
    return {
        id,
        name: id,
        hasNotification: false,
        isStreamingLocal: false,
        isCompacting: false,
        disposeResources: vi.fn(async () => undefined),
    };
}

function createApplication(): ChatApplication<ApplicationTab> {
    return new ChatApplication(new TabRegistry<ApplicationTab>());
}

describe('portable ChatApplication lifecycle', () => {
    it('registers caller-created tabs without activation unless explicitly requested', () => {
        const app = createApplication();
        const first = createTab('first');
        const restored = createTab('restored');

        app.register(first, { activate: true });
        app.register(restored);

        expect(app.tabs.list()).toEqual([first, restored]);
        expect(app.tabs.activeId).toBe('first');
    });

    it('activates registered tabs and clears notification only for command-driven switches', () => {
        const app = createApplication();
        const first = createTab('first');
        const second = createTab('second');
        second.hasNotification = true;
        app.register(first, { activate: true });
        app.register(second);

        expect(app.activate(second.id)).toBe(true);
        expect(second.hasNotification).toBe(true);
        expect(app.activate(first.id, { clearNotification: true })).toBe(true);
        expect(first.hasNotification).toBe(false);
        expect(app.activate(second.id, { clearNotification: true })).toBe(true);
        expect(second.hasNotification).toBe(false);
        expect(app.activate('missing', { clearNotification: true })).toBe(false);
    });

    it('disposes before removal and allows the final tab to be removed', async () => {
        const app = createApplication();
        const tab = createTab('only');
        const order: string[] = [];
        tab.disposeResources = vi.fn(async () => {
            expect(app.tabs.has(tab.id)).toBe(true);
            order.push('dispose');
        });
        app.register(tab, { activate: true });

        const result = await app.remove(tab.id);
        order.push('removed');

        expect(order).toEqual(['dispose', 'removed']);
        expect(result).toMatchObject({ tab, wasActive: true, activeId: '' });
        expect(app.tabs.size).toBe(0);
        expect(app.tabs.activeId).toBe('');
    });

    it('selects the first remaining tab when removing the active runtime', async () => {
        const app = createApplication();
        const first = createTab('first');
        const second = createTab('second');
        app.register(first);
        app.register(second, { activate: true });

        await app.remove(second.id);

        expect(app.tabs.activeId).toBe(first.id);
    });

    it('projects busy state and protocol tab information in insertion order', () => {
        const app = createApplication();
        const first = createTab('first');
        const second = createTab('second');
        first.isStreamingLocal = true;
        second.isCompacting = true;
        second.hasNotification = true;
        app.register(first, { activate: true });
        app.register(second);

        expect(app.isBusy(first)).toBe(true);
        expect(app.isBusy(second)).toBe(true);
        expect(app.getTabInfos()).toEqual([
            {
                id: 'first',
                name: 'first',
                isActive: true,
                isStreaming: true,
                hasNotification: false,
            },
            {
                id: 'second',
                name: 'second',
                isActive: false,
                isStreaming: true,
                hasNotification: true,
            },
        ]);
    });
});
