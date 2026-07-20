import {
    AgentConnectionClient,
    type AgentConnectionClientOptions,
    type AgentConnectionTransport,
} from '../shared/agent-connection-client';

export {
    requestInitialAgentState,
} from '../shared/agent-connection-client';
export type {
    InitialAgentStateRequestOptions,
} from '../shared/agent-connection-client';

export interface VsCodePostMessageApi {
    postMessage(message: unknown): void;
}

export type ConnectionMessageListener = (event: { data: unknown }) => void;

export interface MessageEventSource {
    addEventListener(type: 'message', listener: ConnectionMessageListener): void;
    removeEventListener(type: 'message', listener: ConnectionMessageListener): void;
}

export interface VsCodeAgentConnectionOptions {
    clientId?: string;
    tabId?: string;
    requestTimeoutMs?: number;
}

/** Browser-only AgentConnection implemented over the VS Code webview bridge. */
export class VsCodeAgentConnection extends AgentConnectionClient {
    constructor(
        api: VsCodePostMessageApi,
        source: MessageEventSource,
        options: VsCodeAgentConnectionOptions = {},
    ) {
        super(createVsCodeTransport(api, source), {
            ...options,
            clientIdPrefix: 'vscode',
            transportLabel: 'VS Code',
        } satisfies AgentConnectionClientOptions);
    }
}

function createVsCodeTransport(
    api: VsCodePostMessageApi,
    source: MessageEventSource,
): AgentConnectionTransport {
    return {
        send: (value) => api.postMessage(value),
        subscribe: (listener) => {
            const onMessage: ConnectionMessageListener = (event) => listener(event.data);
            source.addEventListener('message', onMessage);
            return () => source.removeEventListener('message', onMessage);
        },
    };
}
