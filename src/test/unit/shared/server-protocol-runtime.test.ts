import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../shared/protocol';
import {
    AGENT_PROTOCOL_VERSION,
    AgentEventSequencer,
} from '../../../shared/connection-protocol';
import { isAgentEventEnvelope } from '../../../shared/protocol-runtime';

const serverMessages: ServerMessage[] = [
    { type: 'ready' },
    {
        type: 'stateSync',
        state: {
            messages: [{ role: 'assistant', content: 'hello' }],
            model: { provider: 'provider', id: 'model', name: 'Model', supportsImages: true },
            thinkingLevel: 'high',
            isStreaming: false,
            isCompacting: false,
            streamingMessage: { role: 'assistant', content: [] },
            errorMessage: 'recoverable',
            tools: ['read'],
            pendingTools: [{
                toolCallId: 'tool-running',
                toolName: 'bash',
                startTime: 123,
                args: { command: 'sleep 80' },
            }],
            sessionId: 'session-1',
            sessionName: 'Session',
            sessionPath: '/sessions/session-1.jsonl',
            contextUsage: { tokens: 10, contextWindow: 100, percent: 10, estimated: true },
            fileChanges: [{
                filePath: '/workspace/file.ts',
                toolCallId: 'tool-1',
                toolName: 'edit',
                isNew: false,
                diff: '@@ -1 +1 @@',
                addedLines: 1,
                removedLines: 1,
                turnIndex: 2,
            }],
            rollbackPoint: 3,
            tabs: [{
                id: 'tab-1',
                name: 'Chat',
                isActive: true,
                isStreaming: true,
                hasNotification: false,
            }],
            activeTabId: 'tab-1',
            streamingText: 'hello',
            streamingThinking: 'working',
            isThinking: true,
            thinkingStartTime: 100,
            streamingThinkingDuration: 50,
            queuedMessages: ['next'],
            cacheMode: 'auto',
            cacheEffective: 'short',
            fileUndoViewEnabled: true,
            interruptedTurn: { reason: 'incomplete_session_tail' },
        },
    },
    { type: 'agentEvent', event: { type: 'agent_start', arbitrarySdkField: true } },
    {
        type: 'models',
        models: [{ provider: 'provider', id: 'model', name: 'Model', supportsImages: true }],
        current: { provider: 'provider', id: 'model' },
        thinkingLevel: 'medium',
        favorites: ['provider/model'],
    },
    { type: 'modelChanged', model: { provider: 'provider', id: 'model' }, thinkingLevel: 'low' },
    {
        type: 'sessions',
        sessions: [{
            id: 'session-1',
            name: 'Session',
            firstMessage: 'Hello',
            path: '/sessions/session-1.jsonl',
            lastModified: 100,
        }],
        currentSessionId: 'session-1',
    },
    { type: 'sessionChanged', sessionId: 'session-1' },
    {
        type: 'fileChange',
        change: {
            filePath: '/workspace/file.ts',
            toolCallId: 'tool-1',
            toolName: 'edit',
            isNew: true,
            addedLines: 5,
            removedLines: 0,
            turnIndex: 1,
        },
    },
    {
        type: 'skills',
        skills: [{
            name: 'review',
            description: 'Review changes',
            filePath: '/skills/review/SKILL.md',
            source: 'project',
            disableModelInvocation: false,
        }],
    },
    {
        type: 'workspaceFileSuggestions',
        requestId: 7,
        query: 'prot',
        isIndexing: false,
        items: [{ relativePath: 'src/shared/protocol.ts', basename: 'protocol.ts', insertText: 'src/shared/protocol.ts' }],
    },
    {
        type: 'codexUsage',
        usage: {
            planType: 'plus',
            activeLimit: 'codex',
            buckets: [{
                limitId: 'codex',
                limitName: 'Codex',
                primary: { percentUsed: 10, windowMinutes: 300, resetAt: 200 },
                secondary: { percentUsed: 20 },
            }],
            credits: { balance: '5', hasCredits: true, unlimited: false },
            individualLimit: { limit: '100', used: '10', remainingPercent: 90, resetAt: 300 },
            rateLimitReachedType: 'none',
            resetCreditsAvailable: 2,
            capturedAt: 100,
        },
    },
    { type: 'codexUsageError', message: 'Unavailable' },
    { type: 'error', message: 'Failed', severity: 'warning' },
];

function eventEnvelope(type: string, payload: Record<string, unknown>) {
    return {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        clientId: 'client-1',
        epoch: 'epoch-1',
        sequence: 1,
        tabId: 'tab-1',
        type,
        payload,
    };
}

describe('server protocol runtime validation', () => {
    it('accepts every current server message payload through an event envelope', () => {
        const sequencer = new AgentEventSequencer('client-1');

        expect(serverMessages).toHaveLength(13);
        for (const message of serverMessages) {
            expect(isAgentEventEnvelope(sequencer.create(message, 'tab-1')), message.type).toBe(true);
        }
    });

    it('rejects malformed and extra server event payload fields', () => {
        const invalidEnvelopes = [
            eventEnvelope('ready', { unexpected: true }),
            eventEnvelope('stateSync', { state: { messages: [], isStreaming: false } }),
            eventEnvelope('stateSync', {
                state: {
                    messages: [],
                    isStreaming: true,
                    tools: [],
                    interruptedTurn: { reason: 'incomplete_session_tail' },
                },
            }),
            eventEnvelope('stateSync', {
                state: {
                    messages: [],
                    isStreaming: false,
                    tools: [],
                    model: { provider: 'provider', id: 'model', unexpected: true },
                },
            }),
            eventEnvelope('models', { models: [{ provider: 'provider' }] }),
            eventEnvelope('sessions', {
                sessions: [{ id: 'session-1', path: '/session.jsonl', lastModified: 'now' }],
            }),
            eventEnvelope('fileChange', {
                change: {
                    filePath: '/file.ts', toolCallId: 'tool-1', toolName: 'edit', isNew: false,
                    addedLines: '1', removedLines: 0, turnIndex: 1,
                },
            }),
            eventEnvelope('skills', {
                skills: [{ name: 'skill', description: '', filePath: '/skill', source: 'project' }],
            }),
            eventEnvelope('workspaceFileSuggestions', {
                requestId: 1,
                query: 'file',
                items: [{ relativePath: 'file.ts', basename: 'file.ts', insertText: 'file.ts', unexpected: true }],
            }),
            eventEnvelope('codexUsage', { usage: { buckets: [] } }),
            eventEnvelope('error', { message: 'Failed', severity: 'debug' }),
        ];

        for (const envelope of invalidEnvelopes) expect(isAgentEventEnvelope(envelope)).toBe(false);
    });
});
