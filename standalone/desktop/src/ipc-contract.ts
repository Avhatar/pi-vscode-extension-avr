export const DESKTOP_AGENT_REQUEST_CHANNEL = 'pi-code:agent-request';
export const DESKTOP_AGENT_EVENT_CHANNEL = 'pi-code:agent-event';

export interface DesktopIpcRequest {
    readonly documentId: string;
    readonly request: unknown;
}

export interface DesktopPreloadApi {
    request(value: unknown): Promise<unknown>;
    subscribe(listener: (value: unknown) => void): () => void;
}
