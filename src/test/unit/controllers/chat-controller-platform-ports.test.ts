import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';
import type { StateStore } from '../../../core/ports/chat-platform';

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
        controller._tabs = new Map([['tab-1', { id: 'tab-1', diffManager }]]);
        controller._activeTabId = 'tab-1';
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
        controller._tabs = new Map([['tab-1', tab]]);
        controller._activeTabId = 'tab-1';
        controller._outputChannel = { appendLine: vi.fn() };
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
        controller._tabs = new Map([['tab-1', { id: 'tab-1' }]]);
        controller._activeTabId = 'tab-1';
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
