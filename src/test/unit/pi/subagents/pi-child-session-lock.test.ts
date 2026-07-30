import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiChildSessionFactory } from '../../../../pi/subagents/pi-child-session';
import type { ResolvedAgentSpec } from '../../../../pi/subagents/types';

const sdk = vi.hoisted(() => ({
    createManager: vi.fn(),
    openManager: vi.fn(),
    createAgentSession: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
    return {
        ...actual,
        SessionManager: {
            create: sdk.createManager,
            open: sdk.openManager,
            inMemory: vi.fn(),
        },
        createAgentSession: sdk.createAgentSession,
        DefaultResourceLoader: class {
            async reload(): Promise<void> {}
        },
        getAgentDir: () => '/agent',
        SettingsManager: {
            inMemory: () => ({}),
        },
    };
});

const temporaryDirectories: string[] = [];

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })));
});

describe('PiChildSessionFactory session ownership', () => {
    it('locks persistent child creation and releases only after session disposal', async () => {
        const transcriptDirectory = await createDirectory();
        const transcriptPath = path.join(transcriptDirectory, 'child.jsonl');
        const order: string[] = [];
        sdk.createManager.mockImplementation(() => {
            order.push('manager:create');
            return { getSessionFile: () => transcriptPath };
        });
        const session = createSession(order);
        sdk.createAgentSession.mockImplementation(async () => {
            order.push('agent:create');
            return { session };
        });
        const release = vi.fn(async () => { order.push('session:unlock'); });
        const acquire = vi.fn(async () => {
            order.push('session:lock');
            return createLockHandle(transcriptPath, release);
        });
        const factory = createFactory(transcriptDirectory, { acquire, recoverStale: vi.fn() });

        const handle = await factory.create(spec(), {
            agentId: 'child', signal: new AbortController().signal,
        });
        expect(order.slice(0, 3)).toEqual(['manager:create', 'session:lock', 'agent:create']);
        expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
            modelRuntime: expect.any(Object),
        }));
        expect(sdk.createAgentSession.mock.calls[0][0]).not.toHaveProperty('authStorage');
        expect(sdk.createAgentSession.mock.calls[0][0]).not.toHaveProperty('modelRegistry');

        await handle.dispose();
        expectLifecycleOrder(order, ['session:dispose', 'session:unlock']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('locks a persisted transcript before SessionManager.open and unlocks failures', async () => {
        const transcriptDirectory = await createDirectory();
        const transcriptPath = path.join(transcriptDirectory, 'child.jsonl');
        await fs.writeFile(transcriptPath, '{}\n', 'utf8');
        const order: string[] = [];
        sdk.openManager.mockImplementation(() => {
            order.push('manager:open');
            return { getSessionFile: () => transcriptPath };
        });
        sdk.createAgentSession.mockRejectedValueOnce(new Error('child failed'));
        const release = vi.fn(async () => { order.push('session:unlock'); });
        const acquire = vi.fn(async () => {
            order.push('session:lock');
            return createLockHandle(transcriptPath, release);
        });
        const factory = createFactory(transcriptDirectory, { acquire, recoverStale: vi.fn() });

        await expect(factory.resume(spec(), transcriptPath, {
            agentId: 'child', signal: new AbortController().signal,
        })).rejects.toThrow('child failed');

        expectLifecycleOrder(order, ['session:lock', 'manager:open', 'session:unlock']);
        expect(release).toHaveBeenCalledOnce();
    });
});

async function createDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-child-lock-'));
    temporaryDirectories.push(directory);
    return directory;
}

function createFactory(transcriptDirectory: string, sessionLocks: any): PiChildSessionFactory {
    const model = { provider: 'test', id: 'model' };
    return new PiChildSessionFactory({
        cwd: transcriptDirectory,
        workspaceTrusted: true,
        modelRuntime: {
            getModel: () => model,
            hasConfiguredAuth: () => true,
        } as any,
        transcriptDirectory,
        sessionLocks,
    } as any);
}

function createSession(order: string[]): any {
    return {
        sessionId: 'child-session',
        subscribe: () => () => { order.push('session:unsubscribe'); },
        abort: async () => undefined,
        prompt: async () => undefined,
        steer: async () => undefined,
        dispose: () => { order.push('session:dispose'); },
    };
}

function createLockHandle(sessionPath: string, release: () => Promise<void>): any {
    return {
        sessionPath,
        owner: {
            ownerId: 'child-owner',
            applicationId: 'test',
            processId: 1,
            hostname: 'test-host',
            acquiredAt: 0,
        },
        release,
    };
}

function spec(): ResolvedAgentSpec {
    return {
        name: 'runtime-test',
        source: 'invocation',
        task: 'Test.',
        model: { provider: 'test', id: 'model' },
        modelSource: 'invocation',
        tools: ['read'],
        toolTrace: {
            registered: ['read'], active: ['read'], childSafe: ['read'], denied: [], effective: ['read'],
        },
        maxTurns: 4,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };
}

function expectLifecycleOrder(actual: string[], expected: string[]): void {
    let previous = -1;
    for (const step of expected) {
        const index = actual.indexOf(step);
        expect(index, `missing lifecycle step: ${step}`).toBeGreaterThan(previous);
        previous = index;
    }
}
