import { describe, expect, it } from 'vitest';
import { SubagentCoordinator } from '../../../../pi/subagents/coordinator';
import { SubagentManager } from '../../../../pi/subagents/manager';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
} from '../../../../pi/subagents/runtime';
import type { AvailableModel, ResolvedAgentSpec } from '../../../../pi/subagents/types';

class BoundaryFactory implements ChildSessionFactory {
    child: BoundaryChild | undefined;

    constructor(private readonly hasToolCalls: boolean, private readonly turns = 1) {}

    async create(spec: ResolvedAgentSpec): Promise<ChildSessionHandle> {
        this.child = new BoundaryChild(spec.model, this.hasToolCalls, this.turns);
        return this.child;
    }
}

class BoundaryChild implements ChildSessionHandle {
    readonly sessionId = 'boundary-child';
    readonly steered: string[] = [];
    /** Set by a test to have the child complete as soon as it is steered. */
    completeOnSteer = false;
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private readonly finalText = 'Implemented the requested change and verified the final diff.';
    private completion: SubagentCompletion | undefined;

    constructor(
        readonly model: AvailableModel,
        private readonly hasToolCalls: boolean,
        private readonly turns: number,
    ) {}

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(): Promise<void> {
        for (let turn = 0; turn < this.turns; turn += 1) {
            for (const listener of [...this.listeners]) {
                listener({
                    type: 'turn-ended',
                    assistantText: this.finalText,
                    hasToolCalls: this.hasToolCalls,
                });
            }
            // The manager steers asynchronously from inside the listener; give
            // that microtask a chance to land before the next turn, the way a
            // real provider round-trip would.
            await Promise.resolve();
        }
    }

    async steer(text: string): Promise<void> {
        this.steered.push(text);
        if (this.completeOnSteer) this.completion = { result: 'Finalized after the wind-down warning.' };
    }

    async abort(): Promise<void> {}
    dispose(): void {}
    getCompletion(): SubagentCompletion | undefined { return this.completion; }
    getLastAssistantText(): string | undefined { return this.finalText; }
}

/** A child that finishes and is stopped in the same tick — the delivered result
 *  must survive the abort rather than being discarded as a cancellation. */
class RacingFactory implements ChildSessionFactory {
    constructor(private readonly external: AbortController) {}

    async create(spec: ResolvedAgentSpec): Promise<ChildSessionHandle> {
        return new RacingChild(spec.model, this.external);
    }
}

class RacingChild implements ChildSessionHandle {
    readonly sessionId = 'racing-child';
    private completion: SubagentCompletion | undefined;

    constructor(readonly model: AvailableModel, private readonly external: AbortController) {}

    subscribe(): () => void { return () => {}; }

    async prompt(): Promise<void> {
        this.completion = { result: 'Delivered just before the stop request.' };
        this.external.abort();
    }

    async steer(): Promise<void> {}
    async abort(): Promise<void> {}
    dispose(): void {}
    getCompletion(): SubagentCompletion | undefined { return this.completion; }
    getLastAssistantText(): string | undefined { return undefined; }
}

describe('subagent max-turn completion boundary', () => {
    it('preserves a naturally returned final text response on the last allowed turn', async () => {
        const coordinator = new SubagentCoordinator(1);
        const manager = new SubagentManager(coordinator, new BoundaryFactory(false), {
            parentSessionId: 'parent',
            createAgentId: () => 'plain-final-child',
        });

        const result = await manager.runForeground(spec());

        expect(result).toMatchObject({
            result: 'Implemented the requested change and verified the final diff.',
            turnCount: 1,
        });
        expect(manager.getSnapshot().runs[0]).toMatchObject({
            status: 'completed',
            activity: 'Completed (final text recovered)',
        });
        await manager.dispose();
        coordinator.dispose();
    });

    it('still aborts when the last allowed turn requests another tool', async () => {
        const coordinator = new SubagentCoordinator(1);
        const manager = new SubagentManager(coordinator, new BoundaryFactory(true), {
            parentSessionId: 'parent',
            createAgentId: () => 'tool-loop-child',
        });

        await expect(manager.runForeground(spec())).rejects.toMatchObject({ reason: 'max-turns' });
        await manager.dispose();
        coordinator.dispose();
    });

    it('carries the child last message on the failure so the parent can salvage it', async () => {
        const coordinator = new SubagentCoordinator(1);
        const manager = new SubagentManager(coordinator, new BoundaryFactory(true), {
            parentSessionId: 'parent',
            createAgentId: () => 'salvage-child',
        });

        await expect(manager.runForeground(spec())).rejects.toMatchObject({
            reason: 'max-turns',
            partialResult: 'Implemented the requested change and verified the final diff.',
        });
        await manager.dispose();
        coordinator.dispose();
    });

    it('asks the child to finalize one turn before the budget is spent', async () => {
        const coordinator = new SubagentCoordinator(1);
        const factory = new BoundaryFactory(true, 3);
        const manager = new SubagentManager(coordinator, factory, {
            parentSessionId: 'parent',
            createAgentId: () => 'wind-down-child',
        });

        await expect(manager.runForeground(spec({ maxTurns: 3 }))).rejects.toMatchObject({ reason: 'max-turns' });

        expect(factory.child?.steered).toHaveLength(1);
        expect(factory.child?.steered[0]).toContain('You have one turn left of your 3-turn budget');
        await manager.dispose();
        coordinator.dispose();
    });

    it('keeps a delivered result when the abort lands in the same tick', async () => {
        const coordinator = new SubagentCoordinator(1);
        const external = new AbortController();
        const manager = new SubagentManager(coordinator, new RacingFactory(external), {
            parentSessionId: 'parent',
            createAgentId: () => 'racing-child',
        });

        const result = await manager.runForeground(spec(), external.signal);

        expect(result.result).toBe('Delivered just before the stop request.');
        expect(manager.getSnapshot().runs[0]).toMatchObject({ status: 'completed' });
        await manager.dispose();
        coordinator.dispose();
    });

    it('keeps a result the child delivered after the wind-down warning', async () => {
        const coordinator = new SubagentCoordinator(1);
        const factory = new BoundaryFactory(true, 3);
        const manager = new SubagentManager(coordinator, factory, {
            parentSessionId: 'parent',
            createAgentId: () => 'wind-down-completed-child',
            now: () => 1,
        });
        const originalCreate = factory.create.bind(factory);
        factory.create = async (createSpec) => {
            const child = await originalCreate(createSpec) as BoundaryChild;
            child.completeOnSteer = true;
            return child;
        };

        const result = await manager.runForeground(spec({ maxTurns: 3 }));

        expect(result.result).toBe('Finalized after the wind-down warning.');
        expect(manager.getSnapshot().runs[0]).toMatchObject({ status: 'completed' });
        await manager.dispose();
        coordinator.dispose();
    });
});

function spec(overrides: Partial<ResolvedAgentSpec> = {}): ResolvedAgentSpec {
    return {
        name: 'boundary',
        source: 'invocation',
        task: 'Make one focused change.',
        model: { provider: 'deepseek', id: 'reasoner' },
        modelSource: 'invocation',
        tools: ['read', 'edit'],
        toolTrace: {
            registered: ['read', 'edit'],
            active: ['read', 'edit'],
            childSafe: ['read', 'edit'],
            denied: [],
            effective: ['read', 'edit'],
        },
        maxTurns: 1,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
        ...overrides,
    };
}
