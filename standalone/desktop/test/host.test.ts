import { describe, expect, it, vi } from 'vitest';
import type { FileStatePort } from '../../../src/core/ports/file-state';
import type { StateStore } from '../../../src/core/ports/chat-platform';
import { EventRouter } from '../../../src/pi/events';
import { createAgentRequestEnvelope } from '../../../src/shared/connection-protocol';
import {
    createDesktopChatRuntime,
    type DesktopChatRuntimeDependencies,
} from '../src/host';
import { DesktopIpcHost } from '../src/ipc-host';

class MemoryStateStore implements StateStore {
    readonly values = new Map<string, unknown>();

    get<T>(key: string, fallback?: T): T | undefined {
        return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
    }
}

class MemoryFileState implements FileStatePort {
    resolvePath(filePath: string): string { return filePath; }
    captureText(): { kind: 'missing' } { return { kind: 'missing' }; }
    readText(): string { throw new Error('missing'); }
    exists(): boolean { return false; }
    writeText(): void {}
    deleteFile(): void {}
}

function createSession(path: string) {
    const events = new EventRouter();
    const session = {
        events,
        todoStore: { subscribe: vi.fn(() => () => undefined) },
        onSubagentStateChanged: vi.fn(() => ({ dispose: vi.fn() })),
        onSubagentMutation: vi.fn(() => ({ dispose: vi.fn() })),
        onSubagentNotification: vi.fn(() => ({ dispose: vi.fn() })),
        initialize: vi.fn(async () => undefined),
        initializeFromPath: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
        sessionPath: path,
        session: { sessionId: path, sessionName: undefined },
        isStreaming: false,
        getMessages: vi.fn(() => []),
        setMessages: vi.fn(),
        serializeState: vi.fn(() => ({
            messages: [], isStreaming: false, tools: ['read'], sessionId: path,
        })),
        getCurrentModel: vi.fn(() => ({ provider: 'provider', id: 'model' })),
        getModels: vi.fn(() => [{ provider: 'provider', id: 'model' }]),
        getThinkingLevel: vi.fn(() => 'off'),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        getSessions: vi.fn(async () => []),
        getSkills: vi.fn(() => []),
        getRegisteredToolsInfo: vi.fn(() => [{ name: 'read' }]),
        applyToolSelection: vi.fn(),
        debugSnapshotTools: vi.fn(() => ({
            active: ['read'], hasTodo: false, todoRegistered: false,
            hasSubagent: false, subagentRegistered: false,
        })),
        setSubagentParentTabId: vi.fn(),
        prompt: vi.fn(async () => undefined),
        compact: vi.fn(async () => undefined),
        steer: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        newSession: vi.fn(async () => undefined),
        loadSession: vi.fn(async () => undefined),
        setSessionName: vi.fn(),
        markTurnStarted: vi.fn(),
        markTurnCompleted: vi.fn(),
    };
    return session;
}

function createDependencies() {
    const workspaceState = new MemoryStateStore();
    const globalState = new MemoryStateStore();
    const sessions: ReturnType<typeof createSession>[] = [];
    const emitted: Array<{ message: any; tabId?: string }> = [];
    const dependencies: DesktopChatRuntimeDependencies = {
        workspaceState,
        globalState,
        fileMentions: {
            isReady: true,
            ensureIndexed: vi.fn(async () => undefined),
            search: vi.fn(async () => []),
            augmentPromptIfNeeded: vi.fn(async (text: string) => text),
        },
        fileState: new MemoryFileState(),
        logger: { appendLine: vi.fn() },
        createSession: () => {
            const session = createSession(`/sessions/${sessions.length + 1}.jsonl`);
            sessions.push(session);
            return session as any;
        },
        emit: (message, tabId) => { emitted.push({ message, tabId }); },
    };
    return { dependencies, workspaceState, globalState, sessions, emitted };
}

describe('desktop ChatHost composition', () => {
    it('creates an initial tab and routes portable commands through ChatHost', async () => {
        const { dependencies, sessions, emitted, workspaceState } = createDependencies();
        const runtime = createDesktopChatRuntime(dependencies);

        await runtime.initialize();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].initialize).toHaveBeenCalledOnce();
        expect(runtime.getState()).toMatchObject({
            activeTabId: expect.any(String),
            sessionId: '/sessions/1.jsonl',
            tools: ['read'],
        });

        await expect(runtime.dispatch({ type: 'getModels' })).resolves.toEqual({ ok: true });
        expect(emitted.some(({ message }) => message.type === 'models')).toBe(true);
        expect(workspaceState.values.get('pi-code.tabs')).toMatchObject({
            tabs: [{ sessionPath: '/sessions/1.jsonl' }],
            activeIndex: 0,
        });

        await runtime.dispose();
    });

    it('projects bound session events without implementing a second reducer', async () => {
        const { dependencies, sessions, emitted } = createDependencies();
        const runtime = createDesktopChatRuntime(dependencies);
        await runtime.initialize();

        sessions[0].events.dispatch({ type: 'agent_start' } as any);
        await Promise.resolve();
        await Promise.resolve();

        expect(emitted.some(({ message }) => (
            message.type === 'agentEvent' && message.event.type === 'agent_start'
        ))).toBe(true);
        expect(runtime.getState()?.isStreaming).toBe(true);
        await runtime.dispose();
    });

    it('starts shutdown for every tab, rejects new commands, and disposes resources', async () => {
        const { dependencies, sessions } = createDependencies();
        const runtime = createDesktopChatRuntime(dependencies);
        await runtime.initialize();
        await runtime.host.createTab();

        const pending = runtime.shutdown();
        await expect(runtime.dispatch({ type: 'abort' })).resolves.toMatchObject({
            ok: false,
            code: 'host_shutting_down',
        });
        await pending;

        expect(sessions).toHaveLength(2);
        expect(sessions.every((session) => session.shutdown.mock.calls.length === 1)).toBe(true);
        expect(sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(true);
    });

    it('keeps the same runtime alive across renderer document rebinding', async () => {
        const { dependencies, sessions } = createDependencies();
        const runtime = createDesktopChatRuntime(dependencies);
        await runtime.initialize();
        const ipc = new DesktopIpcHost(runtime, { createEpoch: (() => {
            let value = 0;
            return () => `epoch-${++value}`;
        })() });
        const sender = {
            id: 1,
            isDestroyed: () => false,
            send: vi.fn(),
        };

        await ipc.handle(sender, createAgentRequestEnvelope(
            { requestId: 'state-1', clientId: 'renderer-1' },
            { type: 'getState' },
        ));
        const sessionId = runtime.getState()?.sessionId;
        await ipc.handle(sender, createAgentRequestEnvelope(
            { requestId: 'state-2', clientId: 'renderer-2' },
            { type: 'getState' },
        ));

        expect(runtime.getState()?.sessionId).toBe(sessionId);
        expect(sessions[0].dispose).not.toHaveBeenCalled();
        expect(sender.send).toHaveBeenCalledTimes(2);
        await runtime.dispose();
    });

    it('restores persisted session paths without creating a bootstrap session', async () => {
        const { dependencies, sessions, workspaceState } = createDependencies();
        workspaceState.values.set('pi-code.tabs', {
            tabs: [
                { name: 'First', sessionPath: '/sessions/first.jsonl' },
                { name: 'Second', sessionPath: '/sessions/second.jsonl' },
            ],
            activeIndex: 1,
        });
        const runtime = createDesktopChatRuntime(dependencies);

        await runtime.initialize();

        expect(sessions).toHaveLength(2);
        expect(sessions[0].initialize).not.toHaveBeenCalled();
        expect(sessions[0].initializeFromPath).toHaveBeenCalledWith('/sessions/first.jsonl');
        expect(sessions[1].initializeFromPath).toHaveBeenCalledWith('/sessions/second.jsonl');
        expect(runtime.getState()?.activeTabId).toBe([...runtime.host.tabs.keys()][1]);
        await runtime.dispose();
        expect(sessions.every((session) => session.dispose.mock.calls.length === 1)).toBe(true);
    });
});
