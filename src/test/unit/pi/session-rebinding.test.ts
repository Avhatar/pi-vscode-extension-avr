import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import { PiSessionManager } from '../../../pi/session';
import { DEFAULT_SESSION_RUNTIME_PORTS } from '../../../core/ports/session-platform';
import { resetTestWorkspace, setTestWorkspaceRoot } from '../../mocks/vscode';

const sdkMocks = vi.hoisted(() => ({
    createAgentSession: vi.fn(),
    createSessionManager: vi.fn(),
    openSessionManager: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
    getAuthStorage: vi.fn(async () => ({})),
}));

const modelMocks = vi.hoisted(() => ({
    refreshModelRegistry: vi.fn(async () => undefined),
}));

const preflightMocks = vi.hoisted(() => ({
    install: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
    return {
        ...actual,
        createAgentSession: sdkMocks.createAgentSession,
        SessionManager: {
            create: sdkMocks.createSessionManager,
            open: sdkMocks.openSessionManager,
        },
    };
});

vi.mock('../../../pi/auth', () => ({
    getAuthStorage: authMocks.getAuthStorage,
    reloadCredentials: vi.fn(async () => undefined),
    disposeAuthStorage: vi.fn(),
}));

vi.mock('../../../pi/models', () => ({
    getModelRegistry: vi.fn(async () => ({})),
    getAvailableModels: vi.fn(() => []),
    findModel: vi.fn(() => undefined),
    refreshModelRegistry: modelMocks.refreshModelRegistry,
    disposeModelRegistry: vi.fn(),
}));

vi.mock('../../../pi/tools/preflight-edit', () => ({
    installEditToolPreflight: preflightMocks.install,
}));

describe('PiSessionManager session replacement', () => {
    let activeManager: PiSessionManager | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        setTestWorkspaceRoot(process.cwd());
        sdkMocks.createSessionManager.mockReturnValue({ getSessionFile: () => undefined });
        sdkMocks.openSessionManager.mockReturnValue({ getSessionFile: () => undefined });
    });

    afterEach(async () => {
        await activeManager?.dispose();
        activeManager = undefined;
        resetTestWorkspace();
    });

    it('newSession rebinds extensions and events while preserving router subscribers', async () => {
        const harness = await createReplacementHarness();
        activeManager = harness.manager;

        await harness.manager.newSession();

        expect(sdkMocks.createSessionManager).toHaveBeenCalledWith(process.cwd());
        expect(sdkMocks.openSessionManager).not.toHaveBeenCalled();
        expect(sdkMocks.createAgentSession).toHaveBeenCalledWith(
            expect.objectContaining({ cwd: process.cwd(), tools: ['read'] }),
        );
        expectReplacementLifecycle(harness, true);
    });

    it('loadSession rebinds extensions and events while preserving router subscribers', async () => {
        const harness = await createReplacementHarness();
        const sessionPath = 'X:/sessions/existing.jsonl';
        activeManager = harness.manager;

        await harness.manager.loadSession(sessionPath);

        expect(sdkMocks.openSessionManager).toHaveBeenCalledWith(sessionPath, undefined);
        expect(sdkMocks.createSessionManager).not.toHaveBeenCalled();
        const creationOptions = sdkMocks.createAgentSession.mock.calls[0][0];
        expect(creationOptions.cwd).toBe(process.cwd());
        expect(creationOptions).not.toHaveProperty('tools');
        expectReplacementLifecycle(harness, false);
    });
});

interface ReplacementHarness {
    manager: PiSessionManager;
    original: FakeAgentSession;
    replacement: FakeAgentSession;
    order: string[];
    observedEvents: string[];
    resetSubagentManager: ReturnType<typeof vi.fn>;
    applyDefaultSettings: ReturnType<typeof vi.fn>;
}

async function createReplacementHarness(): Promise<ReplacementHarness> {
    const order: string[] = [];
    const original = createFakeAgentSession('original', order);
    const replacement = createFakeAgentSession('replacement', order);
    const outputChannel = { appendLine: vi.fn() };
    const manager = new PiSessionManager(
        outputChannel as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
            ...DEFAULT_SESSION_RUNTIME_PORTS,
            settings: {
                get: ((key: string, fallback: unknown) =>
                    key === 'allowedTools' ? ['read'] : fallback) as any,
            },
        },
    );
    const observedEvents: string[] = [];
    manager.events.onAll(event => observedEvents.push(event.type));

    await (manager as any)._runtime.start(async () => ({
        session: original.session,
        sessionManager: { getSessionFile: () => undefined },
    }));
    (manager as any)._modelRegistry = {};
    (manager as any)._subagentManager = {
        async dispose(): Promise<void> {
            order.push('original-subagents:dispose');
        },
    };
    (manager as any)._buildResourceLoader = vi.fn(async () => {
        order.push('resources:build');
        return {};
    });
    const resetSubagentManager = vi.fn(async () => {
        order.push('replacement-subagents:reset');
    });
    const applyDefaultSettings = vi.fn(async () => {
        order.push('replacement-defaults:apply');
    });
    (manager as any)._resetSubagentManager = resetSubagentManager;
    (manager as any)._applyDefaultSettings = applyDefaultSettings;
    preflightMocks.install.mockImplementation(() => order.push('replacement:preflight'));
    modelMocks.refreshModelRegistry.mockImplementation(async () => {
        order.push('models:refresh');
    });
    authMocks.getAuthStorage.mockImplementation(async () => {
        order.push('auth:get');
        return {};
    });
    sdkMocks.createAgentSession.mockImplementation(async () => {
        order.push('replacement:create');
        return { session: replacement.session };
    });

    original.emit({ type: 'agent_start' } as AgentSessionEvent);
    expect(observedEvents).toEqual(['agent_start']);
    observedEvents.length = 0;
    order.length = 0;

    return {
        manager,
        original,
        replacement,
        order,
        observedEvents,
        resetSubagentManager,
        applyDefaultSettings,
    };
}

function expectReplacementLifecycle(harness: ReplacementHarness, appliesDefaults: boolean): void {
    const {
        manager,
        original,
        replacement,
        order,
        observedEvents,
        resetSubagentManager,
        applyDefaultSettings,
    } = harness;

    expect((manager as any).session).toBe(replacement.session);
    expect(original.session.dispose).toHaveBeenCalledOnce();
    expect(sdkMocks.createAgentSession).toHaveBeenCalledOnce();
    expect(replacement.session.bindExtensions).toHaveBeenCalledOnce();
    expect(replacement.session.subscribe).toHaveBeenCalledOnce();
    expect(resetSubagentManager).toHaveBeenCalledOnce();
    if (appliesDefaults) expect(applyDefaultSettings).toHaveBeenCalledOnce();
    else expect(applyDefaultSettings).not.toHaveBeenCalled();

    expectLifecycleOrder(order, [
        'original-subagents:dispose',
        'original:unsubscribe',
        'original:dispose',
        'models:refresh',
        'resources:build',
        'auth:get',
        'replacement:create',
        'replacement:bind',
        'replacement:preflight',
        'replacement:subscribe',
        'replacement-subagents:reset',
        ...(appliesDefaults ? ['replacement-defaults:apply'] : []),
    ]);

    original.emit({ type: 'agent_end' } as AgentSessionEvent);
    expect(observedEvents).toEqual([]);
    replacement.emit({ type: 'agent_end' } as AgentSessionEvent);
    expect(observedEvents).toEqual(['agent_end']);
}

function expectLifecycleOrder(actual: string[], expected: string[]): void {
    let previousIndex = -1;
    for (const step of expected) {
        const index = actual.indexOf(step);
        expect(index, `missing lifecycle step: ${step}`).toBeGreaterThan(previousIndex);
        previousIndex = index;
    }
}

interface FakeAgentSession {
    session: {
        sessionId: string;
        agent: { waitForIdle(): Promise<void> };
        reload(): Promise<void>;
        bindExtensions: ReturnType<typeof vi.fn>;
        subscribe: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
    };
    emit(event: AgentSessionEvent): void;
}

function createFakeAgentSession(label: string, order: string[]): FakeAgentSession {
    let listener: AgentSessionEventListener | undefined;
    let subscribed = false;
    const session = {
        sessionId: `${label}-session`,
        agent: { waitForIdle: async () => undefined },
        reload: async () => undefined,
        bindExtensions: vi.fn(async () => {
            order.push(`${label}:bind`);
        }),
        subscribe: vi.fn((nextListener: AgentSessionEventListener) => {
            order.push(`${label}:subscribe`);
            listener = nextListener;
            subscribed = true;
            return () => {
                order.push(`${label}:unsubscribe`);
                subscribed = false;
            };
        }),
        dispose: vi.fn(() => {
            order.push(`${label}:dispose`);
        }),
    };

    return {
        session,
        emit(event: AgentSessionEvent): void {
            if (subscribed) listener?.(event);
        },
    };
}
