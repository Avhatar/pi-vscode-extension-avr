import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol';
import { createAgentRequestEnvelope } from '../../../shared/connection-protocol';
import { ChatPanelConnection } from '../../../providers/chat-panel-connection';
import type { ChatCommandDispatchResult } from '../../../controllers/chat-controller';

const emptyState: ServerMessage = {
    type: 'stateSync',
    state: { messages: [], isStreaming: false, tools: [] },
};

function request(
    clientId: string,
    requestId: string,
    message: ClientMessage,
    tabId = 'tab-1',
) {
    return createAgentRequestEnvelope({ clientId, requestId, tabId }, message);
}

describe('ChatPanelConnection', () => {
    it('buffers events until a getState handshake binds a client', async () => {
        const posted: unknown[] = [];
        const dispatch = vi.fn(async (): Promise<ChatCommandDispatchResult> => ({ ok: true }));
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));

        connection.publish({ type: 'ready' });
        connection.publish(emptyState);
        expect(posted).toEqual([]);

        await connection.receive(request('client-1', 'request-1', { type: 'getState' }));

        expect(dispatch).toHaveBeenCalledWith({ type: 'getState' }, 'tab-1');
        expect(posted).toMatchObject([
            { clientId: 'client-1', sequence: 1, tabId: 'tab-1', type: 'ready', payload: {} },
            { clientId: 'client-1', sequence: 2, tabId: 'tab-1', type: 'stateSync' },
            { clientId: 'client-1', requestId: 'request-1', ok: true },
        ]);
    });

    it('returns command results on the correlated response instead of relying on a one-shot event', async () => {
        const posted: any[] = [];
        const dispatch = vi.fn(async () => ({ ok: true, result: { confirmed: true } } as any));
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));
        await connection.receive(request('client-1', 'handshake', { type: 'getState' }));
        posted.length = 0;

        await connection.receive(request('client-1', 'confirm-1', {
            type: 'confirmAction', action: 'restoreCheckpoint', message: 'Confirm?',
        }));

        expect(posted).toEqual([expect.objectContaining({
            requestId: 'confirm-1',
            ok: true,
            result: { confirmed: true },
        })]);
    });

    it('rejects malformed, mismatched-tab, and mismatched-client requests', async () => {
        const posted: any[] = [];
        const dispatch = vi.fn(async (): Promise<ChatCommandDispatchResult> => ({ ok: true }));
        const logRejected = vi.fn();
        const connection = new ChatPanelConnection(
            'tab-1',
            dispatch,
            (value) => posted.push(value),
            logRejected,
        );

        await connection.receive({ type: 'abort' });
        expect(dispatch).not.toHaveBeenCalled();
        expect(posted).toEqual([]);
        expect(logRejected).toHaveBeenCalledOnce();

        const malformed = request('client-1', 'malformed', { type: 'abort' });
        await connection.receive({ ...malformed, payload: { unexpected: true } });
        expect(posted.at(-1)).toMatchObject({
            clientId: 'client-1',
            requestId: 'malformed',
            ok: false,
            error: { code: 'invalid_request' },
        });
        expect(dispatch).not.toHaveBeenCalled();

        await connection.receive(request('client-1', 'handshake-required', { type: 'abort' }));
        expect(posted.at(-1)).toMatchObject({
            clientId: 'client-1',
            requestId: 'handshake-required',
            ok: false,
            error: { code: 'handshake_required' },
        });
        expect(dispatch).not.toHaveBeenCalled();

        await connection.receive(request('client-1', 'wrong-tab', { type: 'abort' }, 'tab-2'));
        expect(posted.at(-1)).toMatchObject({
            clientId: 'client-1',
            requestId: 'wrong-tab',
            ok: false,
            error: { code: 'tab_mismatch' },
        });
        expect(dispatch).not.toHaveBeenCalled();

        await connection.receive(request('client-1', 'bind', { type: 'getState' }));
        await connection.receive(request('client-2', 'wrong-client', { type: 'abort' }));
        expect(posted.at(-1)).toMatchObject({
            clientId: 'client-2',
            requestId: 'wrong-client',
            ok: false,
            error: { code: 'client_mismatch' },
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('returns controller failures as correlated error responses', async () => {
        const posted: any[] = [];
        const dispatch = vi.fn(async (): Promise<ChatCommandDispatchResult> => ({
            ok: false,
            code: 'command_failed',
            message: 'Prompt failed',
        }));
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));

        await connection.receive(request('client-1', 'bind', { type: 'getState' }));
        posted.length = 0;
        await connection.receive(request('client-1', 'request-1', { type: 'prompt', text: 'hello' }));

        expect(posted.at(-1)).toMatchObject({
            clientId: 'client-1',
            requestId: 'request-1',
            ok: false,
            error: { code: 'command_failed', message: 'Prompt failed' },
        });
    });

    it('returns bridge_dispatch_failed when a dispatcher unexpectedly rejects', async () => {
        const posted: any[] = [];
        const dispatch = vi.fn()
            .mockResolvedValueOnce({ ok: true })
            .mockRejectedValueOnce(new Error('Unexpected failure'));
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));

        await connection.receive(request('client-1', 'bind', { type: 'getState' }));
        await connection.receive(request('client-1', 'request-1', { type: 'abort' }));

        expect(posted.at(-1)).toMatchObject({
            requestId: 'request-1',
            ok: false,
            error: { code: 'bridge_dispatch_failed', message: 'Unexpected failure' },
        });
    });

    it('bounds and coalesces events buffered before the handshake', async () => {
        const posted: any[] = [];
        const dispatch = vi.fn(async (): Promise<ChatCommandDispatchResult> => ({ ok: true }));
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));

        connection.publish({ type: 'ready' });
        for (let index = 0; index < 150; index++) {
            connection.publish({ type: 'error', message: `event-${index}` });
            connection.publish({
                type: 'stateSync',
                state: { messages: [{ index }], isStreaming: false, tools: [] },
            });
        }
        await connection.receive(request('client-1', 'bind', { type: 'getState' }));

        const events = posted.filter((value) => 'sequence' in value);
        expect(events.length).toBeLessThanOrEqual(100);
        expect(events.some((value) => value.type === 'ready')).toBe(true);
        expect(events.filter((value) => value.type === 'stateSync')).toHaveLength(1);
        expect(events.find((value) => value.type === 'stateSync')).toMatchObject({
            payload: { state: { messages: [{ index: 149 }] } },
        });
    });

    it('rebinds a reloaded webview only through getState and resets event sequencing', async () => {
        const posted: any[] = [];
        const dispatch = vi.fn(async (): Promise<ChatCommandDispatchResult> => ({ ok: true }));
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));

        await connection.receive(request('client-1', 'bind-1', { type: 'getState' }));
        connection.publish({ type: 'error', message: 'old client' });
        await connection.receive(request('client-2', 'bind-2', { type: 'getState' }));
        connection.publish({ type: 'error', message: 'new client' });

        const clientTwoEvents = posted.filter((value) => value.clientId === 'client-2' && 'sequence' in value);
        expect(clientTwoEvents).toMatchObject([
            { sequence: 1, type: 'ready' },
            { sequence: 2, type: 'error', payload: { message: 'new client' } },
        ]);
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('suppresses deferred responses and events after disposal', async () => {
        let settle!: (result: ChatCommandDispatchResult) => void;
        const dispatch = vi.fn(() => new Promise<ChatCommandDispatchResult>((resolve) => { settle = resolve; }));
        const posted: unknown[] = [];
        const connection = new ChatPanelConnection('tab-1', dispatch, (value) => posted.push(value));

        const receiving = connection.receive(request('client-1', 'request-1', { type: 'getState' }));
        connection.dispose();
        settle({ ok: true });
        await receiving;
        connection.publish({ type: 'error', message: 'late' });

        expect(posted).toEqual([]);
    });
});
