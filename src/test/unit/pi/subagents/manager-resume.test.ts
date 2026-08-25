import { describe, expect, it } from 'vitest';
import { SubagentCoordinator } from '../../../../pi/subagents/coordinator';
import { SubagentManager } from '../../../../pi/subagents/manager';
import type { PersistedSubagentRecord } from '../../../../pi/subagents/persistence';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
} from '../../../../pi/subagents/runtime';
import type { AvailableModel, ResolvedAgentSpec } from '../../../../pi/subagents/types';

interface ResumeCall {
    spec: ResolvedAgentSpec;
    transcriptPath: string;
    isolationPath?: string;
}

class ReusableFactory implements ChildSessionFactory {
    readonly resumeCalls: ResumeCall[] = [];
    /** Turns each child reports before it completes, in creation order. */
    constructor(private readonly worktree?: string, private readonly turns = 1) {}

    async create(spec: ResolvedAgentSpec, context: { agentId: string }): Promise<ChildSessionHandle> {
        return new ReusableChild(spec.model, `transcripts/${context.agentId}.jsonl`, this.worktree, this.turns);
    }

    async resume(
        spec: ResolvedAgentSpec,
        transcriptPath: string,
        context: { agentId: string; signal: AbortSignal; isolationPath?: string },
    ): Promise<ChildSessionHandle> {
        this.resumeCalls.push({
            spec,
            transcriptPath,
            ...(context.isolationPath ? { isolationPath: context.isolationPath } : {}),
        });
        return new ReusableChild(spec.model, transcriptPath, context.isolationPath, this.turns);
    }
}

class ReusableChild implements ChildSessionHandle {
    readonly sessionId = 'reusable-child';
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private completion?: SubagentCompletion;

    constructor(
        readonly model: AvailableModel,
        readonly transcriptPath: string,
        readonly isolationPath: string | undefined,
        private readonly turns: number,
    ) {}

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(): Promise<void> {
        for (let turn = 0; turn < this.turns; turn += 1) {
            for (const listener of [...this.listeners]) listener({ type: 'turn-ended' });
            await Promise.resolve();
        }
        this.completion = { result: 'Continued from where I stopped.' };
    }

    async steer(): Promise<void> {}
    async abort(): Promise<void> {}
    dispose(): void {}
    getCompletion(): SubagentCompletion | undefined { return this.completion; }
    getLastAssistantText(): string | undefined { return undefined; }
}

describe('resuming a child to reuse its accumulated context', () => {
    it('hands the recorded worktree to the runtime so it is reattached, not rebuilt', async () => {
        const worktree = '/storage/subagents/worktrees/reusable';
        const { manager, factory, coordinator } = createManager(worktree);

        const first = await manager.runForeground(spec());
        const resumed = await manager.resumeForeground(first.agentId, 'Finish the remaining half.');

        expect(factory.resumeCalls).toHaveLength(1);
        expect(factory.resumeCalls[0].isolationPath).toBe(worktree);
        expect(factory.resumeCalls[0].transcriptPath).toBe(`transcripts/${first.agentId}.jsonl`);
        expect(resumed.agentId).toBe(first.agentId);
        expect(resumed.isolationPath).toBe(worktree);
        await manager.dispose();
        coordinator.dispose();
    });

    it('reuses the original spec and changes only the task', async () => {
        const { manager, factory, coordinator } = createManager();

        const first = await manager.runForeground(spec({ maxTurns: 9, tools: ['read', 'edit'] }));
        await manager.resumeForeground(first.agentId, 'Finish the remaining half.');

        const resumedSpec = factory.resumeCalls[0].spec;
        expect(resumedSpec.task).toBe('Finish the remaining half.');
        expect(resumedSpec.maxTurns).toBe(9);
        expect(resumedSpec.tools).toEqual(['read', 'edit']);
        expect(resumedSpec.model).toEqual({ provider: 'deepseek', id: 'reasoner' });
        await manager.dispose();
        coordinator.dispose();
    });

    it('starts the turn budget over so a child that ran out can continue', async () => {
        const { manager, coordinator } = createManager(undefined, 2);

        const first = await manager.runForeground(spec({ maxTurns: 4 }));
        expect(first.turnCount).toBe(2);
        const resumed = await manager.resumeForeground(first.agentId, 'Keep going.');

        expect(resumed.turnCount).toBe(2);
        await manager.dispose();
        coordinator.dispose();
    });

    it('refuses to resume an id it no longer knows', async () => {
        const { manager, coordinator } = createManager();

        await expect(manager.resumeForeground('never-existed', 'Keep going.'))
            .rejects.toThrow('Unknown subagent id');
        await manager.dispose();
        coordinator.dispose();
    });

    it('resumes a child whose row the retention window already dropped', async () => {
        // A long sibling review outlives the ten-minute in-memory window; the
        // stored record is what makes the handle usable afterwards.
        const worktree = '/storage/subagents/worktrees/reusable';
        const store = new Map<string, PersistedSubagentRecord>();
        const { manager, factory, coordinator } = createManager(worktree, 1, store, 50);

        const first = await manager.runForeground(spec());
        await waitForEviction(manager, first.agentId);
        expect(manager.getSnapshot().runs).toHaveLength(0);

        const resumed = await manager.resumeForeground(first.agentId, 'Apply the review notes.');

        expect(resumed.agentId).toBe(first.agentId);
        expect(factory.resumeCalls).toHaveLength(1);
        // The preserved worktree survives eviction and must be reattached.
        expect(factory.resumeCalls[0].isolationPath).toBe(worktree);
        expect(factory.resumeCalls[0].transcriptPath).toBe(`transcripts/${first.agentId}.jsonl`);
        await manager.dispose();
        coordinator.dispose();
    });

    it('reports an evicted run through resolveRun without touching the store twice', async () => {
        const store = new Map<string, PersistedSubagentRecord>();
        let loads = 0;
        const { manager, coordinator } = createManager(undefined, 1, store, 50, () => { loads += 1; });

        const first = await manager.runForeground(spec());
        await waitForEviction(manager, first.agentId);

        expect(await manager.resolveRun(first.agentId)).toMatchObject({
            agentId: first.agentId, status: 'completed',
        });
        expect(await manager.resolveRun(first.agentId)).toMatchObject({ agentId: first.agentId });
        expect(loads).toBe(1);
        expect(manager.getSnapshot().runs).toHaveLength(1);
        await manager.dispose();
        coordinator.dispose();
    });

    it('leaves a dismissed record buried instead of resurrecting it', async () => {
        const store = new Map<string, PersistedSubagentRecord>();
        const { manager, coordinator } = createManager(undefined, 1, store, 50);

        const first = await manager.runForeground(spec());
        const record = store.get(first.agentId)!;
        store.set(first.agentId, { ...record, dismissed: true });
        await waitForEviction(manager, first.agentId);

        expect(await manager.resolveRun(first.agentId)).toBeUndefined();
        await expect(manager.resumeForeground(first.agentId, 'Keep going.'))
            .rejects.toThrow('Unknown subagent id');
        await manager.dispose();
        coordinator.dispose();
    });

    it('marks a stored run that still claims to be active as interrupted', async () => {
        const store = new Map<string, PersistedSubagentRecord>();
        const { manager, coordinator } = createManager(undefined, 1, store, 50);

        const first = await manager.runForeground(spec());
        const record = store.get(first.agentId)!;
        store.set(first.agentId, {
            ...record,
            run: { ...record.run, status: 'running', finishedAt: undefined },
        });
        await waitForEviction(manager, first.agentId);

        expect(await manager.resolveRun(first.agentId)).toMatchObject({
            status: 'failed', activity: 'Interrupted by extension restart',
        });
        await manager.dispose();
        coordinator.dispose();
    });
});

async function waitForEviction(manager: SubagentManager, agentId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!manager.getSnapshot().runs.some((run) => run.agentId === agentId)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Run ${agentId} was never evicted from memory.`);
}

function createManager(
    worktree?: string,
    turns = 1,
    store?: Map<string, PersistedSubagentRecord>,
    terminalRetentionMs?: number,
    onLoad?: () => void,
) {
    const coordinator = new SubagentCoordinator(1);
    const factory = new ReusableFactory(worktree, turns);
    let id = 0;
    const manager = new SubagentManager(coordinator, factory, {
        parentSessionId: 'parent',
        createAgentId: () => `reusable-${++id}`,
        ...(terminalRetentionMs !== undefined ? { terminalRetentionMs } : {}),
        ...(store ? {
            persistRun: async (run, definitionSnapshot) => {
                store.set(run.agentId, {
                    version: 1,
                    parentSessionId: 'parent',
                    agentId: run.agentId,
                    updatedAt: 0,
                    run: { ...run },
                    definitionSnapshot,
                });
            },
            loadRun: async (agentId) => {
                onLoad?.();
                return store.get(agentId);
            },
        } : {}),
    });
    return { manager, factory, coordinator };
}

function spec(overrides: Partial<ResolvedAgentSpec> = {}): ResolvedAgentSpec {
    const tools = overrides.tools ?? ['read', 'edit', 'write'];
    return {
        name: 'implementer',
        source: 'invocation',
        task: 'Implement the first half.',
        model: { provider: 'deepseek', id: 'reasoner' },
        modelSource: 'invocation',
        toolTrace: { registered: tools, active: tools, childSafe: tools, denied: [], effective: tools },
        maxTurns: 4,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'worktree',
        diagnostics: [],
        ...overrides,
        tools,
    };
}
