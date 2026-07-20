import {
    DESKTOP_AGENT_EVENT_CHANNEL,
    DESKTOP_AGENT_REQUEST_CHANNEL,
    type DesktopPreloadApi,
} from './ipc-contract';

export interface IpcRendererPort {
    invoke(channel: string, value: unknown): Promise<unknown>;
    on(channel: string, listener: (event: unknown, value: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void;
}

export function createDesktopPreloadApi(
    ipc: IpcRendererPort,
    documentId = createDocumentId(),
): DesktopPreloadApi {
    return Object.freeze({
        request: (value: unknown) => ipc.invoke(DESKTOP_AGENT_REQUEST_CHANNEL, {
            documentId,
            request: value,
        }),
        subscribe: (listener: (value: unknown) => void) => {
            const onEvent = (_event: unknown, value: unknown): void => listener(value);
            ipc.on(DESKTOP_AGENT_EVENT_CHANNEL, onEvent);
            return () => ipc.removeListener(DESKTOP_AGENT_EVENT_CHANNEL, onEvent);
        },
    });
}

function createDocumentId(): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `document-${randomUuid}`;
    return `document-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
