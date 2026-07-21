import { describe, expect, it, vi } from 'vitest';
import { ChatHost, type ChatHostTab } from '../../../../core/chat/chat-host';
import { TabRegistry } from '../../../../core/chat/tab-registry';

function createTab(id: string): ChatHostTab {
    return {
        id,
        name: id,
        hasNotification: false,
        isStreamingLocal: false,
        isCompacting: false,
        projectToolDefault: undefined,
        session: {
            getMessages: vi.fn(() => []),
            newSession: vi.fn(async () => undefined),
            loadSession: vi.fn(async () => undefined),
            setModel: vi.fn(async () => undefined),
            setThinkingLevel: vi.fn(),
        },
        diffManager: { clearAll: vi.fn() },
        checkpointManager: { clearAll: vi.fn() },
        resetSessionProjection: vi.fn(),
        disposeResources: vi.fn(async () => undefined),
    } as any;
}

function createHarness() {
    const tabs = new TabRegistry<ChatHostTab>();
    const created: ChatHostTab[] = [];
    const order: string[] = [];
    const chat = {
        updateTabName: vi.fn((tab: ChatHostTab) => ({ changed: false, name: tab.name })),
        resetSessionProjection: vi.fn(),
        buildState: vi.fn((_tab: ChatHostTab, context: any) => ({
            activeTabId: context.activeTabId,
            tabs: context.getTabs(),
            marker: context.marker,
        })),
        reduceEvent: vi.fn(),
        beginAgentEnd: vi.fn(() => ({ turnEndAt: 1, turnDurationMs: 1 })),
        completeAgentEnd: vi.fn(),
        settleAgent: vi.fn<() => any>(() => undefined),
        reserveQueuedDispatch: vi.fn(() => false),
    };
    const commands = { dispatch: vi.fn(async () => ({})) };
    let cacheMode: 'auto' | 'short' | 'long' = 'auto';
    let favorites = ['provider:model'];
    let nextId = 1;
    const factory = vi.fn(async (request: any) => {
        const tab = createTab(`created-${nextId++}`);
        if (request.kind === 'sessionPath') tab.name = request.name ?? tab.name;
        created.push(tab);
        return tab;
    });
    const effects = {
        bindTab: vi.fn((tab: ChatHostTab) => order.push(`bind:${tab.id}`)),
        persistTabs: vi.fn(() => { order.push('persist'); }),
        tabsChanged: vi.fn(() => order.push('tabs')),
        publishState: vi.fn((tabId: string) => order.push(`state:${tabId}`)),
        openTab: vi.fn((tabId: string) => order.push(`open:${tabId}`)),
        activeTabChanged: vi.fn((tab: ChatHostTab) => order.push(`active:${tab.id}`)),
        tabRenamed: vi.fn(),
        modelsChanged: vi.fn(() => order.push('models')),
        reportCommandFailure: vi.fn(),
        restoreFailed: vi.fn(),
    };
    const preferences = {
        getCacheMode: () => cacheMode,
        setCacheMode: vi.fn(async (mode: typeof cacheMode) => { cacheMode = mode; }),
        getFavorites: () => favorites,
        setFavorites: vi.fn(async (next: readonly string[]) => { favorites = [...next]; }),
        getProjectToolDefault: vi.fn(() => undefined),
        applyPersistedToolSelection: vi.fn(),
        refreshCacheEffective: vi.fn(),
        getDisabledTools: vi.fn(() => ['write']),
        setDisabledTools: vi.fn(async () => undefined),
        setTodoEnabled: vi.fn(async () => undefined),
        setSubagentsEnabled: vi.fn(async () => true),
        setPlanModeEnabled: vi.fn(async () => undefined),
        setFileUndoViewEnabled: vi.fn(async () => undefined),
    };
    const eventEffects = {
        agentStarted: vi.fn(),
        streamingContextChanged: vi.fn(),
        reportAgentError: vi.fn(),
        reportAgentNotice: vi.fn(),
        showAutoRetry: vi.fn(),
        logTurnEnd: vi.fn(),
        sweepPendingTools: vi.fn(),
        completeAgentEndAccounting: vi.fn(async () => undefined),
        notifyTurnCompletion: vi.fn(),
        emitAgentEvent: vi.fn(),
        dispatchNextQueued: vi.fn(async () => undefined),
    };
    const host = new ChatHost({
        tabs,
        chat: chat as any,
        commands: commands as any,
        factory,
        commandCallbacks: vi.fn(() => ({
            directPrompt: {} as any,
            streaming: {} as any,
            fileMentions: {} as any,
            handleName: vi.fn(() => false),
            publishState: vi.fn(),
            emit: vi.fn(),
            notifyFileHistory: vi.fn(),
        })),
        stateContext: vi.fn(() => ({
            cacheMode,
            getCacheEffective: () => 'short' as const,
            getFileUndoViewEnabled: () => false,
            marker: 'state-context',
        } as any)),
        preferences,
        effects,
        eventEffects,
    });
    return {
        host,
        tabs,
        chat,
        commands,
        factory,
        effects,
        eventEffects,
        preferences,
        created,
        order,
        getCacheMode: () => cacheMode,
        getFavorites: () => favorites,
    };
}

describe('portable ChatHost', () => {
    it('creates active tabs and restores session paths without activating them', async () => {
        const { host, tabs, factory, effects, order } = createHarness();
        const initial = createTab('initial');
        host.register(initial, { activate: true });

        const createdId = await host.createTab();
        expect(tabs.activeId).toBe(createdId);
        expect(order).toEqual([
            `bind:${createdId}`,
            'persist',
            'tabs',
            `open:${createdId}`,
            `state:${createdId}`,
        ]);

        order.length = 0;
        const restoredId = await host.createTabFromSessionPath('/sessions/restored.jsonl');
        expect(factory).toHaveBeenLastCalledWith({
            kind: 'sessionPath',
            sessionPath: '/sessions/restored.jsonl',
        });
        expect(tabs.activeId).toBe(createdId);
        expect(tabs.has(restoredId)).toBe(true);
        expect(order).toEqual([`bind:${restoredId}`, 'persist']);
        expect(effects.openTab).toHaveBeenCalledTimes(1);
    });

    it('rolls back a created runtime when binding fails', async () => {
        const { host, factory, effects, tabs } = createHarness();
        const first = createTab('first');
        const active = createTab('active');
        host.register(first);
        host.register(active, { activate: true });
        const created = createTab('created');
        factory.mockResolvedValueOnce(created);
        effects.bindTab.mockImplementationOnce(() => { throw new Error('bind failed'); });

        await expect(host.createTab()).rejects.toThrow('bind failed');

        expect(created.disposeResources).toHaveBeenCalledOnce();
        expect(tabs.has(created.id)).toBe(false);
        expect(tabs.activeId).toBe(active.id);
        expect(effects.persistTabs).not.toHaveBeenCalled();
        expect(effects.openTab).not.toHaveBeenCalled();
    });

    it('removes failed membership even when rollback disposal reports an error', async () => {
        const { host, factory, effects, tabs } = createHarness();
        const active = createTab('active');
        host.register(active, { activate: true });
        const created = createTab('created');
        created.disposeResources = vi.fn(async () => { throw new Error('dispose failed'); });
        factory.mockResolvedValueOnce(created);
        effects.bindTab.mockImplementationOnce(() => { throw new Error('bind failed'); });

        await expect(host.createTab()).rejects.toThrow('bind failed');

        expect(created.disposeResources).toHaveBeenCalledOnce();
        expect(tabs.has(created.id)).toBe(false);
        expect(tabs.activeId).toBe(active.id);
    });

    it('keeps close minimum-one and drop final-tab behavior distinct', async () => {
        const { host, tabs, effects } = createHarness();
        const first = createTab('first');
        const second = createTab('second');
        host.register(first, { activate: true });

        await expect(host.closeTab(first.id)).resolves.toBe(false);
        expect(first.disposeResources).not.toHaveBeenCalled();

        host.register(second);
        await expect(host.closeTab(first.id)).resolves.toBe(true);
        expect(first.disposeResources).toHaveBeenCalledOnce();
        expect(tabs.activeId).toBe(second.id);
        expect(effects.publishState).toHaveBeenCalledWith(second.id);

        await expect(host.dropTab(second.id)).resolves.toBe(true);
        expect(second.disposeResources).toHaveBeenCalledOnce();
        expect(tabs.size).toBe(0);
        expect(tabs.activeId).toBe('');
    });

    it('activates frontend-focused tabs without applying command-switch notification policy', () => {
        const { host, tabs, effects } = createHarness();
        const first = createTab('first');
        const second = createTab('second');
        second.hasNotification = true;
        host.register(first, { activate: true });
        host.register(second);

        expect(host.activateTab(second.id)).toBe(true);
        expect(tabs.activeId).toBe(second.id);
        expect(second.hasNotification).toBe(true);
        expect(effects.activeTabChanged).toHaveBeenCalledWith(second);
        expect(effects.persistTabs).not.toHaveBeenCalled();
        expect(effects.publishState).not.toHaveBeenCalled();
    });

    it('switches only to registered tabs, clears unread state, and publishes the selection', () => {
        const { host, tabs, effects, order } = createHarness();
        const first = createTab('first');
        const second = createTab('second');
        second.hasNotification = true;
        host.register(first, { activate: true });
        host.register(second);

        expect(host.switchTab('missing')).toBe(false);
        expect(host.switchTab(second.id)).toBe(true);
        expect(tabs.activeId).toBe(second.id);
        expect(second.hasNotification).toBe(false);
        expect(order).toEqual(['active:second', 'persist', 'tabs', 'state:second']);
        expect(effects.activeTabChanged).toHaveBeenCalledWith(second);
    });

    it('cleans up a restored runtime when post-factory binding fails', async () => {
        const { host, factory, effects, tabs } = createHarness();
        const restored = createTab('restored');
        factory.mockResolvedValueOnce(restored);
        effects.bindTab.mockImplementationOnce(() => { throw new Error('bind failed'); });

        await expect(host.restoreTabs({
            tabs: [{ name: 'Restored', sessionPath: '/sessions/restored.jsonl' }],
            activeIndex: 0,
        })).resolves.toEqual([]);

        expect(restored.disposeResources).toHaveBeenCalledOnce();
        expect(tabs.has(restored.id)).toBe(false);
        expect(effects.restoreFailed).toHaveBeenCalledWith(
            { name: 'Restored', sessionPath: '/sessions/restored.jsonl' },
            expect.objectContaining({ message: 'bind failed' }),
        );
    });

    it('restores persisted tabs, drops the bootstrap tab, and keeps failures isolated', async () => {
        const { host, tabs, factory, effects } = createHarness();
        const bootstrap = createTab('bootstrap');
        host.register(bootstrap, { activate: true });
        factory
            .mockResolvedValueOnce(createTab('restored-a'))
            .mockRejectedValueOnce(new Error('locked'))
            .mockResolvedValueOnce(createTab('restored-c'));

        const restored = await host.restoreTabs({
            tabs: [
                { name: 'A', sessionPath: '/sessions/a.jsonl' },
                { name: 'B', sessionPath: '/sessions/b.jsonl' },
                { name: 'C', sessionPath: '/sessions/c.jsonl' },
            ],
            activeIndex: 1,
        }, bootstrap.id);

        expect(restored).toEqual(['restored-a', 'restored-c']);
        expect(bootstrap.disposeResources).toHaveBeenCalledOnce();
        expect(tabs.has(bootstrap.id)).toBe(false);
        expect(tabs.activeId).toBe('restored-c');
        expect(effects.restoreFailed).toHaveBeenCalledWith(
            { name: 'B', sessionPath: '/sessions/b.jsonl' },
            expect.objectContaining({ message: 'locked' }),
        );
        expect(effects.publishState).toHaveBeenLastCalledWith('restored-c');
    });

    it('routes semantic commands and executes session, tab, and preference intents', async () => {
        const {
            host,
            tabs,
            commands,
            preferences,
            chat,
            effects,
            getCacheMode,
            getFavorites,
        } = createHarness();
        const tab = createTab('tab-1');
        host.register(tab, { activate: true });

        commands.dispatch.mockResolvedValueOnce({});
        await expect(host.dispatch({ type: 'abort' }, tab.id)).resolves.toEqual({ ok: true });
        expect(commands.dispatch).toHaveBeenCalledWith(
            tab,
            { type: 'abort' },
            expect.objectContaining({ getFavorites: expect.any(Function) }),
        );

        commands.dispatch.mockResolvedValueOnce({ intent: { type: 'setCacheMode', mode: 'long' } });
        await host.dispatch({ type: 'setCacheMode', mode: 'long' }, tab.id);
        expect(getCacheMode()).toBe('long');
        expect(preferences.refreshCacheEffective).toHaveBeenCalledWith(tab);
        expect(effects.publishState).toHaveBeenCalledWith(tab.id);

        commands.dispatch.mockResolvedValueOnce({
            intent: { type: 'toggleFavorite', provider: 'provider', modelId: 'model' },
        });
        await host.dispatch({ type: 'toggleFavorite', provider: 'provider', modelId: 'model' }, tab.id);
        expect(getFavorites()).toEqual([]);
        expect(effects.modelsChanged).toHaveBeenCalled();

        let persistedSessionPath: string | undefined;
        (tab.session as any).sessionPath = '/sessions/old.jsonl';
        (tab.session.newSession as any).mockImplementationOnce(async () => {
            (tab.session as any).sessionPath = '/sessions/new.jsonl';
        });
        effects.persistTabs.mockReset();
        effects.persistTabs.mockImplementation(() => {
            persistedSessionPath = (tab.session as any).sessionPath;
        });
        commands.dispatch.mockResolvedValueOnce({ intent: { type: 'newSession' } });
        await host.dispatch({ type: 'newSession' }, tab.id);
        expect(tab.session.newSession).toHaveBeenCalledOnce();
        expect(preferences.applyPersistedToolSelection).toHaveBeenCalledWith(tab);
        expect(chat.resetSessionProjection).toHaveBeenCalledWith(tab, undefined, []);
        expect(effects.persistTabs).toHaveBeenCalledOnce();
        expect(persistedSessionPath).toBe('/sessions/new.jsonl');

        commands.dispatch.mockResolvedValueOnce({
            intent: { type: 'loadSession', sessionPath: '/sessions/loaded.jsonl' },
        });
        await host.dispatch({ type: 'loadSession', sessionPath: '/sessions/loaded.jsonl' }, tab.id);
        expect(tab.session.loadSession).toHaveBeenCalledWith('/sessions/loaded.jsonl');
        expect(tab.projectToolDefault).toBeUndefined();
        expect(effects.persistTabs).toHaveBeenCalled();
        expect(tabs.activeId).toBe(tab.id);
    });

    it('settles events and reserves queued work before asynchronous dispatch', async () => {
        const { host, chat, effects, eventEffects, order } = createHarness();
        const tab = createTab('tab-1') as any;
        tab.queuedMessages = ['next'];
        tab.session.isStreaming = false;
        host.register(tab, { activate: true });
        chat.settleAgent.mockReturnValueOnce({ tabName: 'tab-1', outcome: 'success', durationMs: 10 });
        chat.reserveQueuedDispatch.mockImplementationOnce(() => {
            order.push('reserve');
            return true;
        });
        effects.publishState.mockImplementationOnce((tabId: string) => order.push(`state:${tabId}`));
        eventEffects.emitAgentEvent.mockImplementationOnce(() => order.push('event'));
        eventEffects.dispatchNextQueued.mockImplementationOnce(async () => { order.push('dispatch'); });

        await host.handleEvent(tab, { type: 'agent_settled' });

        expect(eventEffects.notifyTurnCompletion).toHaveBeenCalledOnce();
        expect(order).toEqual(['reserve', 'state:tab-1', 'event', 'dispatch']);
    });

    it('mutates active-tab preferences with shared busy and tool-selection policy', async () => {
        const { host, preferences, effects } = createHarness();
        const tab = createTab('tab-1');
        host.register(tab, { activate: true });

        tab.isStreamingLocal = true;
        await expect(host.setActiveTodoEnabled(false)).resolves.toBe(false);
        await expect(host.setActivePlanModeEnabled(true)).resolves.toBe(false);
        await expect(host.setActiveFileUndoViewEnabled(true)).resolves.toBe(false);
        await expect(host.setActiveToolDisabled('read', true)).resolves.toBe(false);
        expect(preferences.setTodoEnabled).not.toHaveBeenCalled();

        tab.isStreamingLocal = false;
        await expect(host.setActiveTodoEnabled(false)).resolves.toBe(true);
        expect(preferences.setTodoEnabled).toHaveBeenCalledWith(tab, false);
        expect(preferences.applyPersistedToolSelection).toHaveBeenCalledWith(tab);

        await host.setActiveToolDisabled('read', true);
        expect(preferences.setDisabledTools).toHaveBeenCalledWith(tab, ['write', 'read']);
        await host.setActiveToolDisabled('write', false);
        expect(preferences.setDisabledTools).toHaveBeenLastCalledWith(tab, []);
        await host.setActiveToolDisabled('todo', false);
        expect(preferences.setTodoEnabled).toHaveBeenLastCalledWith(tab, true);
        await host.setActiveToolDisabled('subagent', true);
        expect(preferences.setSubagentsEnabled).toHaveBeenCalledWith(tab, false);

        await host.setActiveToolsBulk(['todo', 'subagent', 'read', 'read', '']);
        expect(preferences.setTodoEnabled).toHaveBeenLastCalledWith(tab, false);
        expect(preferences.setSubagentsEnabled).toHaveBeenLastCalledWith(tab, false);
        expect(preferences.setDisabledTools).toHaveBeenLastCalledWith(tab, ['read']);

        await host.setActivePlanModeEnabled(true);
        expect(preferences.setPlanModeEnabled).toHaveBeenCalledWith(tab, true);
        await host.setActiveFileUndoViewEnabled(true);
        expect(preferences.setFileUndoViewEnabled).toHaveBeenCalledWith(tab, true);
        expect(effects.publishState).toHaveBeenCalledWith(tab.id);
        expect(effects.tabsChanged).toHaveBeenCalled();
    });

    it('routes portable control intents through shared preference policy and publishes authoritative state', async () => {
        const { host, commands, preferences, effects } = createHarness();
        const tab = createTab('tab-1');
        host.register(tab, { activate: true });
        commands.dispatch.mockImplementation(async (_tab: unknown, message: any) => ({ intent: message }));

        await expect(host.dispatch({ type: 'setModel', provider: 'provider', modelId: 'model' }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setThinkingLevel', level: 'high' }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setTodoEnabled', enabled: false }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setSubagentsEnabled', enabled: true }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setPlanModeEnabled', enabled: true }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setFileUndoViewEnabled', enabled: true }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setToolDisabled', toolName: 'read', disabled: true }, tab.id)).resolves.toEqual({ ok: true });
        await expect(host.dispatch({ type: 'setToolsBulk', disabled: ['read'] }, tab.id)).resolves.toEqual({ ok: true });

        expect(tab.session.setModel).toHaveBeenCalledWith('provider', 'model');
        expect(tab.session.setThinkingLevel).toHaveBeenCalledWith('high');
        expect(preferences.setTodoEnabled).toHaveBeenCalledWith(tab, false);
        expect(preferences.setSubagentsEnabled).toHaveBeenCalledWith(tab, true);
        expect(preferences.setPlanModeEnabled).toHaveBeenCalledWith(tab, true);
        expect(preferences.setFileUndoViewEnabled).toHaveBeenCalledWith(tab, true);
        expect(preferences.setDisabledTools).toHaveBeenCalled();
        expect(effects.publishState.mock.calls.filter(([tabId]) => tabId === tab.id).length).toBeGreaterThanOrEqual(8);

        tab.isStreamingLocal = true;
        await expect(host.dispatch({ type: 'setModel', provider: 'other', modelId: 'busy' }, tab.id)).resolves.toMatchObject({
            ok: false,
            code: 'command_failed',
        });
        await expect(host.dispatch({ type: 'setThinkingLevel', level: 'low' }, tab.id)).resolves.toMatchObject({
            ok: false,
            code: 'command_failed',
        });
        await expect(host.dispatch({ type: 'setPlanModeEnabled', enabled: false }, tab.id)).resolves.toMatchObject({
            ok: false,
            code: 'command_failed',
        });
    });

    it('returns typed failures and projects state with host-owned tab context', async () => {
        const { host, commands, effects } = createHarness();
        const tab = createTab('tab-1');
        host.register(tab, { activate: true });

        expect(host.getState()).toEqual({
            activeTabId: 'tab-1',
            tabs: [{
                id: 'tab-1',
                name: 'tab-1',
                isActive: true,
                isStreaming: false,
                hasNotification: false,
            }],
            marker: 'state-context',
        });
        await expect(host.dispatch({ type: 'abort' }, 'missing')).resolves.toEqual({
            ok: false,
            code: 'tab_not_found',
            message: 'Chat tab not found: missing',
        });

        commands.dispatch.mockRejectedValueOnce(new Error('Abort failed'));
        await expect(host.dispatch({ type: 'abort' }, tab.id)).resolves.toEqual({
            ok: false,
            code: 'command_failed',
            message: 'Abort failed',
        });
        expect(effects.reportCommandFailure).toHaveBeenCalledWith(
            'abort',
            tab.id,
            expect.objectContaining({ message: 'Abort failed' }),
        );
    });
});
