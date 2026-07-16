import { describe, it, expect } from 'vitest';
import type {
    ClientMessage, ServerMessage, SerializedAgentState, LauncherState, LauncherClientMessage,
} from '../../../shared/protocol';

describe('Protocol types', () => {
    it('client messages serialize correctly', () => {
        const messages: ClientMessage[] = [
            { type: 'prompt', text: 'hello' },
            { type: 'abort' },
            { type: 'setModel', provider: 'ollama', modelId: 'test/model' },
            { type: 'setThinkingLevel', level: 'high' },
            { type: 'newSession' },
            { type: 'getModels' },
            { type: 'getSessions' },
            { type: 'getState' },
        ];

        for (const msg of messages) {
            const serialized = JSON.stringify(msg);
            const deserialized = JSON.parse(serialized) as ClientMessage;
            expect(deserialized.type).toBe(msg.type);
        }
    });

    it('server messages serialize correctly', () => {
        const state: SerializedAgentState = {
            messages: [{ role: 'user', content: 'hello' }],
            isStreaming: false,
            tools: ['bash', 'read', 'write', 'edit'],
            sessionId: 'test-id',
            model: { provider: 'ollama', id: 'test/model', name: 'Test Model' },
            thinkingLevel: 'off',
        };

        const messages: ServerMessage[] = [
            { type: 'ready' },
            { type: 'stateSync', state },
            { type: 'error', message: 'something went wrong' },
            { type: 'models', models: [{ provider: 'ollama', id: 'test', name: 'Test' }] },
        ];

        for (const msg of messages) {
            const roundTripped = JSON.parse(JSON.stringify(msg)) as ServerMessage;
            expect(roundTripped.type).toBe(msg.type);
        }
    });

    it('launcher subagent lifecycle state and actions serialize', () => {
        const state: LauncherState = {
            tabs: [], recentSessions: [], historyCollapsed: true, todoCollapsed: false,
            subagentsCollapsed: false, toolsCollapsed: true,
            subagents: {
                enabled: true, toggleDisabled: false, activeCount: 1, queuedCount: 0,
                runs: [{
                    agentId: 'child', name: 'reviewer', task: 'Review authentication', taskPreview: 'Review',
                    result: 'No critical issues.', resultPreview: 'No critical issues.', status: 'completed',
                    modelLabel: 'deepseek/reasoner', activity: 'Completed',
                    elapsedMs: 5_000, turnCount: 1, canDismiss: true,
                }],
            },
        };
        const actions: LauncherClientMessage[] = [
            { type: 'setSubagentsEnabled', enabled: true },
            { type: 'setSubagentsCollapsed', collapsed: false },
            { type: 'stopSubagent', agentId: 'child' },
            { type: 'inspectSubagent', agentId: 'child' },
            { type: 'resumeSubagent', agentId: 'child' },
            { type: 'steerSubagent', agentId: 'child' },
            { type: 'dismissSubagent', agentId: 'child' },
            { type: 'reviewSubagentWorktree', agentId: 'child' },
            { type: 'applySubagentWorktree', agentId: 'child' },
            { type: 'cleanupSubagentWorktree', agentId: 'child' },
            { type: 'dismissSubagentSmoke' },
        ];
        expect(JSON.parse(JSON.stringify(state)).subagents.runs[0].modelLabel).toBe('deepseek/reasoner');
        expect(actions.map((action) => action.type)).toEqual([
            'setSubagentsEnabled', 'setSubagentsCollapsed', 'stopSubagent',
            'inspectSubagent', 'resumeSubagent', 'steerSubagent', 'dismissSubagent',
            'reviewSubagentWorktree', 'applySubagentWorktree', 'cleanupSubagentWorktree',
            'dismissSubagentSmoke',
        ]);
    });

    it('state with streaming message serializes', () => {
        const state: SerializedAgentState = {
            messages: [],
            isStreaming: true,
            streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'streaming...' }] },
            tools: [],
        };

        const msg: ServerMessage = { type: 'stateSync', state };
        const parsed = JSON.parse(JSON.stringify(msg));
        expect(parsed.state.isStreaming).toBe(true);
        expect(parsed.state.streamingMessage).toBeDefined();
    });
});
