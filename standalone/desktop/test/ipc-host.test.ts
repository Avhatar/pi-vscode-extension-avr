import { describe, expect, it, vi } from 'vitest';
import {
    AGENT_PROTOCOL_VERSION,
    createAgentRequestEnvelope,
} from '../../../src/shared/connection-protocol';
import {
    DESKTOP_AGENT_EVENT_CHANNEL,
    DesktopIpcHost,
    type DesktopAgentBackend,
    type DesktopIpcSender,
} from '../src/ipc-host';

function createState(sessionId = 'session-1') {
    return {
        messages: [],
        isStreaming: false,
        tools: [],
        sessionId,
    };
}

function createBackend(): DesktopAgentBackend {
    return {
        dispatch: vi.fn(async () => ({ ok: true as const })),
        getState: vi.fn(() => createState()),
    };
}

function createSender(id = 1): DesktopIpcSender & { sent: Array<{ channel: string; value: unknown }> } {
    const sent: Array<{ channel: string; value: unknown }> = [];
    return {
        id,
        sent,
        isDestroyed: () => false,
        send: (channel, value) => { sent.push({ channel, value }); },
    };
}

function request(clientId: string, type: 'getState' | 'abort' | 'prompt', payload: Record<string, unknown> = {}) {
    return {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        requestId: `${clientId}:${type}`,
        clientId,
        type,
        payload,
    };
}

describe('DesktopIpcHost', () => {
    it('allows only validated portable agent requests', async () => {
        const backend = createBackend();
        const host = new DesktopIpcHost(backend);
        const sender = createSender();

        await expect(host.handle(sender, {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            requestId: 'client-1:open-settings',
            clientId: 'client-1',
            type: 'openSettings',
            payload: {},
        })).resolves.toMatchObject({
            ok: false,
            error: { code: 'invalid_request' },
        });
        await expect(host.handle(sender, { type: 'getState' })).resolves.toMatchObject({
            ok: false,
            error: { code: 'invalid_request' },
        });
        expect(backend.dispatch).not.toHaveBeenCalled();
    });

    it('does not authorize a client when its state handshake fails', async () => {
        const backend = createBackend();
        backend.getState = vi.fn(() => undefined);
        const host = new DesktopIpcHost(backend);
        const sender = createSender();

        await expect(host.handle(sender, request('client-1', 'getState'))).resolves.toMatchObject({
            ok: false,
            error: { code: 'tab_not_found' },
        });
        await expect(host.handle(sender, request('client-1', 'abort'))).resolves.toMatchObject({
            ok: false,
            error: { code: 'handshake_required' },
        });
        expect(host.connectionCount).toBe(0);
    });

    it('keeps the current client bound when a replacement handshake fails', async () => {
        const backend = createBackend();
        const host = new DesktopIpcHost(backend);
        const sender = createSender();
        await host.handle(sender, request('client-1', 'getState'));
        backend.getState = vi.fn(() => undefined);

        await expect(host.handle(sender, request('client-2', 'getState'))).resolves.toMatchObject({
            ok: false,
            error: { code: 'tab_not_found' },
        });
        await expect(host.handle(sender, request('client-1', 'abort'))).resolves.toMatchObject({
            ok: true,
        });
        expect(host.connectionCount).toBe(1);
    });

    it('requires getState as the first request from each renderer client', async () => {
        const host = new DesktopIpcHost(createBackend());
        const sender = createSender();

        await expect(host.handle(sender, request('client-1', 'abort'))).resolves.toMatchObject({
            ok: false,
            error: { code: 'handshake_required' },
        });
        expect(sender.sent).toEqual([]);
    });

    it('binds a renderer with a fresh snapshot epoch and never replays detached events', async () => {
        const backend = createBackend();
        const host = new DesktopIpcHost(backend, { createEpoch: (() => {
            let epoch = 0;
            return () => `epoch-${++epoch}`;
        })() });
        const sender = createSender();

        host.publish({ type: 'error', message: 'before binding' });
        expect(sender.sent).toEqual([]);

        await expect(host.handle(sender, request('client-1', 'getState'))).resolves.toMatchObject({ ok: true });
        expect(sender.sent).toHaveLength(1);
        expect(sender.sent[0]).toMatchObject({
            channel: DESKTOP_AGENT_EVENT_CHANNEL,
            value: {
                clientId: 'client-1',
                epoch: 'epoch-1',
                sequence: 1,
                type: 'stateSync',
                payload: { state: createState() },
            },
        });

        host.publish({ type: 'error', message: 'live event' }, 'tab-1');
        expect(sender.sent[1]).toMatchObject({
            value: {
                clientId: 'client-1',
                epoch: 'epoch-1',
                sequence: 2,
                tabId: 'tab-1',
                type: 'error',
            },
        });

        sender.sent.length = 0;
        await host.handle(sender, request('client-2', 'getState'));
        expect(sender.sent).toHaveLength(1);
        expect(sender.sent[0]).toMatchObject({
            value: {
                clientId: 'client-2',
                epoch: 'epoch-2',
                sequence: 1,
                type: 'stateSync',
            },
        });
    });

    it('suppresses stale completion after a renderer rebind', async () => {
        let finishDispatch!: () => void;
        const backend = createBackend();
        backend.dispatch = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
            finishDispatch = () => resolve({ ok: true });
        }));
        const host = new DesktopIpcHost(backend);
        const sender = createSender();
        await host.handle(sender, request('client-1', 'getState'));

        const pending = host.handle(sender, request('client-1', 'prompt', { text: 'hello' }));
        await host.handle(sender, request('client-2', 'getState'));
        finishDispatch();

        await expect(pending).resolves.toMatchObject({
            ok: false,
            error: { code: 'client_replaced' },
        });
    });

    it('drops destroyed senders without throwing or retaining their binding', async () => {
        const host = new DesktopIpcHost(createBackend());
        let destroyed = false;
        const sender = createSender();
        sender.isDestroyed = () => destroyed;
        await host.handle(sender, request('client-1', 'getState'));
        destroyed = true;

        expect(() => host.publish({ type: 'error', message: 'after close' })).not.toThrow();
        expect(host.connectionCount).toBe(0);
    });

    it('forwards valid commands with the envelope tab id', async () => {
        const backend = createBackend();
        const host = new DesktopIpcHost(backend);
        const sender = createSender();
        await host.handle(sender, createAgentRequestEnvelope(
            { requestId: 'state', clientId: 'client-1', tabId: 'tab-1' },
            { type: 'getState' },
        ));

        const abort = createAgentRequestEnvelope(
            { requestId: 'abort', clientId: 'client-1', tabId: 'tab-2' },
            { type: 'abort' },
        );
        await expect(host.handle(sender, abort)).resolves.toMatchObject({ ok: true });
        expect(backend.dispatch).toHaveBeenCalledWith({ type: 'abort' }, 'tab-2');
    });
});
