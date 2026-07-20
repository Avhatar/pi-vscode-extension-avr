import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { TabRegistry } from '../../../core/chat/tab-registry';

function createRegistry(tabs: any[], activeId?: string): TabRegistry<any> {
    const registry = new TabRegistry<any>();
    for (const tab of tabs) registry.register(tab);
    if (activeId) registry.activate(activeId);
    return registry;
}

describe('ChatController tab registry integration', () => {
    it('activates only registered tabs when panel focus changes', () => {
        const first = { id: 'tab-a' };
        const second = { id: 'tab-b' };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([first, second], first.id);
        controller._onLauncherStateChanged = { fire: vi.fn() };

        controller.markActiveTab(second.id);
        controller.markActiveTab(second.id);
        controller.markActiveTab('missing');

        expect(controller.activeTabId).toBe(second.id);
        expect(controller._onLauncherStateChanged.fire).toHaveBeenCalledOnce();
    });

    it('rejects panel registration for an unknown tab without emitting host effects', () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([]);
        controller._openPanels = new Map();
        controller._persistTabs = vi.fn();
        controller._onLauncherStateChanged = { fire: vi.fn() };

        expect(() => controller.registerPanel('missing', { reveal: vi.fn() }))
            .toThrow('Cannot register a panel for unknown tab: missing');
        expect(controller._openPanels.size).toBe(0);
        expect(controller._persistTabs).not.toHaveBeenCalled();
        expect(controller._onLauncherStateChanged.fire).not.toHaveBeenCalled();
    });

    it('disposes a panel and runtime before removing an active launcher tab', async () => {
        const order: string[] = [];
        const first = { id: 'tab-a', disposeResources: vi.fn(async () => undefined) };
        const second = {
            id: 'tab-b',
            disposeResources: vi.fn(async () => {
                expect(controller._tabs.has(second.id)).toBe(true);
                order.push('runtime');
            }),
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([first, second], second.id);
        controller._openPanels = new Map([[second.id, {
            reveal: vi.fn(),
            dispose: vi.fn(() => order.push('panel')),
        }]]);
        controller._persistTabs = vi.fn(() => order.push('persist'));
        controller._onLauncherStateChanged = { fire: vi.fn(() => order.push('launcher')) };

        await controller.dropTab(second.id);

        expect(order).toEqual(['panel', 'runtime', 'persist', 'launcher']);
        expect(controller._tabs.has(second.id)).toBe(false);
        expect(controller.activeTabId).toBe(first.id);
    });

    it('keeps the legacy close guard while selecting the first remaining tab', async () => {
        const first = { id: 'tab-a', disposeResources: vi.fn(async () => undefined) };
        const second = { id: 'tab-b', disposeResources: vi.fn(async () => undefined) };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([first], first.id);
        controller._persistTabs = vi.fn();
        controller._onLauncherStateChanged = { fire: vi.fn() };
        controller.sendStateSync = vi.fn();

        await controller._closeTab(first.id);
        expect(first.disposeResources).not.toHaveBeenCalled();
        expect(controller._tabs.has(first.id)).toBe(true);

        controller._tabs.register(second);
        await controller._closeTab(first.id);

        expect(first.disposeResources).toHaveBeenCalledOnce();
        expect(controller.activeTabId).toBe(second.id);
        expect(controller.sendStateSync).toHaveBeenCalledWith(second.id);
    });

    it('registers a restored session path without changing the active tab', async () => {
        const order: string[] = [];
        const existing = { id: 'tab-existing' };
        const session = {
            initializeFromPath: vi.fn(async (path: string) => order.push(`initialize:${path}`)),
            getMessages: vi.fn(() => [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'reply' },
                { role: 'user', content: 'second' },
            ]),
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([existing], existing.id);
        controller._createSessionManager = vi.fn(() => session);
        controller._createFileChangeManagers = vi.fn(() => ({
            checkpoint: { dispose: vi.fn() },
            diff: { dispose: vi.fn() },
        }));
        controller._updateTabName = vi.fn(() => order.push('name'));
        controller._subscribeTab = vi.fn(() => order.push('subscribe'));
        controller._persistTabs = vi.fn(() => order.push('persist'));

        const restoredId = await controller.createTabFromSessionPath('/sessions/restored.jsonl');

        expect(order).toEqual([
            'initialize:/sessions/restored.jsonl',
            'name',
            'subscribe',
            'persist',
        ]);
        expect(controller._tabs.get(restoredId)?.session).toBe(session);
        expect(controller._tabs.get(restoredId)?.turnCounter).toBe(2);
        expect(controller.activeTabId).toBe(existing.id);
    });
});
