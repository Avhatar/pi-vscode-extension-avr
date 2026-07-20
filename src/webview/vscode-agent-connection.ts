import type { ClientMessage } from '../shared/protocol';
import type {
    AgentConnection,
    AgentEventEnvelope,
    AgentResponseEnvelope,
} from '../shared/connection-protocol';
import {
    createAgentRequestEnvelope,
    createErrorResponse,
    getAgentRequestTimeoutMs,
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
    private eventEpoch?: string;
    private readonly retiredEventEpochs = new Set<string>();
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
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const settle = (response: AgentResponseEnvelope<unknown>): void => {
                if (timeout !== undefined) clearTimeout(timeout);
                resolve(response as AgentResponseEnvelope<Result>);
            };
            this.pending.set(envelope.requestId, { resolve: settle });
            const timeoutMs = getAgentRequestTimeoutMs(message, this.requestTimeoutMs);
            if (timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    if (!this.pending.delete(envelope.requestId)) return;
                    settle(createErrorResponse(
                        envelope,
                        'request_timeout',
                        'The VS Code agent request timed out.',
                    ));
                }, timeoutMs);
            }
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
        if (this.eventEpoch === undefined) {
            this.eventEpoch = value.epoch;
        } else if (value.epoch !== this.eventEpoch) {
            if (this.retiredEventEpochs.has(value.epoch)) return;
            this.retiredEventEpochs.add(this.eventEpoch);
            this.eventEpoch = value.epoch;
            this.lastSequence = 0;
            this.recoveryPending = false;
        }
        if (value.sequence <= this.lastSequence) return;

        const hasGap = value.sequence > this.lastSequence + 1;
        this.lastSequence = value.sequence;
        for (const listener of [...this.subscribers]) {
            try {
                listener(value);
            } catch {
                // One webview consumer must not block remaining delivery or recovery.
            }
        }

        if (hasGap && !this.recoveryPending) {
            this.recoveryPending = true;
            void this.request({ type: 'getState' }).finally(() => {
                this.recoveryPending = false;
            });
        }
    }
}

export interface InitialAgentStateRequestOptions {
    maxAttempts?: number;
    retryDelayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
}

export async function requestInitialAgentState(
    connection: Pick<AgentConnection, 'request'>,
    options: InitialAgentStateRequestOptions = {},
): Promise<AgentResponseEnvelope<unknown>> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    const wait = options.wait ?? delay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await connection.request({ type: 'getState' });
        if (response.ok || !isRetriableInitialStateError(response.error.code) || attempt === maxAttempts) {
            return response;
        }
        await wait(retryDelayMs);
    }
    throw new Error('Initial agent state retry loop exited unexpectedly.');
}

function isRetriableInitialStateError(code: string): boolean {
    return code === 'request_timeout'
        || code === 'transport_error'
        || code === 'bridge_dispatch_failed';
}

function delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createClientId(): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `vscode-${randomUuid}`;
    return `vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
