import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../../src/shared/connection-protocol';
import { registerDesktopAgentIpc } from '../src/electron-ipc';
import { DESKTOP_AGENT_REQUEST_CHANNEL, DesktopIpcHost } from '../src/ipc-host';

function getStateRequest(clientId = 'client-1') {
    return {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        requestId: `${clientId}:state`,
        clientId,
        type: 'getState',
        payload: {},
    };
}

function documentRequest(documentId: string, request = getStateRequest()) {
    return { documentId, request };
}

describe('Electron IPC registration', () => {
    it('binds only the fixed request channel and rejects superseded documents', async () => {
        let handler!: (event: any, value: unknown) => Promise<unknown>;
        const ipcMain = {
            handle: vi.fn((channel: string, next: typeof handler) => { handler = next; }),
            removeHandler: vi.fn(),
        };
        const host = new DesktopIpcHost({
            dispatch: vi.fn(async () => ({ ok: true as const })),
            getState: () => ({ messages: [], isStreaming: false, tools: [] }),
        });
        const dispose = registerDesktopAgentIpc(ipcMain, host);
        expect(ipcMain.handle).toHaveBeenCalledWith(
            DESKTOP_AGENT_REQUEST_CHANNEL,
            expect.any(Function),
        );

        const mainFrame = {};
        const sender = {
            id: 1,
            mainFrame,
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
        };
        await expect(handler(
            { sender, senderFrame: {} },
            documentRequest('document-1'),
        )).resolves.toMatchObject({
            ok: false,
            error: { code: 'invalid_source' },
        });
        expect(host.connectionCount).toBe(0);

        await expect(handler(
            { sender, senderFrame: mainFrame },
            documentRequest('document-1'),
        )).resolves.toMatchObject({ ok: true });
        expect(host.connectionCount).toBe(1);

        // Reload can preserve Electron's frame identifiers. The preload's
        // per-document nonce is therefore the renderer-instance boundary.
        await expect(handler(
            { sender, senderFrame: mainFrame },
            documentRequest('document-2', getStateRequest('client-2')),
        )).resolves.toMatchObject({ ok: true });
        await expect(handler(
            { sender, senderFrame: mainFrame },
            documentRequest('document-1'),
        )).resolves.toMatchObject({
            ok: false,
            error: { code: 'stale_renderer' },
        });

        dispose();
        expect(ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_AGENT_REQUEST_CHANNEL);
        expect(host.connectionCount).toBe(0);
    });
});
