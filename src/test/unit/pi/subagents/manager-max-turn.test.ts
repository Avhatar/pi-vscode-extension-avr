import { describe, expect, it } from 'vitest';
import { SubagentCoordinator } from '../../../../pi/subagents/coordinator';
import { SubagentManager } from '../../../../pi/subagents/manager';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
} from '../../../../pi/subagents/runtime';
import type { AvailableModel, ResolvedAgentSpec } from '../../../../pi/subagents/types';

class BoundaryFactory implements ChildSessionFactory {
    constructor(private readonly hasToolCalls: boolean) {}

    async create(spec: ResolvedAgentSpec): Promise<ChildSessionHandle> {
        return new BoundaryChild(spec.model, this.hasToolCalls);
    }
}

class BoundaryChild implements ChildSessionHandle {
    readonly sessionId = 'boundary-child';
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private readonly finalText = 'Implemented the requested change and verified the final diff.';

    constructor(readonly model: AvailableModel, private readonly hasToolCalls: boolean) {}

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(): Promise<void> {
        for (const listener of this.listeners) {
            listener({
                type: 'turn-ended',
                assistantText: this.finalText,
                hasToolCalls: this.hasToolCalls,
            });
        }
    }

    async steer(_text: string): Promise<void> {}
    async abort(): Promise<void> {}
    dispose(): void {}
    getCompletion(): SubagentCompletion | undefined { return undefined; }
    getLastAssistantText(): string | undefined { return this.finalText; }
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
});

function spec(): ResolvedAgentSpec {
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
    };
}
