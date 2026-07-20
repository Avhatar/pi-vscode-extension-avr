import {
    DESKTOP_SHELL_EVENT_CHANNEL,
    DESKTOP_SHELL_REQUEST_CHANNEL,
    type DesktopIpcRequest,
    type DesktopShellRequest,
    type DesktopShellResponse,
    type DesktopShellState,
} from './ipc-contract';
import type {
    ElectronIpcMainPort,
    ElectronWebContentsPort,
} from './electron-ipc';

export interface DesktopShellEffects {
    getState(): DesktopShellState;
    selectWorkspace(): Promise<DesktopShellState>;
    openWorkspace(workspacePath: string): Promise<DesktopShellState>;
    newWindow(): Promise<void>;
}

type ShellConnection = {
    readonly sender: ElectronWebContentsPort;
    activeDocumentId: string;
    readonly seenDocumentIds: Set<string>;
};

export class DesktopShellIpcHost {
    private readonly connections = new Map<string | number, ShellConnection>();

    constructor(private readonly effects: DesktopShellEffects) {}

    reject(code: string, message: string): DesktopShellResponse {
        return {
            ok: false,
            state: this.effects.getState(),
            error: { code, message },
        };
    }

    async handle(
        sender: ElectronWebContentsPort,
        value: unknown,
    ): Promise<DesktopShellResponse> {
        const wrapped = parseWrappedRequest(value);
        if (!wrapped) {
            return this.reject('invalid_request', 'The desktop shell request is invalid.');
        }
        const request = parseShellRequest(wrapped.request);
        if (!request) {
            return this.reject('invalid_request', 'The desktop shell request is invalid.');
        }

        const current = this.connections.get(sender.id);
        if (!current && request.type !== 'getLaunchState') {
            return this.reject('handshake_required', 'The first shell request must be getLaunchState.');
        }
        if (current && current.activeDocumentId !== wrapped.documentId) {
            if (current.seenDocumentIds.has(wrapped.documentId)) {
                return this.reject('stale_renderer', 'This renderer document has already been superseded.');
            }
            if (request.type !== 'getLaunchState') {
                return this.reject('handshake_required', 'A new renderer document must begin with getLaunchState.');
            }
        }

        try {
            let state: DesktopShellState;
            switch (request.type) {
                case 'getLaunchState':
                    state = this.effects.getState();
                    this.bind(sender, wrapped.documentId, current);
                    break;
                case 'selectWorkspace':
                    state = await this.effects.selectWorkspace();
                    break;
                case 'openWorkspace':
                    state = await this.effects.openWorkspace(request.workspacePath);
                    break;
                case 'newWindow':
                    await this.effects.newWindow();
                    state = this.effects.getState();
                    break;
            }
            return { ok: true, state };
        } catch (error) {
            return this.reject(
                'shell_failed',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    publish(state: DesktopShellState): void {
        for (const connection of [...this.connections.values()]) {
            if (connection.sender.isDestroyed()) {
                this.connections.delete(connection.sender.id);
                continue;
            }
            try {
                connection.sender.send(DESKTOP_SHELL_EVENT_CHANNEL, state);
            } catch {
                this.connections.delete(connection.sender.id);
            }
        }
    }

    detach(senderId: string | number): void {
        this.connections.delete(senderId);
    }

    private bind(
        sender: ElectronWebContentsPort,
        documentId: string,
        current: ShellConnection | undefined,
    ): void {
        const seenDocumentIds = current?.seenDocumentIds ?? new Set<string>();
        seenDocumentIds.add(documentId);
        this.connections.set(sender.id, {
            sender,
            activeDocumentId: documentId,
            seenDocumentIds,
        });
    }
}

export function registerDesktopShellIpc(
    ipcMain: ElectronIpcMainPort,
    host: DesktopShellIpcHost,
): () => void {
    const senders = new Set<string | number>();
    ipcMain.handle(DESKTOP_SHELL_REQUEST_CHANNEL, async (event, value) => {
        if (event.senderFrame !== event.sender.mainFrame) {
            return host.reject(
                'invalid_source',
                'Desktop shell requests are accepted only from the window main frame.',
            );
        }
        const senderId = event.sender.id;
        if (!senders.has(senderId)) {
            senders.add(senderId);
            event.sender.once('destroyed', () => {
                senders.delete(senderId);
                host.detach(senderId);
            });
        }
        return host.handle(event.sender, value);
    });

    return () => {
        ipcMain.removeHandler(DESKTOP_SHELL_REQUEST_CHANNEL);
        for (const senderId of senders) host.detach(senderId);
        senders.clear();
    };
}

function parseWrappedRequest(value: unknown): DesktopIpcRequest | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as { documentId?: unknown; request?: unknown };
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('documentId') || !keys.includes('request')) {
        return undefined;
    }
    if (typeof candidate.documentId !== 'string' || candidate.documentId.length === 0) {
        return undefined;
    }
    return { documentId: candidate.documentId, request: candidate.request };
}

function parseShellRequest(value: unknown): DesktopShellRequest | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate);
    switch (candidate.type) {
        case 'getLaunchState':
        case 'selectWorkspace':
        case 'newWindow':
            return keys.length === 1 ? { type: candidate.type } : undefined;
        case 'openWorkspace':
            return keys.length === 2
                && typeof candidate.workspacePath === 'string'
                && candidate.workspacePath.trim().length > 0
                ? { type: 'openWorkspace', workspacePath: candidate.workspacePath }
                : undefined;
        default:
            return undefined;
    }
}
