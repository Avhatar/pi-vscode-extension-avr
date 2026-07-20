import type {
    AgentClientMessage,
    AgentServerMessage,
    SerializedAgentState,
} from '../../../src/shared/agent-protocol';
import type {
    AgentRequestEnvelope,
    AgentResponseEnvelope,
} from '../../../src/shared/connection-protocol';
import {
    AgentEventSequencer,
    createErrorResponse,
    createSuccessResponse,
} from '../../../src/shared/connection-protocol';
import {
    isAgentClientRequestEnvelope,
    isAgentServerMessage,
} from '../../../src/shared/protocol-runtime';
import { safeSerialize } from '../../../src/shared/safe-serialize';
import { DESKTOP_AGENT_EVENT_CHANNEL } from './ipc-contract';

export {
    DESKTOP_AGENT_EVENT_CHANNEL,
    DESKTOP_AGENT_REQUEST_CHANNEL,
} from './ipc-contract';

export interface DesktopIpcSender {
    readonly id: string | number;
    isDestroyed(): boolean;
    send(channel: string, value: unknown): void;
}

export interface DesktopAgentBackend {
    dispatch(
        message: AgentClientMessage,
        sourceTabId?: string,
    ): Promise<{ readonly ok: true } | {
        readonly ok: false;
        readonly code: string;
        readonly message: string;
    }>;
    getState(tabId?: string): SerializedAgentState | undefined;
}

export interface DesktopIpcHostOptions {
    createEpoch?: () => string;
}

type Connection = {
    readonly sender: DesktopIpcSender;
    readonly clientId: string;
    readonly sequencer: AgentEventSequencer;
};

/** Validated, snapshot-based Electron ingress around the shared chat backend. */
export class DesktopIpcHost {
    private readonly connections = new Map<string | number, Connection>();

    constructor(
        private readonly backend: DesktopAgentBackend,
        private readonly options: DesktopIpcHostOptions = {},
    ) {}

    get connectionCount(): number {
        return this.connections.size;
    }

    reject(
        value: unknown,
        code: string,
        message: string,
    ): AgentResponseEnvelope<unknown> {
        return createErrorResponse(requestMetadata(value), code, message);
    }

    async handle(
        sender: DesktopIpcSender,
        value: unknown,
    ): Promise<AgentResponseEnvelope<unknown>> {
        if (!isAgentClientRequestEnvelope(value)) {
            return createErrorResponse(
                requestMetadata(value),
                'invalid_request',
                'The Electron IPC request is not a valid portable agent command.',
            );
        }

        const request = value;
        const current = this.connections.get(sender.id);
        if (!current) {
            if (request.type !== 'getState') {
                return createErrorResponse(
                    request,
                    'handshake_required',
                    'The first renderer request must be getState.',
                );
            }
        } else if (current.clientId !== request.clientId && request.type !== 'getState') {
            return createErrorResponse(
                request,
                'client_mismatch',
                'The renderer client must rebind with getState before sending commands.',
            );
        }

        if (request.type === 'getState') {
            const state = this.backend.getState(request.tabId);
            if (!state) {
                return createErrorResponse(
                    request,
                    'tab_not_found',
                    request.tabId
                        ? `Chat tab not found: ${request.tabId}`
                        : 'No active chat tab is available.',
                );
            }
            const connection = current?.clientId === request.clientId
                ? current
                : this.createConnection(sender, request.clientId);
            if (!this.send(connection, { type: 'stateSync', state }, request.tabId)) {
                return createErrorResponse(
                    request,
                    'transport_error',
                    'The renderer is unavailable for the state snapshot.',
                );
            }
            if (connection !== current) this.connections.set(sender.id, connection);
            return createSuccessResponse(request);
        }

        const message = requestMessage(request);
        const connectionAtDispatch = current;
        try {
            const result = await this.backend.dispatch(message, request.tabId);
            const active = this.connections.get(sender.id);
            if (active !== connectionAtDispatch || active?.clientId !== request.clientId) {
                return createErrorResponse(
                    request,
                    'client_replaced',
                    'The renderer client was replaced before the command completed.',
                );
            }
            if (!result.ok) return createErrorResponse(request, result.code, result.message);
            return createSuccessResponse(request);
        } catch (error) {
            return createErrorResponse(
                request,
                'bridge_dispatch_failed',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    publish(message: AgentServerMessage, tabId?: string): void {
        const serialized = safeSerialize(message);
        if (!isAgentServerMessage(serialized)) {
            throw new Error(`Invalid desktop agent event payload: ${message.type}`);
        }
        for (const connection of [...this.connections.values()]) {
            this.send(connection, serialized, tabId);
        }
    }

    detach(senderId: string | number): void {
        this.connections.delete(senderId);
    }

    private createConnection(sender: DesktopIpcSender, clientId: string): Connection {
        const epoch = this.options.createEpoch?.();
        return {
            sender,
            clientId,
            sequencer: new AgentEventSequencer(clientId, epoch),
        };
    }

    private send(connection: Connection, message: AgentServerMessage, tabId?: string): boolean {
        if (connection.sender.isDestroyed()) {
            if (this.connections.get(connection.sender.id) === connection) {
                this.connections.delete(connection.sender.id);
            }
            return false;
        }
        try {
            connection.sender.send(
                DESKTOP_AGENT_EVENT_CHANNEL,
                connection.sequencer.create(message, tabId),
            );
            return true;
        } catch {
            if (this.connections.get(connection.sender.id) === connection) {
                this.connections.delete(connection.sender.id);
            }
            return false;
        }
    }
}

function requestMessage(
    request: AgentRequestEnvelope<AgentClientMessage>,
): AgentClientMessage {
    return { type: request.type, ...request.payload } as AgentClientMessage;
}

function requestMetadata(value: unknown): { requestId: string; clientId: string } {
    if (typeof value !== 'object' || value === null) {
        return { requestId: 'invalid-request', clientId: 'invalid-client' };
    }
    const candidate = value as { requestId?: unknown; clientId?: unknown };
    return {
        requestId: typeof candidate.requestId === 'string' && candidate.requestId.length > 0
            ? candidate.requestId
            : 'invalid-request',
        clientId: typeof candidate.clientId === 'string' && candidate.clientId.length > 0
            ? candidate.clientId
            : 'invalid-client',
    };
}
