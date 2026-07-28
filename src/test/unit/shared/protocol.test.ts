import { describe, it, expect } from 'vitest';
import type {
    ClientMessage, ServerMessage, SerializedAgentState, LauncherState, LauncherClientMessage,
} from '../../../shared/protocol';
import type { AgentClientMessage, AgentServerMessage } from '../../../shared/agent-protocol';
import type { PlatformClientMessage, PlatformServerMessage } from '../../../shared/platform-protocol';
import type { VsCodeClientMessage, VsCodeServerMessage } from '../../../shared/vscode-protocol';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

type ClientMessagePartition = Expect<Equal<
    ClientMessage,
    AgentClientMessage | PlatformClientMessage | VsCodeClientMessage
>>;
type ServerMessagePartition = Expect<Equal<
    ServerMessage,
    AgentServerMessage | PlatformServerMessage | VsCodeServerMessage
>>;

describe('Protocol types', () => {
    it('keeps portable, platform, and VS Code chat messages in exhaustive partitions', () => {
        const agentClientTypes = [
            'prompt', 'steer', 'followUp', 'abort', 'getModels', 'setModel', 'toggleFavorite',
            'setThinkingLevel', 'newSession', 'loadSession', 'getSessions', 'getState',
            'undoFileChange', 'restoreCheckpoint', 'redoCheckpoint', 'createTab', 'closeTab',
            'switchTab', 'getSkills', 'searchWorkspaceFiles', 'queueMessage', 'editQueuedMessage',
            'removeQueuedMessage', 'cancelQueue', 'setCacheMode', 'setTodoEnabled',
            'setSubagentsEnabled', 'setPlanModeEnabled', 'setFileUndoViewEnabled',
            'setToolDisabled', 'setToolsBulk',
        ] as const;
        const platformClientTypes = ['openFile', 'confirmAction'] as const;
        const vsCodeClientTypes = ['openDiff', 'openSettings', 'openKeybindings', 'openChangelog', 'openRawView'] as const;
        const agentServerTypes = [
            'stateSync', 'agentEvent', 'models', 'modelChanged', 'sessions', 'sessionChanged',
            'fileChange', 'skills', 'workspaceFileSuggestions', 'codexUsage', 'codexUsageError',
            'turnCompleted', 'error',
        ] as const;
        const platformServerTypes = [] as const;
        const vsCodeServerTypes = ['ready', 'rawModeEnabled'] as const;

        type AgentClientTypes = Expect<Equal<typeof agentClientTypes[number], AgentClientMessage['type']>>;
        type PlatformClientTypes = Expect<Equal<typeof platformClientTypes[number], PlatformClientMessage['type']>>;
        type VsCodeClientTypes = Expect<Equal<typeof vsCodeClientTypes[number], VsCodeClientMessage['type']>>;
        type AgentServerTypes = Expect<Equal<typeof agentServerTypes[number], AgentServerMessage['type']>>;
        type PlatformServerTypes = Expect<Equal<typeof platformServerTypes[number], PlatformServerMessage['type']>>;
        type VsCodeServerTypes = Expect<Equal<typeof vsCodeServerTypes[number], VsCodeServerMessage['type']>>;

        const compileTimePartitions: [
            ClientMessagePartition,
            ServerMessagePartition,
            AgentClientTypes,
            PlatformClientTypes,
            VsCodeClientTypes,
            AgentServerTypes,
            PlatformServerTypes,
            VsCodeServerTypes,
        ] = [true, true, true, true, true, true, true, true];

        expect(compileTimePartitions).toEqual([true, true, true, true, true, true, true, true]);
        expect([
            ...agentClientTypes,
            ...platformClientTypes,
            ...vsCodeClientTypes,
        ]).toHaveLength(38);
        expect([
            ...agentServerTypes,
            ...platformServerTypes,
            ...vsCodeServerTypes,
        ]).toHaveLength(15);
    });

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
            { type: 'setPlanModeEnabled', enabled: true },
            { type: 'setTodoEnabled', enabled: false },
            { type: 'setToolDisabled', toolName: 'read', disabled: true },
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
            { type: 'rawModeEnabled', enabled: false },
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
            tabs: [], recentSessions: [], historyCollapsed: true,
            notificationSettings: { showPopup: false, playSound: false },
            notificationsCollapsed: false, todoCollapsed: false,
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
            { type: 'setNotificationShowPopup', enabled: true },
            { type: 'setNotificationPlaySound', enabled: true },
            { type: 'setNotificationsCollapsed', collapsed: true },
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
            { type: 'setToolSelectionAsProjectDefault' },
        ];
        expect(JSON.parse(JSON.stringify(state)).subagents.runs[0].modelLabel).toBe('deepseek/reasoner');
        expect(actions.map((action) => action.type)).toEqual([
            'setNotificationShowPopup', 'setNotificationPlaySound', 'setNotificationsCollapsed',
            'setSubagentsEnabled', 'setSubagentsCollapsed', 'stopSubagent',
            'inspectSubagent', 'resumeSubagent', 'steerSubagent', 'dismissSubagent',
            'reviewSubagentWorktree', 'applySubagentWorktree', 'cleanupSubagentWorktree',
            'dismissSubagentSmoke', 'setToolSelectionAsProjectDefault',
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
