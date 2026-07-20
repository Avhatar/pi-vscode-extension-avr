import type { ClientMessage, ServerMessage } from './protocol';

export const AGENT_PROTOCOL_VERSION = 2 as const;
export const LONG_RUNNING_AGENT_REQUEST_TIMEOUT_MS = 120_000;

export type MessagePayload<Message extends { type: string }> = Omit<Message, 'type'>;

export interface AgentRequestMetadata {
    requestId: string;
    clientId: string;
    tabId?: string;
}

export type AgentRequestEnvelope<Message extends ClientMessage = ClientMessage> =
    Message extends ClientMessage
        ? AgentRequestMetadata & {
            protocolVersion: typeof AGENT_PROTOCOL_VERSION;
            type: Message['type'];
            payload: MessagePayload<Message>;
        }
        : never;

export interface AgentSuccessResponse<Result = unknown> {
    protocolVersion: typeof AGENT_PROTOCOL_VERSION;
    requestId: string;
    clientId: string;
    ok: true;
    result?: Result;
}

export interface AgentErrorResponse {
    protocolVersion: typeof AGENT_PROTOCOL_VERSION;
    requestId: string;
    clientId: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
}

export type AgentResponseEnvelope<Result = unknown> = AgentSuccessResponse<Result> | AgentErrorResponse;

export type AgentEventEnvelope<Message extends ServerMessage = ServerMessage> =
    Message extends ServerMessage
        ? {
            protocolVersion: typeof AGENT_PROTOCOL_VERSION;
            clientId: string;
            epoch: string;
            sequence: number;
            tabId?: string;
            type: Message['type'];
            payload: MessagePayload<Message>;
        }
        : never;

export function getAgentRequestTimeoutMs(
    message: ClientMessage,
    defaultTimeoutMs: number,
): number | undefined {
    if (message.type === 'confirmAction') return undefined;
    if (message.type === 'getSessions' || message.type === 'searchWorkspaceFiles') {
        return Math.max(defaultTimeoutMs, LONG_RUNNING_AGENT_REQUEST_TIMEOUT_MS);
    }
    return defaultTimeoutMs;
}

/** Transport-neutral connection used by VS Code, Electron IPC, and development transports. */
export interface AgentConnection {
    request<Message extends ClientMessage, Result = unknown>(
        message: Message,
        options?: { tabId?: string },
    ): Promise<AgentResponseEnvelope<Result>>;
    subscribe(listener: (event: AgentEventEnvelope) => void): () => void;
    close(): Promise<void>;
}

export function createAgentRequestEnvelope<Message extends ClientMessage>(
    metadata: AgentRequestMetadata,
    message: Message,
): AgentRequestEnvelope<Message> {
    const { type, ...payload } = message;
    return {
        ...metadata,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type,
        payload,
    } as AgentRequestEnvelope<Message>;
}

export function createSuccessResponse<Result>(
    request: Pick<AgentRequestMetadata, 'requestId' | 'clientId'>,
    result?: Result,
): AgentSuccessResponse<Result> {
    return {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        clientId: request.clientId,
        ok: true,
        ...(result === undefined ? {} : { result }),
    };
}

export function createErrorResponse(
    request: Pick<AgentRequestMetadata, 'requestId' | 'clientId'>,
    code: string,
    message: string,
): AgentErrorResponse {
    return {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        clientId: request.clientId,
        ok: false,
        error: { code, message },
    };
}

/** Assigns event sequence numbers for one host connection. */
export class AgentEventSequencer {
    private sequence = 0;

    constructor(
        private readonly clientId: string,
        private readonly epoch: string = createEventEpoch(),
    ) {}

    create<Message extends ServerMessage>(
        message: Message,
        tabId?: string,
    ): AgentEventEnvelope<Message> {
        const { type, ...payload } = message;
        return {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: this.clientId,
            epoch: this.epoch,
            sequence: ++this.sequence,
            ...(tabId === undefined ? {} : { tabId }),
            type,
            payload,
        } as AgentEventEnvelope<Message>;
    }
}

function createEventEpoch(): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return randomUuid;
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
