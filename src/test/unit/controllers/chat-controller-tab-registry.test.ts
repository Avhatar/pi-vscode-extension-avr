import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { ChatService } from '../../../core/chat/chat-service';
import { TabRegistry } from '../../../core/chat/tab-registry';

// Mock `fs/promises` at module scope so deleteHistorySession's `unlink(...)`
// call becomes observable without touching the real filesystem. Every other
// export is left untouched so unrelated imports keep working.
vi.mock('fs/promises', async () => {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    return {
        ...actual,
        unlink: vi.fn(async () => undefined),
    };
});
import { unlink as mockedUnlink } from 'fs/promises';

function createRegistry(tabs: any[], activeId?: string): TabRegistry<any> {
    const registry = new TabRegistry<any>();
    for (const tab of tabs) registry.register(tab);
    if (activeId) registry.activate(activeId);
    return registry;
}

describe('ChatController tab registry integration', () => {
    it('activates only registered tabs when panel focus changes', () => {
        const first = { id: 'tab-a' };
        const second = { id: 'tab-b', hasNotification: true };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([first, second], first.id);
        controller._onLauncherStateChanged = { fire: vi.fn() };

        controller.markActiveTab(second.id);
        controller.markActiveTab(second.id);
        controller.markActiveTab('missing');

        expect(controller.activeTabId).toBe(second.id);
        expect(second.hasNotification).toBe(true);
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

    it('disposes an initialized session when tab resource construction fails', async () => {
        const session = {
            initializeFromPath: vi.fn(async () => undefined),
            dispose: vi.fn(async () => undefined),
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._createSessionManager = vi.fn(() => session);
        controller._createFileChangeManagers = vi.fn(() => { throw new Error('diff failed'); });

        await expect(controller._createTabState({
            kind: 'sessionPath',
            sessionPath: '/sessions/restored.jsonl',
        })).rejects.toThrow('diff failed');

        expect(session.initializeFromPath).toHaveBeenCalledWith('/sessions/restored.jsonl');
        expect(session.dispose).toHaveBeenCalledOnce();
    });

    it('deleteHistorySession disposes the raw recorder and storage before unlinking', async () => {
        const order: string[] = [];
        const getSessionsSpy = vi.fn(async () => {
            order.push('getSessions');
            return [{ path: '/target.jsonl' }, { path: '/other.jsonl' }];
        });
        const existing = {
            id: 'tab-existing',
            session: {
                sessionPath: '/other.jsonl',
                getSessions: getSessionsSpy,
            },
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([existing], existing.id);
        controller._openPanels = new Map();
        controller._subagentStore = {
            deleteByParentSessionPath: vi.fn(async () => { order.push('subagent'); }),
        };
        controller._rawRecorderRegistry = {
            dispose: vi.fn(async () => { order.push('rawRecorder'); }),
            notifyDataCleared: vi.fn(() => { order.push('notifyDataCleared'); }),
        };
        controller._rawStorage = {
            deleteSession: vi.fn(async () => { order.push('rawStorage'); }),
        };
        controller._persistTabs = vi.fn(() => { order.push('persist'); });
        controller._onLauncherStateChanged = { fire: vi.fn(() => { order.push('launcher'); }) };
        controller.sendStateSync = vi.fn(() => { order.push('sendStateSync'); });
        controller._hostInstance = {
            tabs: controller._tabs,
            chat: {},
            detachTab: vi.fn(async () => { order.push('detach'); }),
        };
        controller._chatService = controller._hostInstance.chat;
        controller.findTabIdBySessionPath = ChatController.prototype.findTabIdBySessionPath.bind(controller);
        (mockedUnlink as unknown as ReturnType<typeof vi.fn>).mockClear();
        (mockedUnlink as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('unlink'); });

        await controller.deleteHistorySession('/target.jsonl');

        expect(controller._subagentStore.deleteByParentSessionPath).toHaveBeenCalledWith('/target.jsonl');
        expect(controller._rawRecorderRegistry.dispose).toHaveBeenCalledWith('/target.jsonl');
        expect(controller._rawStorage.deleteSession).toHaveBeenCalledWith('/target.jsonl');
        expect(mockedUnlink).toHaveBeenCalledWith('/target.jsonl');
        // Should not scan the full session directory on delete.
        expect(getSessionsSpy).not.toHaveBeenCalled();
        expect(order).toEqual([
            'subagent',
            'rawRecorder',
            'rawStorage',
            'notifyDataCleared',
            'unlink',
            'persist',
            'launcher',
            'sendStateSync',
        ]);
    });

    it('deleteHistorySession still succeeds when RawMode is not wired in', async () => {
        const existing = {
            id: 'tab-existing',
            session: {
                sessionPath: '/other.jsonl',
                getSessions: async () => ([{ path: '/target.jsonl' }, { path: '/other.jsonl' }]),
            },
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([existing], existing.id);
        controller._openPanels = new Map();
        controller._subagentStore = { deleteByParentSessionPath: vi.fn(async () => undefined) };
        controller._rawRecorderRegistry = undefined;
        controller._rawStorage = undefined;
        controller._persistTabs = vi.fn();
        controller._onLauncherStateChanged = { fire: vi.fn() };
        controller.sendStateSync = vi.fn();
        controller._hostInstance = {
            tabs: controller._tabs,
            chat: {},
            detachTab: vi.fn(async () => undefined),
        };
        controller._chatService = controller._hostInstance.chat;
        controller.findTabIdBySessionPath = ChatController.prototype.findTabIdBySessionPath.bind(controller);
        (mockedUnlink as unknown as ReturnType<typeof vi.fn>).mockClear();
        (mockedUnlink as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);

        await expect(controller.deleteHistorySession('/target.jsonl')).resolves.toBeUndefined();
        expect(mockedUnlink).toHaveBeenCalledWith('/target.jsonl');
    });

    it('deleteHistorySession maps unlink ENOENT to a friendly missing-session error', async () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createRegistry([], undefined);
        controller._openPanels = new Map();
        controller._subagentStore = { deleteByParentSessionPath: vi.fn(async () => undefined) };
        controller._rawRecorderRegistry = undefined;
        controller._rawStorage = undefined;
        controller._persistTabs = vi.fn();
        controller._onLauncherStateChanged = { fire: vi.fn() };
        controller.sendStateSync = vi.fn();
        controller._hostInstance = {
            tabs: controller._tabs,
            chat: {},
            detachTab: vi.fn(async () => undefined),
        };
        controller._chatService = controller._hostInstance.chat;
        controller.findTabIdBySessionPath = ChatController.prototype.findTabIdBySessionPath.bind(controller);
        const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        (mockedUnlink as unknown as ReturnType<typeof vi.fn>).mockClear();
        (mockedUnlink as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw enoent; });

        await expect(controller.deleteHistorySession('/missing.jsonl'))
            .rejects.toThrow('Session was not found in history.');
        expect(controller._persistTabs).not.toHaveBeenCalled();
        expect(controller._onLauncherStateChanged.fire).not.toHaveBeenCalled();
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
        controller._chatService = new ChatService({ now: () => 0 });
        controller._onTabRenamed = { fire: vi.fn(() => order.push('name')) };
        controller._onLauncherStateChanged = { fire: vi.fn(() => order.push('launcher')) };
        controller._subscribeTab = vi.fn(() => order.push('subscribe'));
        controller._persistTabs = vi.fn(() => order.push('persist'));

        const restoredId = await controller.createTabFromSessionPath('/sessions/restored.jsonl');

        expect(order).toEqual([
            'initialize:/sessions/restored.jsonl',
            'persist',
            'name',
            'launcher',
            'subscribe',
            'persist',
        ]);
        expect(controller._tabs.get(restoredId)?.session).toBe(session);
        expect(controller._tabs.get(restoredId)?.name).toBe('first');
        expect(controller._tabs.get(restoredId)?.turnCounter).toBe(2);
        expect(controller.activeTabId).toBe(existing.id);
    });
});
