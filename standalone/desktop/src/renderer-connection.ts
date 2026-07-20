import {
    AgentConnectionClient,
    type AgentConnectionClientOptions,
} from '../../../src/shared/agent-connection-client';
import type { DesktopPreloadApi } from './ipc-contract';

type DesktopAgentBridge = Pick<DesktopPreloadApi, 'request' | 'subscribe'>;

export type DesktopAgentConnectionOptions = Pick<
    AgentConnectionClientOptions,
    'clientId' | 'tabId' | 'requestTimeoutMs'
>;

/** Renderer-side connection over the narrow preload bridge. */
export class DesktopAgentConnection extends AgentConnectionClient {
    constructor(api: DesktopAgentBridge, options: DesktopAgentConnectionOptions = {}) {
        super({
            send: (value) => api.request(value),
            subscribe: (listener) => api.subscribe(listener),
        }, {
            ...options,
            clientIdPrefix: 'desktop',
            transportLabel: 'Electron IPC',
        });
    }
}
