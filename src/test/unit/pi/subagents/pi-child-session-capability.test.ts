import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PiChildSessionFactory } from '../../../../pi/subagents/pi-child-session';
import type { ResolvedAgentSpec } from '../../../../pi/subagents/types';

const sdk = vi.hoisted(() => ({
    createAgentSession: vi.fn(),
    resourceLoaderOptions: [] as any[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
    return {
        ...actual,
        SessionManager: {
            create: vi.fn(),
            open: vi.fn(),
            inMemory: () => ({ getSessionFile: () => undefined }),
        },
        createAgentSession: sdk.createAgentSession,
        DefaultResourceLoader: class {
            constructor(options: any) { sdk.resourceLoaderOptions.push(options); }
            async reload(): Promise<void> {}
        },
        getAgentDir: () => '/agent',
        SettingsManager: { inMemory: () => ({}) },
    };
});

beforeEach(() => {
    vi.clearAllMocks();
    sdk.resourceLoaderOptions.length = 0;
    sdk.createAgentSession.mockImplementation(async () => ({
        session: {
            sessionId: 'child-session',
            subscribe: () => () => {},
            abort: async () => undefined,
            prompt: async () => undefined,
            steer: async () => undefined,
            dispose: () => {},
        },
    }));
});

describe('child capability boundary', () => {
    it('refuses shell access for children by default', async () => {
        const factory = createFactory({});

        await expect(factory.create(spec(['read', 'bash']), context()))
            .rejects.toThrow('Unsupported child tools: bash.');
    });

    it('passes shell access through once the host grants it', async () => {
        const factory = createFactory({ allowBash: true });

        await factory.create(spec(['read', 'bash']), context());

        expect(sdk.createAgentSession.mock.calls[0][0].tools)
            .toEqual(['read', 'bash', 'complete_subagent']);
    });

    it('still refuses tools outside the grant when shell access is on', async () => {
        const factory = createFactory({ allowBash: true });

        await expect(factory.create(spec(['read', 'web_search']), context()))
            .rejects.toThrow('Unsupported child tools: web_search.');
    });
});

describe('child turn budget briefing', () => {
    it('tells the child how many turns it has and what a turn costs', async () => {
        const factory = createFactory({});

        await factory.create({ ...spec(['read']), maxTurns: 40 }, context());

        const appended = sdk.resourceLoaderOptions[0].appendSystemPrompt.join('\n');
        expect(appended).toContain('You have a budget of 40 turns');
        expect(appended).toContain('each file you read or edit spends a turn');
        expect(appended).toContain('call complete_subagent before the budget runs out');
    });
});

function createFactory(overrides: { allowBash?: boolean }): PiChildSessionFactory {
    return new PiChildSessionFactory({
        cwd: '/workspace',
        workspaceTrusted: true,
        modelRuntime: {
            getModel: () => ({ provider: 'test', id: 'model' }),
            hasConfiguredAuth: () => true,
        } as any,
        ...overrides,
    } as any);
}

function context() {
    return { agentId: 'child', signal: new AbortController().signal };
}

function spec(tools: string[]): ResolvedAgentSpec {
    return {
        name: 'capability',
        source: 'invocation',
        task: 'Do the delegated slice.',
        model: { provider: 'test', id: 'model' },
        modelSource: 'invocation',
        tools,
        toolTrace: { registered: tools, active: tools, childSafe: tools, denied: [], effective: tools },
        maxTurns: 20,
        timeoutMinutes: 5,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };
}
