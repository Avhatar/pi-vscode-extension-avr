import type { ClientMessage } from '../shared/protocol';
import type {
    AgentConnection,
    AgentEventEnvelope,
    AgentResponseEnvelope,
} from '../shared/connection-protocol';
import {
    createAgentRequestEnvelope,
    createErrorResponse,
} from '../shared/connection-protocol';
import {
    isAgentEventEnvelope,
    isAgentResponseEnvelope,
} from '../shared/protocol-runtime';

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

type PendingResponse = {
    resolve: (response: AgentResponseEnvelope<unknown>) => void;
};

/** Browser-only AgentConnection implemented over the VS Code webview bridge. */
export class VsCodeAgentConnection implements AgentConnection {
    private readonly clientId: string;
    private readonly tabId?: string;
    private readonly requestTimeoutMs: number;
    private requestCounter = 0;
    private lastSequence = 0;
    private recoveryPending = false;
    private closed = false;
    private readonly pending = new Map<string, PendingResponse>();
    private readonly subscribers = new Set<(event: AgentEventEnvelope) => void>();
    private readonly onMessage: ConnectionMessageListener;

    constructor(
        private readonly api: VsCodePostMessageApi,
        private readonly source: MessageEventSource,
        options: VsCodeAgentConnectionOptions = {},
    ) {
        this.clientId = options.clientId ?? createClientId();
        this.tabId = options.tabId;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.onMessage = (event) => this.receive(event.data);
        this.source.addEventListener('message', this.onMessage);
    }

    request<Message extends ClientMessage, Result = unknown>(
        message: Message,
        options?: { tabId?: string },
    ): Promise<AgentResponseEnvelope<Result>> {
        const envelope = createAgentRequestEnvelope({
            requestId: `${this.clientId}:${++this.requestCounter}`,
            clientId: this.clientId,
            tabId: options?.tabId ?? this.tabId,
        }, message);

        if (this.closed) {
            return Promise.resolve(createErrorResponse(
                envelope,
                'transport_closed',
                'The VS Code agent connection is closed.',
            ));
        }

        return new Promise<AgentResponseEnvelope<Result>>((resolve) => {
            const timeout = setTimeout(() => {
                if (!this.pending.delete(envelope.requestId)) return;
                resolve(createErrorResponse(
                    envelope,
                    'request_timeout',
                    'The VS Code agent request timed out.',
                ));
            }, this.requestTimeoutMs);
            const settle = (response: AgentResponseEnvelope<unknown>): void => {
                clearTimeout(timeout);
                resolve(response as AgentResponseEnvelope<Result>);
            };
            this.pending.set(envelope.requestId, { resolve: settle });
            try {
                this.api.postMessage(envelope);
            } catch (error) {
                this.pending.delete(envelope.requestId);
                settle(createErrorResponse(
                    envelope,
                    'transport_error',
                    error instanceof Error ? error.message : String(error),
                ));
            }
        });
    }

    subscribe(listener: (event: AgentEventEnvelope) => void): () => void {
        if (this.closed) return () => undefined;
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.source.removeEventListener('message', this.onMessage);
        this.subscribers.clear();
        for (const [requestId, pending] of this.pending) {
            pending.resolve(createErrorResponse(
                { requestId, clientId: this.clientId },
                'transport_closed',
                'The VS Code agent connection is closed.',
            ));
        }
        this.pending.clear();
    }

    private receive(value: unknown): void {
        if (this.closed) return;
        if (isAgentResponseEnvelope(value)) {
            if (value.clientId !== this.clientId) return;
            const pending = this.pending.get(value.requestId);
            if (!pending) return;
            this.pending.delete(value.requestId);
            pending.resolve(value);
            return;
        }
        if (!isAgentEventEnvelope(value) || value.clientId !== this.clientId) return;
        if (this.tabId !== undefined && value.tabId !== this.tabId) return;
        if (value.sequence <= this.lastSequence) return;

        const hasGap = value.sequence > this.lastSequence + 1;
        this.lastSequence = value.sequence;
        for (const listener of this.subscribers) listener(value);

        if (hasGap && !this.recoveryPending) {
            this.recoveryPending = true;
            void this.request({ type: 'getState' }).finally(() => {
                this.recoveryPending = false;
            });
        }
    }
}

function createClientId(): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `vscode-${randomUuid}`;
    return `vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
