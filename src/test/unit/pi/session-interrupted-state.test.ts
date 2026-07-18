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
        dispose: () => undefined,
    };
}

describe('PiSessionManager interrupted turn state', () => {
    it('persists explicit turn lifecycle boundaries outside model context', () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        const appendCustomEntry = vi.fn();
        manager._sessionManager = { appendCustomEntry };

        manager.markTurnStarted();
        manager.markTurnCompleted();

        expect(appendCustomEntry.mock.calls).toEqual([
            ['pi-code.turn-lifecycle', { status: 'started' }],
            ['pi-code.turn-lifecycle', { status: 'completed' }],
        ]);
        manager.dispose();
    });

    it('marks an idle restored session whose persisted tail still requires continuation', () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        manager._session = createSession([
            { role: 'user', content: 'Work' },
            { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'todo' }] },
            { role: 'toolResult', toolCallId: 'tool-1', toolName: 'todo', content: [] },
        ], false);
        manager._sessionManager = {
            getBranch: () => [{
                type: 'custom',
                customType: 'pi-code.turn-lifecycle',
                data: { status: 'started' },
            }],
        };

        expect(manager.serializeState()).toMatchObject({
            isStreaming: false,
            interruptedTurn: { reason: 'incomplete_session_tail' },
        });
        manager.dispose();
    });

    it('does not mark a live turn or a completed assistant tail as interrupted', () => {
        const manager = new PiSessionManager({ appendLine(): void {} } as any) as any;
        manager._sessionManager = {
            getBranch: () => [{
                type: 'custom',
                customType: 'pi-code.turn-lifecycle',
                data: { status: 'started' },
            }],
        };
        manager._session = createSession([{ role: 'user', content: 'Work' }], true);
        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');

        manager._session = createSession([{ role: 'user', content: 'Work' }], false, true);
        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');

        manager._sessionManager = {
            getBranch: () => [{
                type: 'custom',
                customType: 'pi-code.turn-lifecycle',
                data: { status: 'completed' },
            }],
        };
        manager._session = createSession([
            { role: 'user', content: 'Work' },
            { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
        ], false);
        expect(manager.serializeState()).not.toHaveProperty('interruptedTurn');
        manager.dispose();
    });
});
