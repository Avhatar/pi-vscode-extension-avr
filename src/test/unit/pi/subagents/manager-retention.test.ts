import { describe, expect, it } from 'vitest';
import { SubagentCoordinator } from '../../../../pi/subagents/coordinator';
import { SubagentManager } from '../../../../pi/subagents/manager';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
} from '../../../../pi/subagents/runtime';
import type { AvailableModel, ResolvedAgentSpec } from '../../../../pi/subagents/types';

class CompletingFactory implements ChildSessionFactory {
    async create(spec: ResolvedAgentSpec): Promise<ChildSessionHandle> {
        return new CompletingChild(spec.model);
    }
}

class CompletingChild implements ChildSessionHandle {
    readonly sessionId = 'retention-child';
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private completion?: SubagentCompletion;
    constructor(readonly model: AvailableModel) {}
    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async prompt(): Promise<void> {
        this.completion = { result: 'done' };
        for (const listener of this.listeners) listener({ type: 'turn-ended' });
    }
    async steer(_text: string): Promise<void> {}
    async abort(): Promise<void> {}
    dispose(): void {}
    getCompletion(): SubagentCompletion | undefined { return this.completion; }
    getLastAssistantText(): string | undefined { return undefined; }
}

describe('subagent terminal row retention', () => {
    it('caps retained terminal runs and expires them after the retention window', async () => {
        const coordinator = new SubagentCoordinator(1);
        let now = 1_000;
        const manager = new SubagentManager(coordinator, new CompletingFactory(), {
            parentSessionId: 'parent',
            now: () => ++now,
            terminalRetentionMs: 10,
            maxRetainedTerminalRuns: 1,
            createAgentId: (() => {
                let id = 0;
                return () => `child-${++id}`;
            })(),
        });
        await manager.runForeground(spec('first'));
        await manager.runForeground(spec('second'));
        expect(manager.getSnapshot().runs).toHaveLength(1);
        expect(manager.getSnapshot().runs[0]).toMatchObject({
            name: 'second',
            task: 'Complete.',
            result: 'done',
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(manager.getSnapshot().runs).toHaveLength(0);
        await manager.dispose();
        coordinator.dispose();
    });
});

function spec(name: string): ResolvedAgentSpec {
    return {
        name,
        source: 'invocation',
        task: 'Complete.',
        model: { provider: 'deepseek', id: 'reasoner' },
        modelSource: 'invocation',
        tools: ['read'],
        toolTrace: {
            registered: ['read'], active: ['read'], childSafe: ['read'], denied: [], effective: ['read'],
        },
        maxTurns: 2,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };
}
