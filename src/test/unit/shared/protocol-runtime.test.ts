import { describe, expect, it } from 'vitest';
import type {
    AgentClientMessage,
    ClientMessage,
    ServerMessage,
} from '../../../shared/protocol';
import {
    AGENT_PROTOCOL_VERSION,
    AgentEventSequencer,
    createAgentRequestEnvelope,
    createErrorResponse,
    createSuccessResponse,
} from '../../../shared/connection-protocol';
import {
    isAgentClientMessage,
    isAgentClientRequestEnvelope,
    isAgentEventEnvelope,
    isAgentRequestEnvelope,
    isAgentResponseEnvelope,
    isClientMessage,
} from '../../../shared/protocol-runtime';

describe('chat protocol runtime validation', () => {
    it('accepts every current client message variant', () => {
        const messages: ClientMessage[] = [
            { type: 'prompt', text: 'hello', images: undefined, files: undefined },
            {
                type: 'steer',
                text: 'redirect',
                images: [{
                    type: 'image', data: 'base64', mimeType: 'image/png', name: 'image.png',
                    size: 6, width: 10, height: 10,
                }],
                files: [{
                    type: 'file', data: 'dGV4dA==', mimeType: 'text/plain', name: 'file.txt', size: 4,
                }],
            },
            { type: 'followUp', text: 'next' },
            { type: 'abort' },
            { type: 'getModels' },
            { type: 'setModel', provider: 'provider', modelId: 'model' },
            { type: 'toggleFavorite', provider: 'provider', modelId: 'model' },
            { type: 'setThinkingLevel', level: 'high' },
            { type: 'newSession' },
            { type: 'loadSession', sessionPath: '/session.jsonl' },
            { type: 'getSessions' },
            { type: 'getState' },
            { type: 'renameTab', name: 'Renamed chat' },
            { type: 'openFile', filePath: '/workspace/file.ts' },
            { type: 'openDiff', filePath: '/workspace/file.ts', toolCallId: 'tool-1' },
            { type: 'undoFileChange', filePath: '/workspace/file.ts', toolCallId: 'tool-1' },
            { type: 'restoreCheckpoint', messageIndex: 3 },
            { type: 'redoCheckpoint' },
            { type: 'confirmAction', action: 'restoreCheckpoint', message: 'Restore?', payload: { messageIndex: 3 } },
            { type: 'createTab' },
            { type: 'closeTab', tabId: 'tab-1' },
            { type: 'switchTab', tabId: 'tab-2' },
            { type: 'openSettings' },
            { type: 'openKeybindings' },
            { type: 'openChangelog' },
            { type: 'getSkills' },
            { type: 'searchWorkspaceFiles', query: 'protocol', requestId: 7 },
            { type: 'queueMessage', text: 'queued' },
            { type: 'editQueuedMessage', index: 0, text: 'edited' },
            { type: 'removeQueuedMessage', index: 0 },
            { type: 'cancelQueue' },
            { type: 'setCacheMode', mode: 'auto' },
            { type: 'setTodoEnabled', enabled: true },
            { type: 'setSubagentsEnabled', enabled: false },
            { type: 'setPlanModeEnabled', enabled: true },
            { type: 'setFileUndoViewEnabled', enabled: true },
            { type: 'setToolDisabled', toolName: 'read', disabled: true },
            { type: 'setToolsBulk', disabled: ['bash', 'write'] },
        ];

        expect(messages).toHaveLength(38);
        for (const message of messages) expect(isClientMessage(message), message.type).toBe(true);
    });

    it('validates the portable agent subset independently from platform clients', () => {
        const messages: AgentClientMessage[] = [
            { type: 'prompt', text: 'hello' },
            { type: 'abort' },
            { type: 'getState' },
            { type: 'renameTab', name: 'Renamed chat' },
            { type: 'createTab' },
            { type: 'setCacheMode', mode: 'auto' },
        ];

        for (const message of messages) expect(isAgentClientMessage(message), message.type).toBe(true);
        expect(isAgentClientMessage({ type: 'openFile', filePath: '/workspace/file.ts' })).toBe(false);
        expect(isAgentClientMessage({ type: 'openSettings' })).toBe(false);

        const request = createAgentRequestEnvelope(
            { requestId: 'request-agent', clientId: 'desktop-client' },
            { type: 'getState' },
        );
        expect(isAgentClientRequestEnvelope(request)).toBe(true);
        expect(isAgentClientRequestEnvelope(createAgentRequestEnvelope(
            { requestId: 'request-platform', clientId: 'desktop-client' },
            { type: 'openFile', filePath: '/workspace/file.ts' },
        ))).toBe(false);
    });

    it('rejects malformed and unknown client messages', () => {
        const invalidMessages: unknown[] = [
            null,
            'prompt',
            {},
            { type: 'unknown' },
            { type: 'prompt' },
            { type: 'prompt', text: 42 },
            { type: 'renameTab', name: '' },
            {
                type: 'prompt',
                text: 'hello',
                images: [{ type: 'image', data: 'base64', mimeType: 'image/png', unexpected: true }],
            },
            { type: 'setModel', provider: 'provider' },
            { type: 'restoreCheckpoint', messageIndex: '3' },
            { type: 'editQueuedMessage', index: 0.5, text: 'fractional' },
            { type: 'removeQueuedMessage', index: -1 },
            { type: 'setCacheMode', mode: 'forever' },
            { type: 'setTodoEnabled', enabled: 'yes' },
            { type: 'setToolDisabled', toolName: 'read' },
            { type: 'setToolsBulk', disabled: ['read', 7] },
            { type: 'abort', unexpected: true },
        ];

        for (const message of invalidMessages) expect(isClientMessage(message)).toBe(false);
    });

    it('validates versioned requests and correlates success and error responses', () => {
        const request = createAgentRequestEnvelope(
            { requestId: 'request-1', clientId: 'client-1', tabId: 'tab-1' },
            { type: 'prompt', text: 'hello' },
        );

        expect(request).toEqual({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            requestId: 'request-1',
            clientId: 'client-1',
            tabId: 'tab-1',
            type: 'prompt',
            payload: { text: 'hello' },
        });
        expect(isAgentRequestEnvelope(request)).toBe(true);
        expect(isAgentRequestEnvelope({ ...request, protocolVersion: 99 })).toBe(false);
        expect(isAgentRequestEnvelope({ ...request, requestId: '' })).toBe(false);
        expect(isAgentRequestEnvelope({ ...request, payload: { text: 42 } })).toBe(false);
        expect(isAgentRequestEnvelope({
            ...request,
            payload: { type: 'abort', text: 'hello' },
        })).toBe(false);

        const metadataWithInjectedVersion = {
            requestId: 'request-2',
            clientId: 'client-1',
            protocolVersion: 99,
        };
        expect(createAgentRequestEnvelope(metadataWithInjectedVersion, { type: 'abort' }).protocolVersion)
            .toBe(AGENT_PROTOCOL_VERSION);

        const success = createSuccessResponse(request, { accepted: true });
        const failure = createErrorResponse(request, 'busy', 'The tab is already streaming.');
        expect(success).toMatchObject({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            clientId: request.clientId,
            ok: true,
            result: { accepted: true },
        });
        expect(failure).toMatchObject({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            requestId: request.requestId,
            clientId: request.clientId,
            ok: false,
            error: { code: 'busy', message: 'The tab is already streaming.' },
        });
        expect(isAgentResponseEnvelope(success)).toBe(true);
        expect(isAgentResponseEnvelope(failure)).toBe(true);
    });

    it('assigns monotonically increasing event sequence numbers per connection', () => {
        const sequencer = new AgentEventSequencer('client-1', 'epoch-1');
        const first = sequencer.create({ type: 'error', message: 'first' }, 'tab-1');
        const second = sequencer.create({ type: 'error', message: 'second' }, 'tab-1');
        const otherConnection = new AgentEventSequencer('client-2', 'epoch-2');
        const otherFirst = otherConnection.create({ type: 'error', message: 'other' });

        expect([first.sequence, second.sequence]).toEqual([1, 2]);
        expect(otherFirst.sequence).toBe(1);
        expect(isAgentEventEnvelope(first)).toBe(true);
        const { epoch: _epoch, ...withoutEpoch } = first;
        expect(isAgentEventEnvelope(withoutEpoch)).toBe(false);
        expect(isAgentEventEnvelope({ ...first, sequence: 0 })).toBe(false);
        expect(isAgentEventEnvelope({ ...first, type: 'unknown' })).toBe(false);
        expect(first).toMatchObject({
            protocolVersion: AGENT_PROTOCOL_VERSION,
            clientId: 'client-1',
            epoch: 'epoch-1',
            tabId: 'tab-1',
            type: 'error',
            payload: { message: 'first' },
        });

        const typedEvent: ServerMessage = { type: first.type, ...first.payload } as ServerMessage;
        expect(typedEvent.type).toBe('error');
    });
});
