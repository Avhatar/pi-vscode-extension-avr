import { describe, expect, it, vi } from 'vitest';
import { PiSessionManager } from '../../../pi/session';

function createSession(messages: any[], isStreaming: boolean, isCompacting = false): any {
    return {
        messages,
        model: undefined,
        thinkingLevel: 'medium',
        isStreaming,
        isCompacting,
        sessionId: 'session-1',
        sessionName: 'Session',
        getActiveToolNames: () => [],
        getContextUsage: () => undefined,
        subscribe: () => () => undefined,
        dispose: () => undefined,
    };
}

async function startRuntime(manager: any, session: any, sessionManager: any): Promise<void> {
    await manager._runtime.start(async () => ({ session, sessionManager }));
}

async function replaceRuntime(manager: any, session: any, sessionManager: any): Promise<void> {
    await manager._runtime.replace(async () => ({ session, sessionManager }));
}

describe('PiSessionManager interrupted turn state', () => {
    it('persists explicit turn lifecycle boundaries outside model context', async () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        const appendCustomEntry = vi.fn();
        await startRuntime(manager, createSession([], false), { appendCustomEntry });

        manager.markTurnStarted();
        manager.markTurnCompleted();

        expect(appendCustomEntry.mock.calls).toEqual([
            ['pi-code.turn-lifecycle', { status: 'started' }],
            ['pi-code.turn-lifecycle', { status: 'completed' }],
        ]);
        await manager.dispose();
    });

    it('marks an idle restored session whose persisted tail still requires continuation', async () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        const session = createSession([
            { role: 'user', content: 'Work' },
            { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'todo' }] },
            { role: 'toolResult', toolCallId: 'tool-1', toolName: 'todo', content: [] },
        ], false);
        await startRuntime(manager, session, {
            getBranch: () => [{
                type: 'custom',
                customType: 'pi-code.turn-lifecycle',
                data: { status: 'started' },
            }],
        });

        expect(manager.serializeState()).toMatchObject({
            isStreaming: false,
            interruptedTurn: { reason: 'incomplete_session_tail' },
        });
        await manager.dispose();
    });

    it('lets a completed lifecycle marker override an assistant tool-call tail', async () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        await startRuntime(manager, createSession([{
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tool-1', name: 'edit' }],
            stopReason: 'aborted',
        }], false), {
            getBranch: () => [{
                type: 'custom',
                customType: 'pi-code.turn-lifecycle',
                data: { status: 'completed' },
            }],
        });

        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');
        await manager.dispose();
    });

    it('does not mark a live turn or a completed assistant tail as interrupted', async () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        const getBranch = vi.fn(() => [{
            type: 'custom',
            customType: 'pi-code.turn-lifecycle',
            data: { status: 'started' },
        }]);
        const startedLifecycle = { getBranch };
        await startRuntime(
            manager,
            createSession([{ role: 'user', content: 'Work' }], true),
            startedLifecycle,
        );
        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');
        expect(getBranch).not.toHaveBeenCalled();

        await replaceRuntime(
            manager,
            createSession([{ role: 'user', content: 'Work' }], false, true),
            startedLifecycle,
        );
        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');
        expect(getBranch).not.toHaveBeenCalled();

        await replaceRuntime(manager, createSession([
            { role: 'user', content: 'Work' },
            { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
        ], false), {
            getBranch: () => [{
                type: 'custom',
                customType: 'pi-code.turn-lifecycle',
                data: { status: 'completed' },
            }],
        });
        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');
        await manager.dispose();
    });
});
