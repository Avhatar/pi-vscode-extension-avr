import { describe, expect, it, vi } from 'vitest';
import {
    DESKTOP_SHELL_EVENT_CHANNEL,
    DESKTOP_SHELL_REQUEST_CHANNEL,
    type DesktopShellState,
} from '../src/ipc-contract';
import {
    DesktopShellIpcHost,
    registerDesktopShellIpc,
} from '../src/shell-ipc';

function wrapped(documentId: string, request: unknown) {
    return { documentId, request };
}

describe('desktop shell IPC', () => {
    it('requires a launch-state handshake and rejects a superseded preload document', async () => {
        let state: DesktopShellState = { phase: 'welcome' };
        const effects = {
            getState: () => state,
            selectWorkspace: vi.fn(async () => (
                state = { phase: 'ready', workspacePath: 'C:/workspace' }
            )),
            openWorkspace: vi.fn(async (workspacePath: string) => (
                state = { phase: 'ready', workspacePath }
            )),
            newWindow: vi.fn(async () => undefined),
        };
        const host = new DesktopShellIpcHost(effects);
        const sender = {
            id: 1,
            mainFrame: {},
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
        };

        await expect(host.handle(sender, wrapped('document-1', {
            type: 'selectWorkspace',
        }))).resolves.toMatchObject({
            ok: false,
            error: { code: 'handshake_required' },
        });
        await expect(host.handle(sender, wrapped('document-1', {
            type: 'getLaunchState',
        }))).resolves.toEqual({ ok: true, state: { phase: 'welcome' } });
        await expect(host.handle(sender, wrapped('document-1', {
            type: 'selectWorkspace',
        }))).resolves.toMatchObject({
            ok: true,
            state: { phase: 'ready', workspacePath: 'C:/workspace' },
        });

        await expect(host.handle(sender, wrapped('document-2', {
            type: 'getLaunchState',
        }))).resolves.toMatchObject({ ok: true });
        await expect(host.handle(sender, wrapped('document-1', {
            type: 'getLaunchState',
        }))).resolves.toMatchObject({
            ok: false,
            error: { code: 'stale_renderer' },
        });
    });

    it('registers only the fixed channel, validates the main frame, and publishes state', async () => {
        let handler!: (event: any, value: unknown) => Promise<unknown>;
        const ipcMain = {
            handle: vi.fn((channel: string, next: typeof handler) => { handler = next; }),
            removeHandler: vi.fn(),
        };
        const state: DesktopShellState = { phase: 'welcome' };
        const host = new DesktopShellIpcHost({
            getState: () => state,
            selectWorkspace: vi.fn(async () => state),
            openWorkspace: vi.fn(async () => state),
            newWindow: vi.fn(async () => undefined),
        });
        const dispose = registerDesktopShellIpc(ipcMain, host);
        const mainFrame = {};
        const sender = {
            id: 1,
            mainFrame,
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
        };

        expect(ipcMain.handle).toHaveBeenCalledWith(
            DESKTOP_SHELL_REQUEST_CHANNEL,
            expect.any(Function),
        );
        await expect(handler(
            { sender, senderFrame: {} },
            wrapped('document-1', { type: 'getLaunchState' }),
        )).resolves.toMatchObject({
            ok: false,
            error: { code: 'invalid_source' },
        });
        await handler(
            { sender, senderFrame: mainFrame },
            wrapped('document-1', { type: 'getLaunchState' }),
        );

        host.publish({ phase: 'opening', workspacePath: 'C:/workspace' });
        expect(sender.send).toHaveBeenCalledWith(
            DESKTOP_SHELL_EVENT_CHANNEL,
            { phase: 'opening', workspacePath: 'C:/workspace' },
        );

        dispose();
        expect(ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_SHELL_REQUEST_CHANNEL);
    });

    it('validates shell request fields before invoking effects', async () => {
        const openWorkspace = vi.fn(async (workspacePath: string): Promise<DesktopShellState> => ({
            phase: 'ready',
            workspacePath,
        }));
        const host = new DesktopShellIpcHost({
            getState: () => ({ phase: 'welcome' }),
            selectWorkspace: vi.fn(async (): Promise<DesktopShellState> => ({ phase: 'welcome' })),
            openWorkspace,
            newWindow: vi.fn(async () => undefined),
        });
        const sender = {
            id: 1,
            mainFrame: {},
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
        };
        await host.handle(sender, wrapped('document-1', { type: 'getLaunchState' }));

        await expect(host.handle(sender, wrapped('document-1', {
            type: 'openWorkspace',
            workspacePath: '',
            unexpected: true,
        }))).resolves.toMatchObject({
            ok: false,
            error: { code: 'invalid_request' },
        });
        expect(openWorkspace).not.toHaveBeenCalled();
    });
});
