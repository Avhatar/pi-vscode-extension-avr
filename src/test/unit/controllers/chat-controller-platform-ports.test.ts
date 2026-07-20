import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import { ChatService } from '../../../core/chat/chat-service';
import { TabRegistry } from '../../../core/chat/tab-registry';
import type { StateStore } from '../../../core/ports/chat-platform';

function createTabRegistry(tabs: any[], activeId?: string): TabRegistry<any> {
    const registry = new TabRegistry<any>();
    for (const tab of tabs) registry.register(tab);
    if (activeId) registry.activate(activeId);
    return registry;
}

function createStateStore(initial: Record<string, unknown> = {}): StateStore & {
    values: Map<string, unknown>;
    update: ReturnType<typeof vi.fn>;
} {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get<T>(key: string, fallback?: T): T | undefined {
            return (values.has(key) ? values.get(key) : fallback) as T | undefined;
        },
        update: vi.fn(async (key: string, value: unknown) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    } as any;
}

describe('ChatController platform ports', () => {
    it('reads and writes global chat preferences through the injected state scope', async () => {
        const globalState = createStateStore({
            'pi-code.notifications.showPopup': true,
            'pi-code.notifications.playSound': false,
        });
        const fire = vi.fn();
        const controller = Object.create(ChatController.prototype) as any;
        controller._globalState = globalState;
        controller._onLauncherStateChanged = { fire };

        expect(controller.getTurnNotificationSettings()).toEqual({
            showPopup: true,
            playSound: false,
        });

        await controller.setNotificationPlaySound(true);

        expect(globalState.update).toHaveBeenCalledWith('pi-code.notifications.playSound', true);
        expect(globalState.values.get('pi-code.notifications.playSound')).toBe(true);
        expect(fire).toHaveBeenCalledOnce();
    });

    it('keeps per-session and project preferences in the injected workspace scope', async () => {
        const sessionPath = '/sessions/chat.jsonl';
        const workspaceState = createStateStore({
            [`pi-code.todoEnabled.${sessionPath}`]: false,
            [`pi-code.planModeEnabled.${sessionPath}`]: true,
            [`pi-code.fileUndoViewEnabled.${sessionPath}`]: true,
            [`pi-code.disabledTools.${sessionPath}`]: ['read', 42, 'read'],
            'pi-code.projectToolSelectionDefault': { version: 1, enabled: ['read', 'todo'] },
        });
        const controller = Object.create(ChatController.prototype) as any;
        controller._workspaceState = workspaceState;
        controller._todoDefaultEnabled = vi.fn(() => true);
        controller._planModeDefaultEnabled = vi.fn(() => false);
        controller._fileUndoViewDefaultEnabled = vi.fn(() => false);
        const tab = {
            session: {
                sessionPath,
                getRegisteredToolsInfo: () => [{ name: 'read' }, { name: 'write' }],
            },
            projectToolDefault: undefined,
        };

        expect(controller._isTodoEnabledFor(tab)).toBe(false);
        expect(controller._isPlanModeEnabledFor(tab)).toBe(true);
        expect(controller._isFileUndoViewEnabledFor(tab)).toBe(true);
        expect(controller._getDisabledToolsFor(tab)).toEqual(['read', 'read']);
        expect(controller._getProjectToolSelectionDefault()).toEqual({
            version: 1,
            enabled: ['read', 'todo'],
        });

        await controller._setDisabledToolsFor(tab, ['write', 'write', '', 'read']);
        expect(workspaceState.update).toHaveBeenCalledWith(
            `pi-code.disabledTools.${sessionPath}`,
            ['write', 'read'],
        );
    });

    it('persists turn start before delegating portable event projection', async () => {
        const order: string[] = [];
        const tab: any = {
            id: 'tab-1',
            name: 'Chat',
            session: {
                markTurnStarted: vi.fn(() => order.push('persist-start')),
                getCurrentModel: vi.fn(() => undefined),
            },
            queuedMessages: [],
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._chatService = {
            reduceEvent: vi.fn(() => order.push('reduce-event')),
        };
        controller._onLauncherStateChanged = { fire: vi.fn() };
        controller._updateTabName = vi.fn();
        controller._postForTab = vi.fn();
        controller.sendStateSync = vi.fn();

        await controller._handleTabEvent(tab, { type: 'agent_start' });

        expect(order).toEqual(['persist-start', 'reduce-event']);
    });

    it('routes VS Code diff review through the injected presenter', async () => {
        const review = {
            filePath: 'src/main.ts',
            absolutePath: '/workspace/src/main.ts',
            toolCallId: 'tool-1',
            originalContent: 'before',
        };
        const diffManager = { getReview: vi.fn(() => review) };
        const openDiff = vi.fn(async () => undefined);
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([{ id: 'tab-1', diffManager }], 'tab-1');
        controller._fileChangePorts = { diffPresenter: { openDiff } };
        controller._outputChannel = { appendLine: vi.fn() };

        await expect(controller.handleMessage({
            type: 'openDiff',
            filePath: 'src/main.ts',
            toolCallId: 'tool-1',
        }, 'tab-1')).resolves.toEqual({ ok: true });

        expect(diffManager.getReview).toHaveBeenCalledWith('src/main.ts', 'tool-1');
        expect(openDiff).toHaveBeenCalledWith(review);
    });

    it('preserves checkpoint, diff, message, and state-sync ordering for restore and redo', async () => {
        const order: string[] = [];
        const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }];
        const tab: any = {
            id: 'tab-1',
            checkpointManager: {
                restoreCheckpoint: vi.fn(async () => { order.push('restore-files'); return []; }),
                redoCheckpoint: vi.fn(async () => { order.push('redo-files'); return []; }),
            },
            diffManager: {
                suspendChangesAfter: vi.fn(() => order.push('suspend-diffs')),
                redoChanges: vi.fn(() => order.push('redo-diffs')),
            },
            session: {
                getMessages: vi.fn(() => { order.push('get-messages'); return messages; }),
                setMessages: vi.fn(() => order.push('set-messages')),
            },
            suspendedMessages: [],
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._outputChannel = { appendLine: vi.fn() };
        controller._chatService = new ChatService({ now: () => 0 });
        controller.sendStateSync = vi.fn(() => order.push('state-sync'));

        await controller.handleMessage({ type: 'restoreCheckpoint', messageIndex: 0 }, 'tab-1');
        expect(order).toEqual([
            'restore-files',
            'suspend-diffs',
            'get-messages',
            'set-messages',
            'state-sync',
        ]);
        expect(tab.suspendedMessages).toEqual(messages);

        order.length = 0;
        await controller.handleMessage({ type: 'redoCheckpoint' }, 'tab-1');
        expect(order).toEqual([
            'redo-files',
            'redo-diffs',
            'get-messages',
            'set-messages',
            'state-sync',
        ]);
        expect(tab.suspendedMessages).toEqual([]);
    });

    it('rejects file rollback and redo while the owning agent is still running', async () => {
        const tab: any = {
            id: 'tab-1',
            isStreamingLocal: true,
            isCompacting: false,
            checkpointManager: {
                restoreCheckpoint: vi.fn(async () => []),
                redoCheckpoint: vi.fn(async () => []),
            },
            diffManager: {
                undoFileChange: vi.fn(async () => undefined),
                suspendChangesAfter: vi.fn(),
                redoChanges: vi.fn(),
            },
            session: {
                getMessages: vi.fn(() => []),
                setMessages: vi.fn(),
            },
            suspendedMessages: [],
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._outputChannel = { appendLine: vi.fn() };
        controller._chatService = new ChatService({ now: () => 0 });
        controller._postForTab = vi.fn();
        controller.sendStateSync = vi.fn();

        const requests = [
            { type: 'undoFileChange', filePath: 'src/main.ts', toolCallId: 'tool-1' },
            { type: 'restoreCheckpoint', messageIndex: 0 },
            { type: 'redoCheckpoint' },
            {
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: 'Undo changes from the last turn?',
                payload: { messageIndex: 0 },
            },
        ] as const;
        for (const request of requests) {
            await expect(controller.handleMessage(request, 'tab-1')).resolves.toMatchObject({
                ok: false,
                code: 'command_failed',
                message: 'Wait for the agent to finish before undoing or redoing file changes.',
            });
        }

        expect(tab.diffManager.undoFileChange).not.toHaveBeenCalled();
        expect(tab.checkpointManager.restoreCheckpoint).not.toHaveBeenCalled();
        expect(tab.checkpointManager.redoCheckpoint).not.toHaveBeenCalled();
        expect(controller.sendStateSync).not.toHaveBeenCalled();
    });

    it('aligns a loaded session checkpoint counter with its persisted user-turn count', async () => {
        const resetSessionProjection = vi.fn();
        const tab: any = {
            id: 'tab-1',
            session: {
                loadSession: vi.fn(async () => undefined),
                getMessages: vi.fn(() => [
                    { role: 'user', content: 'first' },
                    { role: 'assistant', content: 'reply' },
                    { role: 'custom', customType: 'metadata' },
                    { role: 'user', content: 'second' },
                ]),
            },
            diffManager: { clearAll: vi.fn() },
            checkpointManager: { clearAll: vi.fn() },
            resetSessionProjection,
        };
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([tab], 'tab-1');
        controller._outputChannel = { appendLine: vi.fn() };
        controller._applyPersistedToolSelection = vi.fn();
        controller._chatService = new ChatService({ now: () => 0 });
        controller._updateTabName = vi.fn();
        controller._persistTabs = vi.fn();
        controller.sendStateSync = vi.fn();

        await expect(controller.handleMessage({
            type: 'loadSession',
            sessionPath: '/sessions/restored.jsonl',
        }, 'tab-1')).resolves.toEqual({ ok: true });

        expect(resetSessionProjection).toHaveBeenCalledWith(undefined, 2);
    });

    it('routes cold workspace-file searches through the injected file-mentions port', async () => {
        let finishIndexing!: () => void;
        const indexing = new Promise<void>((resolve) => { finishIndexing = resolve; });
        const items = [{ relativePath: 'src/main.ts', basename: 'main.ts', insertText: '@src/main.ts ' }];
        const fileMentions = {
            isReady: false,
            ensureIndexed: vi.fn(() => indexing),
            search: vi.fn(async () => items),
            augmentPromptIfNeeded: vi.fn(async (text: string) => text),
        };
        const postForTab = vi.fn();
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = createTabRegistry([{ id: 'tab-1' }], 'tab-1');
        controller._fileMentions = fileMentions;
        controller._postForTab = postForTab;
        controller._outputChannel = { appendLine: vi.fn() };

        const dispatch = controller.handleMessage({
            type: 'searchWorkspaceFiles',
            query: 'main',
            requestId: 7,
        }, 'tab-1');

        await vi.waitFor(() => expect(postForTab).toHaveBeenCalledWith('tab-1', {
            type: 'workspaceFileSuggestions',
            requestId: 7,
            query: 'main',
            isIndexing: true,
            items: [],
        }));
        finishIndexing();
        await expect(dispatch).resolves.toEqual({ ok: true });
        expect(fileMentions.search).toHaveBeenCalledWith('main');
        expect(postForTab).toHaveBeenLastCalledWith('tab-1', {
            type: 'workspaceFileSuggestions',
            requestId: 7,
            query: 'main',
            items,
        });
    });
});
