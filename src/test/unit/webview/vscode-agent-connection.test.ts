import { describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '../../../shared/connection-protocol';
import {
    AGENT_PROTOCOL_VERSION,
    AgentEventSequencer,
    createSuccessResponse,
} from '../../../shared/connection-protocol';
import {
    VsCodeAgentConnection,
    requestInitialAgentState,
    type MessageEventSource,
} from '../../../webview/vscode-agent-connection';

class FakeMessageSource implements MessageEventSource {
    private listeners = new Set<(event: { data: unknown }) => void>();

    addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
        this.listeners.add(listener);
    }

    removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
        this.listeners.delete(listener);
    }

    emit(data: unknown): void {
        for (const listener of this.listeners) listener({ data });
    }

    get listenerCount(): number {
        return this.listeners.size;
    }
}

function postedRequest(postMessage: ReturnType<typeof vi.fn>, index = 0): any {
    return postMessage.mock.calls[index][0];
}

describe('VsCodeAgentConnection', () => {
    it('correlates responses by request id and ignores another client', async () => {
        const source = new FakeMessageSource();
        const postMessage = vi.fn();
        const connection = new VsCodeAgentConnection(
            { postMessage },
            source,
            { clientId: 'client-1', tabId: 'tab-1' },
        );

        const pending = connection.request({ type: 'getModels' });
        const request = postedRequest(postMessage);
        expect(request).toMatchObject({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'client-1',
            tabId: 'tab-1',
            type: 'getModels',
            payload: {},
        });

        source.emit(createSuccessResponse({ requestId: request.requestId, clientId: 'other-client' }));
        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        const response = createSuccessResponse(request, { accepted: true });
        source.emit(response);
        await expect(pending).resolves.toEqual(response);
        await connection.close();
    });

    it('publishes valid sequenced events and ignores duplicates or stale events', async () => {
        const source = new FakeMessageSource();
        const postMessage = vi.fn();
        const connection = new VsCodeAgentConnection(
            { postMessage },
            source,
            { clientId: 'client-1', tabId: 'tab-1' },
        );
        const received: AgentEventEnvelope[] = [];
        connection.subscribe((event) => received.push(event));
        const sequencer = new AgentEventSequencer('client-1');
        const first = sequencer.create({ type: 'ready' }, 'tab-1');
        const second = sequencer.create({ type: 'error', message: 'failed' }, 'tab-1');

        source.emit(first);
        source.emit({ ...second, tabId: 'tab-2' });
        source.emit(first);
        source.emit(second);
        source.emit({ ...second, clientId: 'other-client', sequence: 3 });

        expect(received).toEqual([first, second]);
        expect(postMessage).not.toHaveBeenCalled();
        await connection.close();
    });

    it('accepts a reset sequence for a new event epoch and rejects delayed retired events', async () => {
        const source = new FakeMessageSource();
        const connection = new VsCodeAgentConnection(
            { postMessage: vi.fn() },
            source,
            { clientId: 'client-1', tabId: 'tab-1' },
        );
        const received: AgentEventEnvelope[] = [];
        connection.subscribe((event) => received.push(event));
        const base = {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'client-1',
            tabId: 'tab-1',
            type: 'error',
        } as const;

        source.emit({ ...base, epoch: 'epoch-old', sequence: 5, payload: { message: 'old' } });
        source.emit({ ...base, epoch: 'epoch-new', sequence: 1, payload: { message: 'new' } });
        source.emit({ ...base, epoch: 'epoch-old', sequence: 6, payload: { message: 'delayed' } });

        expect(received.map((event) => event.payload)).toEqual([
            { message: 'old' },
            { message: 'new' },
        ]);
        await connection.close();
    });

    it('requests one state snapshot when an event sequence gap is detected', async () => {
        const source = new FakeMessageSource();
        const postMessage = vi.fn();
        const connection = new VsCodeAgentConnection(
            { postMessage },
            source,
            { clientId: 'client-1', tabId: 'tab-1' },
        );
        const received: AgentEventEnvelope[] = [];
        connection.subscribe((event) => received.push(event));

        source.emit({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'client-1',
            epoch: 'epoch-1',
            sequence: 2,
            tabId: 'tab-1',
            type: 'error',
            payload: { message: 'gap' },
        });
        source.emit({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'client-1',
            epoch: 'epoch-1',
            sequence: 4,
            tabId: 'tab-1',
            type: 'error',
            payload: { message: 'second gap' },
        });

        expect(received).toHaveLength(2);
        expect(postMessage).toHaveBeenCalledTimes(1);
        const recovery = postedRequest(postMessage);
        expect(recovery).toMatchObject({ type: 'getState', clientId: 'client-1', tabId: 'tab-1' });

        source.emit(createSuccessResponse(recovery));
        await Promise.resolve();
        await connection.close();
    });

    it('isolates throwing subscribers without suppressing delivery or gap recovery', async () => {
        const source = new FakeMessageSource();
        const postMessage = vi.fn();
        const connection = new VsCodeAgentConnection(
            { postMessage },
            source,
            { clientId: 'client-1', tabId: 'tab-1' },
        );
        const received: AgentEventEnvelope[] = [];
        connection.subscribe(() => { throw new Error('subscriber failed'); });
        connection.subscribe((event) => received.push(event));
        const event = {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'client-1',
            epoch: 'epoch-1',
            sequence: 2,
            tabId: 'tab-1',
            type: 'error',
            payload: { message: 'gap' },
        } as const;

        expect(() => source.emit(event)).not.toThrow();
        expect(received).toEqual([event]);
        expect(postMessage).toHaveBeenCalledTimes(1);
        await connection.close();
    });

    it('keeps modal confirmation pending until the user responds or the connection closes', async () => {
        vi.useFakeTimers();
        try {
            const source = new FakeMessageSource();
            const postMessage = vi.fn();
            const connection = new VsCodeAgentConnection(
                { postMessage },
                source,
                { clientId: 'client-1', tabId: 'tab-1', requestTimeoutMs: 100 },
            );

            const pending = connection.request({
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: 'Confirm?',
            });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(120_000);
            expect(settled).toBe(false);

            const request = postedRequest(postMessage);
            const response = createSuccessResponse(request);
            source.emit(response);
            await expect(pending).resolves.toEqual(response);
            await connection.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses a longer bounded timeout for session listing and workspace search', async () => {
        vi.useFakeTimers();
        try {
            const source = new FakeMessageSource();
            const postMessage = vi.fn();
            const connection = new VsCodeAgentConnection(
                { postMessage },
                source,
                { clientId: 'client-1', tabId: 'tab-1', requestTimeoutMs: 100 },
            );

            const sessions = connection.request({ type: 'getSessions' });
            const search = connection.request({
                type: 'searchWorkspaceFiles', query: 'src', requestId: 1,
            });
            let settled = 0;
            void sessions.then(() => { settled++; });
            void search.then(() => { settled++; });

            await vi.advanceTimersByTimeAsync(100);
            expect(settled).toBe(0);
            await vi.advanceTimersByTimeAsync(119_900);
            await expect(sessions).resolves.toMatchObject({
                ok: false,
                error: { code: 'request_timeout' },
            });
            await expect(search).resolves.toMatchObject({
                ok: false,
                error: { code: 'request_timeout' },
            });
            await connection.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('times out lost requests and allows a later sequence gap to retry recovery', async () => {
        vi.useFakeTimers();
        try {
            const source = new FakeMessageSource();
            const postMessage = vi.fn();
            const connection = new VsCodeAgentConnection(
                { postMessage },
                source,
                { clientId: 'client-1', tabId: 'tab-1', requestTimeoutMs: 100 },
            );

            source.emit({
                protocolVersion: AGENT_PROTOCOL_VERSION,
                clientId: 'client-1',
                epoch: 'epoch-1',
                sequence: 2,
                tabId: 'tab-1',
                type: 'error',
                payload: { message: 'first gap' },
            });
            expect(postMessage).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(100);
            source.emit({
                protocolVersion: AGENT_PROTOCOL_VERSION,
                clientId: 'client-1',
                epoch: 'epoch-1',
                sequence: 4,
                tabId: 'tab-1',
                type: 'error',
                payload: { message: 'second gap' },
            });
            expect(postMessage).toHaveBeenCalledTimes(2);
            await connection.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries initial state after a transient failure before succeeding', async () => {
        const timeout = {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            requestId: 'request-1',
            clientId: 'client-1',
            ok: false as const,
            error: { code: 'request_timeout', message: 'Timed out' },
        };
        const success = createSuccessResponse({ requestId: 'request-2', clientId: 'client-1' });
        const request = vi.fn()
            .mockResolvedValueOnce(timeout)
            .mockResolvedValueOnce(success);
        const wait = vi.fn(async () => undefined);

        await expect(requestInitialAgentState(
            { request },
            { maxAttempts: 3, retryDelayMs: 25, wait },
        )).resolves.toEqual(success);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(1, { type: 'getState' });
        expect(wait).toHaveBeenCalledWith(25);
    });

    it('removes its listener and resolves pending requests as transport_closed', async () => {
        const source = new FakeMessageSource();
        const postMessage = vi.fn();
        const connection = new VsCodeAgentConnection(
            { postMessage },
            source,
            { clientId: 'client-1', tabId: 'tab-1' },
        );
        const pending = connection.request({ type: 'abort' });
        expect(source.listenerCount).toBe(1);

        await connection.close();

        expect(source.listenerCount).toBe(0);
        await expect(pending).resolves.toMatchObject({
            ok: false,
            error: { code: 'transport_closed' },
        });

        const afterClose = await connection.request({ type: 'getState' });
        expect(afterClose).toMatchObject({ ok: false, error: { code: 'transport_closed' } });
        expect(postMessage).toHaveBeenCalledTimes(1);
    });
});
