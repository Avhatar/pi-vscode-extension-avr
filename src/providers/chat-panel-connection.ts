import type { ClientMessage, ServerMessage } from '../shared/protocol';
import {
    AgentEventSequencer,
    createErrorResponse,
    createSuccessResponse,
} from '../shared/connection-protocol';
import {
    isAgentRequestEnvelope,
    isServerMessage,
} from '../shared/protocol-runtime';
import type { ChatCommandDispatchResult } from '../controllers/chat-controller';

export type ChatCommandDispatcher = (
    message: ClientMessage,
    sourceTabId: string,
) => Promise<ChatCommandDispatchResult>;

export type ChatPanelPostMessage = (value: unknown) => unknown;

/**
 * Per-panel host bridge between versioned connection envelopes and the
 * controller's existing typed command/event boundary.
 */
export class ChatPanelConnection {
    private static readonly MAX_BUFFERED_EVENTS = 100;

    private clientId?: string;
    private sequencer?: AgentEventSequencer;
    private readonly bufferedEvents: ServerMessage[] = [];
    private closed = false;

    constructor(
        private readonly tabId: string,
        private readonly dispatch: ChatCommandDispatcher,
        private readonly postMessage: ChatPanelPostMessage,
        private readonly logRejected: (message: string) => void = (message) => console.warn(message),
    ) {}

    async receive(value: unknown): Promise<void> {
        if (this.closed) return;
        if (!isAgentRequestEnvelope(value)) {
            this.logRejected('[Pi Code] Rejected an invalid chat request envelope.');
            const correlation = readCorrelation(value);
            if (correlation) {
                this.postMessage(createErrorResponse(
                    correlation,
                    'invalid_request',
                    'The chat request envelope is invalid or incompatible.',
                ));
            }
            return;
        }
        if (value.tabId !== undefined && value.tabId !== this.tabId) {
            this.postMessage(createErrorResponse(
                value,
                'tab_mismatch',
                `Request tab ${value.tabId} does not match panel tab ${this.tabId}.`,
            ));
            return;
        }

        if (this.clientId === undefined) {
            if (value.type !== 'getState') {
                this.postMessage(createErrorResponse(
                    value,
                    'handshake_required',
                    'The first request for a panel connection must be getState.',
                ));
                return;
            }
            this.bindClient(value.clientId);
            this.flushBufferedEvents();
        } else if (this.clientId !== value.clientId) {
            if (value.type !== 'getState') {
                this.postMessage(createErrorResponse(
                    value,
                    'client_mismatch',
                    'The panel is bound to a different webview connection.',
                ));
                return;
            }
            this.bindClient(value.clientId);
            this.publish({ type: 'ready' });
        }

        const requestClientId = value.clientId;
        const message = { ...value.payload, type: value.type } as ClientMessage;
        let result: ChatCommandDispatchResult;
        try {
            result = await this.dispatch(message, this.tabId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.postMessage(createErrorResponse(value, 'bridge_dispatch_failed', message));
            return;
        }
        if (this.closed || this.clientId !== requestClientId) return;

        if (result.ok) {
            this.postMessage(createSuccessResponse(value, result.result));
        } else {
            this.postMessage(createErrorResponse(value, result.code, result.message));
        }
    }

    publish(message: ServerMessage): void {
        if (this.closed) return;
        if (!isServerMessage(message)) {
            this.logRejected('[Pi Code] Rejected an invalid chat server message.');
            return;
        }
        if (!this.sequencer) {
            this.bufferEvent(message);
            return;
        }
        this.postMessage(this.sequencer.create(message, this.tabId));
    }

    dispose(): void {
        this.closed = true;
        this.bufferedEvents.length = 0;
        this.clientId = undefined;
        this.sequencer = undefined;
    }

    private bindClient(clientId: string): void {
        this.clientId = clientId;
        this.sequencer = new AgentEventSequencer(clientId);
    }

    private bufferEvent(message: ServerMessage): void {
        if (message.type === 'ready' && this.bufferedEvents.some((event) => event.type === 'ready')) {
            return;
        }
        if (message.type === 'stateSync') {
            const previousState = this.bufferedEvents.findIndex((event) => event.type === 'stateSync');
            if (previousState >= 0) this.bufferedEvents.splice(previousState, 1);
        }
        this.bufferedEvents.push(message);
        while (this.bufferedEvents.length > ChatPanelConnection.MAX_BUFFERED_EVENTS) {
            const removable = this.bufferedEvents.findIndex(
                (event) => event.type !== 'ready' && event.type !== 'stateSync',
            );
            this.bufferedEvents.splice(removable >= 0 ? removable : 0, 1);
        }
    }

    private flushBufferedEvents(): void {
        const events = this.bufferedEvents.splice(0);
        for (const event of events) this.publish(event);
    }
}

function readCorrelation(value: unknown): { requestId: string; clientId: string } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as { requestId?: unknown; clientId?: unknown };
    if (
        typeof candidate.requestId !== 'string'
        || candidate.requestId.length === 0
        || typeof candidate.clientId !== 'string'
        || candidate.clientId.length === 0
    ) {
        return undefined;
    }
    return { requestId: candidate.requestId, clientId: candidate.clientId };
}
