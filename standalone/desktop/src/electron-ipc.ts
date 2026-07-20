import {
    DESKTOP_AGENT_REQUEST_CHANNEL,
    type DesktopIpcRequest,
} from './ipc-contract';
import {
    DesktopIpcHost,
    type DesktopIpcSender,
} from './ipc-host';

export interface ElectronWebContentsPort extends DesktopIpcSender {
    readonly mainFrame: unknown;
    once(event: 'destroyed', listener: () => void): void;
}

export interface ElectronIpcInvokeEventPort {
    readonly sender: ElectronWebContentsPort;
    readonly senderFrame: unknown;
}

export interface ElectronIpcMainPort {
    handle(
        channel: string,
        listener: (event: ElectronIpcInvokeEventPort, value: unknown) => Promise<unknown>,
    ): void;
    removeHandler(channel: string): void;
}

/** Registers the single allowlisted request channel used by the sandboxed preload. */
export function registerDesktopAgentIpc(
    ipcMain: ElectronIpcMainPort,
    host: DesktopIpcHost,
): () => void {
    const senders = new Set<string | number>();
    const activeDocuments = new Map<string | number, string>();
    const seenDocuments = new Map<string | number, Set<string>>();

    ipcMain.handle(DESKTOP_AGENT_REQUEST_CHANNEL, async (event, value) => {
        const wrapped = parseDocumentRequest(value);
        const request = wrapped?.request ?? value;
        if (event.senderFrame !== event.sender.mainFrame) {
            return host.reject(
                request,
                'invalid_source',
                'Desktop agent requests are accepted only from the window main frame.',
            );
        }
        if (!wrapped) {
            return host.reject(
                request,
                'invalid_request',
                'The preload request is missing its renderer document identity.',
            );
        }

        const senderId = event.sender.id;
        const activeDocument = activeDocuments.get(senderId);
        if (activeDocument !== undefined && activeDocument !== wrapped.documentId) {
            if (seenDocuments.get(senderId)?.has(wrapped.documentId)) {
                return host.reject(
                    request,
                    'stale_renderer',
                    'This renderer document has already been superseded.',
                );
            }
            if (!isGetStateRequest(request)) {
                return host.reject(
                    request,
                    'handshake_required',
                    'A new renderer document must begin with getState.',
                );
            }
        }

        if (!senders.has(senderId)) {
            senders.add(senderId);
            event.sender.once('destroyed', () => {
                senders.delete(senderId);
                activeDocuments.delete(senderId);
                seenDocuments.delete(senderId);
                host.detach(senderId);
            });
        }

        const response = await host.handle(event.sender, request);
        if (response.ok && isGetStateRequest(request)) {
            activeDocuments.set(senderId, wrapped.documentId);
            const seen = seenDocuments.get(senderId) ?? new Set<string>();
            seen.add(wrapped.documentId);
            seenDocuments.set(senderId, seen);
        }
        return response;
    });

    return () => {
        ipcMain.removeHandler(DESKTOP_AGENT_REQUEST_CHANNEL);
        for (const senderId of senders) host.detach(senderId);
        senders.clear();
        activeDocuments.clear();
        seenDocuments.clear();
    };
}

function parseDocumentRequest(value: unknown): DesktopIpcRequest | undefined {
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

function isGetStateRequest(value: unknown): boolean {
    return typeof value === 'object'
        && value !== null
        && (value as { type?: unknown }).type === 'getState';
}
