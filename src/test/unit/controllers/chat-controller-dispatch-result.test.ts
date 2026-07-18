import { describe, expect, it, vi } from 'vitest';
import { ChatController } from '../../../controllers/chat-controller';

describe('ChatController command dispatch results', () => {
    it('acknowledges a prompt after dispatch without waiting for the model turn', async () => {
        let settleTurn!: () => void;
        const turn = new Promise<void>((resolve) => { settleTurn = resolve; });
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map([['tab-1', {
            id: 'tab-1',
            session: {},
            checkpointManager: {
                rollbackPoint: null,
                startTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            diffManager: {
                setCurrentTurn: vi.fn(),
                discardSuspended: vi.fn(),
            },
            suspendedMessages: [],
            turnCounter: 0,
        }]]);
        controller._activeTabId = 'tab-1';
        controller._fileMentions = { augmentPromptIfNeeded: vi.fn(async (text: string) => text) };
        controller._isPlanModeEnabledFor = vi.fn(() => false);
        controller._prepareCacheForRequest = vi.fn();
        controller._logPromptToolState = vi.fn();
        controller._promptUserTask = vi.fn(() => turn);
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        let result: unknown;
        void controller.handleMessage({ type: 'prompt', text: 'hello' }, 'tab-1')
            .then((value: unknown) => { result = value; });
        await vi.waitFor(() => expect(result).toEqual({ ok: true }));
        expect(controller._promptUserTask).toHaveBeenCalledOnce();

        settleTurn();
        await turn;
    });

    it('reports a missing target tab without dispatching', async () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map();
        controller._activeTabId = 'missing-tab';

        await expect(controller.handleMessage({ type: 'abort' }, 'missing-tab')).resolves.toEqual({
            ok: false,
            code: 'tab_not_found',
            message: 'Chat tab not found: missing-tab',
        });
    });

    it('returns command_failed while preserving the existing error event', async () => {
        const controller = Object.create(ChatController.prototype) as any;
        controller._tabs = new Map([['tab-1', {
            id: 'tab-1',
            session: { abort: vi.fn().mockRejectedValue(new Error('Abort failed')) },
        }]]);
        controller._activeTabId = 'tab-1';
        controller._outputChannel = { appendLine: vi.fn() };
        controller._postForTab = vi.fn();

        await expect(controller.handleMessage({ type: 'abort' }, 'tab-1')).resolves.toEqual({
            ok: false,
            code: 'command_failed',
            message: 'Abort failed',
        });
        expect(controller._postForTab).toHaveBeenCalledWith('tab-1', {
            type: 'error',
            message: 'Abort failed',
        });
    });
});
