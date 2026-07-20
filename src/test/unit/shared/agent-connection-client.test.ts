import { describe, expect, it, vi } from 'vitest';
import {
    AgentConnectionClient,
    type AgentConnectionTransport,
} from '../../../shared/agent-connection-client';
import {
    AGENT_PROTOCOL_VERSION,
    createSuccessResponse,
} from '../../../shared/connection-protocol';

class FakeTransport implements AgentConnectionTransport {
    readonly sent: unknown[] = [];
    private readonly listeners = new Set<(value: unknown) => void>();

    send(value: unknown): void {
        this.sent.push(value);
    }

    subscribe(listener: (value: unknown) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(value: unknown): void {
        for (const listener of [...this.listeners]) listener(value);
    }

    get listenerCount(): number {
        return this.listeners.size;
    }
}

describe('transport-neutral AgentConnectionClient', () => {
    it('correlates requests over an injected transport', async () => {
        const transport = new FakeTransport();
        const connection = new AgentConnectionClient(transport, {
            clientId: 'desktop-client',
            tabId: 'tab-1',
            transportLabel: 'Electron IPC',
        });

        const pending = connection.request({ type: 'getModels' });
        const request = transport.sent[0] as any;
        expect(request).toMatchObject({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'desktop-client',
            tabId: 'tab-1',
            type: 'getModels',
            payload: {},
        });

        const response = createSuccessResponse(request, { accepted: true });
        transport.emit(response);
        await expect(pending).resolves.toEqual(response);
        await connection.close();
    });

    it('recovers sequence gaps with one snapshot request and isolates subscribers', async () => {
        const transport = new FakeTransport();
        const connection = new AgentConnectionClient(transport, {
            clientId: 'desktop-client',
            tabId: 'tab-1',
        });
        const received: unknown[] = [];
        connection.subscribe(() => { throw new Error('listener failed'); });
        connection.subscribe((event) => received.push(event));

        const event = {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'desktop-client',
            epoch: 'epoch-1',
            sequence: 2,
            tabId: 'tab-1',
            type: 'error',
            payload: { message: 'missed event' },
        } as const;
        expect(() => transport.emit(event)).not.toThrow();

        expect(received).toEqual([event]);
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]).toMatchObject({ type: 'getState', clientId: 'desktop-client' });
        await connection.close();
    });

    it('targets gap recovery at the tab that emitted the event', async () => {
        const transport = new FakeTransport();
        const connection = new AgentConnectionClient(transport, {
            clientId: 'desktop-client',
        });

        transport.emit({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'desktop-client',
            epoch: 'epoch-1',
            sequence: 2,
            tabId: 'tab-background',
            type: 'error',
            payload: { message: 'missed event' },
        });

        expect(transport.sent[0]).toMatchObject({
            type: 'getState',
            tabId: 'tab-background',
        });
        await connection.close();
    });

    it('accepts correlated responses returned by an asynchronous transport', async () => {
        const transport: AgentConnectionTransport = {
            send: vi.fn(async (value: any) => createSuccessResponse(value, { accepted: true })),
            subscribe: () => () => undefined,
        };
        const connection = new AgentConnectionClient(transport, {
            clientId: 'desktop-client',
        });

        await expect(connection.request({ type: 'getState' })).resolves.toMatchObject({
            ok: true,
            result: { accepted: true },
        });
        await connection.close();
    });

    it('unsubscribes and settles pending work when closed', async () => {
        const transport = new FakeTransport();
        const connection = new AgentConnectionClient(transport, {
            clientId: 'desktop-client',
            transportLabel: 'Electron IPC',
        });
        const pending = connection.request({ type: 'abort' });
        expect(transport.listenerCount).toBe(1);

        await connection.close();

        expect(transport.listenerCount).toBe(0);
        await expect(pending).resolves.toMatchObject({
            ok: false,
            error: {
                code: 'transport_closed',
                message: 'The Electron IPC agent connection is closed.',
            },
        });
    });

    it('converts synchronous transport failures into correlated errors', async () => {
        const transport: AgentConnectionTransport = {
            send: vi.fn(() => { throw new Error('renderer destroyed'); }),
            subscribe: () => () => undefined,
        };
        const connection = new AgentConnectionClient(transport, {
            clientId: 'desktop-client',
        });

        await expect(connection.request({ type: 'getState' })).resolves.toMatchObject({
            ok: false,
            error: { code: 'transport_error', message: 'renderer destroyed' },
        });
        await connection.close();
    });
});
