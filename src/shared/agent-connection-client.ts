import type { ClientMessage } from './protocol';
import type {
    AgentConnection,
    AgentEventEnvelope,
    AgentResponseEnvelope,
} from './connection-protocol';
import {
    createAgentRequestEnvelope,
    createErrorResponse,
    getAgentRequestTimeoutMs,
} from './connection-protocol';
import {
    isAgentEventEnvelope,
    isAgentResponseEnvelope,
} from './protocol-runtime';

export interface AgentConnectionTransport {
    send(value: unknown): void | Promise<unknown>;
    subscribe(listener: (value: unknown) => void): () => void;
}

export interface AgentConnectionClientOptions {
    clientId?: string;
    clientIdPrefix?: string;
    tabId?: string;
    requestTimeoutMs?: number;
    transportLabel?: string;
}

type PendingResponse = {
    resolve: (response: AgentResponseEnvelope<unknown>) => void;
};

/** Browser-safe request correlation and event recovery shared by frontend transports. */
export class AgentConnectionClient implements AgentConnection {
    private readonly clientId: string;
    private readonly tabId?: string;
    private readonly requestTimeoutMs: number;
    private readonly transportLabel: string;
    private readonly unsubscribeTransport: () => void;
    private requestCounter = 0;
    private eventEpoch?: string;
    private readonly retiredEventEpochs = new Set<string>();
    private lastSequence = 0;
    private recoveryPending = false;
    private closed = false;
    private readonly pending = new Map<string, PendingResponse>();
    private readonly subscribers = new Set<(event: AgentEventEnvelope) => void>();

    constructor(
        private readonly transport: AgentConnectionTransport,
        options: AgentConnectionClientOptions = {},
    ) {
        this.clientId = options.clientId
            ?? createClientId(options.clientIdPrefix ?? 'client');
        this.tabId = options.tabId;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.transportLabel = options.transportLabel ?? 'transport';
        this.unsubscribeTransport = transport.subscribe((value) => this.receive(value));
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
                `The ${this.transportLabel} agent connection is closed.`,
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
                        `The ${this.transportLabel} agent request timed out.`,
                    ));
                }, timeoutMs);
            }
            try {
                const result = this.transport.send(envelope);
                if (isPromiseLike(result)) {
                    void Promise.resolve(result).then(
                        (response) => {
                            if (response !== undefined) this.receive(response);
                        },
                        (error) => {
                            if (!this.pending.delete(envelope.requestId)) return;
                            settle(createErrorResponse(
                                envelope,
                                'transport_error',
                                error instanceof Error ? error.message : String(error),
                            ));
                        },
                    );
                }
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
        this.unsubscribeTransport();
        this.subscribers.clear();
        for (const [requestId, pending] of this.pending) {
            pending.resolve(createErrorResponse(
                { requestId, clientId: this.clientId },
                'transport_closed',
                `The ${this.transportLabel} agent connection is closed.`,
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
                // One frontend consumer must not block remaining delivery or recovery.
            }
        }

        if (hasGap && !this.recoveryPending) {
            this.recoveryPending = true;
            void this.request(
                { type: 'getState' },
                { tabId: value.tabId ?? this.tabId },
            ).finally(() => {
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
        if (response.ok
            || !isRetriableInitialStateError(response.error.code)
            || attempt === maxAttempts) {
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object'
        && value !== null
        && 'then' in value
        && typeof (value as { then?: unknown }).then === 'function';
}

function createClientId(prefix: string): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `${prefix}-${randomUuid}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
