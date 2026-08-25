import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiChildSessionFactory } from '../../../../pi/subagents/pi-child-session';
import { DEFAULT_SESSION_RUNTIME_PORTS } from '../../../../core/ports/session-platform';
import type { ResolvedAgentSpec } from '../../../../pi/subagents/types';

const sdk = vi.hoisted(() => ({
    createAgentSession: vi.fn(),
    resourceLoaderOptions: [] as any[],
    openedTranscripts: [] as any[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
    return {
        ...actual,
        SessionManager: {
            create: vi.fn(),
            open: vi.fn((transcriptPath: string) => {
                sdk.openedTranscripts.push(transcriptPath);
                return { getSessionFile: () => transcriptPath };
            }),
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

let root: string;
let transcriptDirectory: string;
let transcriptPath: string;

beforeEach(async () => {
    vi.clearAllMocks();
    sdk.resourceLoaderOptions.length = 0;
    sdk.openedTranscripts.length = 0;
    sdk.createAgentSession.mockImplementation(async () => ({
        session: {
            sessionId: 'resumed-child-session',
            subscribe: () => () => {},
            abort: async () => undefined,
            prompt: async () => undefined,
            steer: async () => undefined,
            dispose: () => {},
        },
    }));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-child-resume-'));
    transcriptDirectory = path.join(root, 'transcripts');
    await fs.mkdir(transcriptDirectory, { recursive: true });
    transcriptPath = path.join(transcriptDirectory, 'child.jsonl');
    await fs.writeFile(transcriptPath, '{}\n', 'utf8');
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('resuming a write-capable worktree child', () => {
    it('reattaches the recorded worktree instead of being refused outright', async () => {
        const isolation = fakeIsolation('/storage/subagents/worktrees/child');
        const factory = createFactory(isolation);

        const handle = await factory.resume(spec(), transcriptPath, {
            agentId: 'child',
            signal: new AbortController().signal,
            isolationPath: '/storage/subagents/worktrees/child',
        });

        expect(isolation.prepare).toHaveBeenCalledWith(
            '/workspace',
            'child',
            expect.objectContaining({ isolation: 'worktree' }),
            { reattachWorktreePath: '/storage/subagents/worktrees/child' },
        );
        expect(handle.isolationPath).toBe('/storage/subagents/worktrees/child');
    });

    it('runs the resumed child inside that worktree and on its existing transcript', async () => {
        const isolation = fakeIsolation('/storage/subagents/worktrees/child');
        const factory = createFactory(isolation);

        await factory.resume(spec(), transcriptPath, {
            agentId: 'child',
            signal: new AbortController().signal,
            isolationPath: '/storage/subagents/worktrees/child',
        });

        expect(sdk.openedTranscripts).toEqual([transcriptPath]);
        expect(sdk.resourceLoaderOptions[0].cwd).toBe('/storage/subagents/worktrees/child');
        expect(sdk.createAgentSession.mock.calls[0][0].cwd).toBe('/storage/subagents/worktrees/child');
    });

    it('asks for a fresh worktree when the run has none recorded', async () => {
        const isolation = fakeIsolation('/storage/subagents/worktrees/child');
        const factory = createFactory(isolation);

        await factory.resume(spec(), transcriptPath, {
            agentId: 'child',
            signal: new AbortController().signal,
        });

        expect(isolation.prepare).toHaveBeenCalledWith(
            '/workspace',
            'child',
            expect.objectContaining({ isolation: 'worktree' }),
            {},
        );
    });

    it('still refuses a transcript outside the configured child storage', async () => {
        const factory = createFactory(fakeIsolation());

        await expect(factory.resume(spec(), path.join(root, 'outside.jsonl'), {
            agentId: 'child',
            signal: new AbortController().signal,
        })).rejects.toThrow('outside the configured child-session storage boundary');
    });
});

function fakeIsolation(isolationPath?: string) {
    return {
        hasWrites: vi.fn(() => true),
        prepare: vi.fn(async () => ({
            cwd: isolationPath ?? '/workspace',
            ...(isolationPath ? { isolationPath } : {}),
            release: async () => {},
        })),
    };
}

function createFactory(writeIsolation: unknown): PiChildSessionFactory {
    return new PiChildSessionFactory({
        cwd: '/workspace',
        workspaceTrusted: true,
        modelRuntime: {
            getModel: () => ({ provider: 'test', id: 'model' }),
            hasConfiguredAuth: () => true,
        } as any,
        transcriptDirectory,
        sessionLocks: DEFAULT_SESSION_RUNTIME_PORTS.sessionLocks,
        writeIsolation,
    } as any);
}

function spec(): ResolvedAgentSpec {
    const tools = ['read', 'edit', 'write'];
    return {
        name: 'implementer',
        source: 'invocation',
        task: 'Finish the remaining slice.',
        model: { provider: 'test', id: 'model' },
        modelSource: 'invocation',
        tools,
        toolTrace: { registered: tools, active: tools, childSafe: tools, denied: [], effective: tools },
        maxTurns: 20,
        timeoutMinutes: 5,
        background: false,
        contextMode: 'fresh',
        isolation: 'worktree',
        diagnostics: [],
    };
}
