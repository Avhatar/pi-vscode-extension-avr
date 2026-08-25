import { describe, expect, it } from 'vitest';
import { SubagentCoordinator } from '../../../../pi/subagents/coordinator';
import { SubagentManager } from '../../../../pi/subagents/manager';
import { describeSubagentResult } from '../../../../pi/subagents/runtime';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
    SubagentForegroundResult,
} from '../../../../pi/subagents/runtime';
import type { AvailableModel, ResolvedAgentSpec } from '../../../../pi/subagents/types';

class IsolatedFactory implements ChildSessionFactory {
    constructor(private readonly isolationPath?: string) {}

    async create(spec: ResolvedAgentSpec): Promise<ChildSessionHandle> {
        return new IsolatedChild(spec.model, this.isolationPath);
    }
}

class IsolatedChild implements ChildSessionHandle {
    readonly sessionId = 'handle-child';
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private completion?: SubagentCompletion;

    constructor(readonly model: AvailableModel, readonly isolationPath?: string) {}

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(): Promise<void> {
        this.completion = { result: 'Refactored the card renderer.' };
        for (const listener of [...this.listeners]) listener({ type: 'turn-ended' });
    }

    async steer(): Promise<void> {}
    async abort(): Promise<void> {}
    dispose(): void {}
    getCompletion(): SubagentCompletion | undefined { return this.completion; }
    getLastAssistantText(): string | undefined { return undefined; }
}

describe('parent-facing subagent handle', () => {
    it('names the agentId, model, and turn count after the child result', () => {
        const text = describeSubagentResult(result());

        expect(text.startsWith('Refactored the card renderer.')).toBe(true);
        expect(text).toContain('agentId=child-7');
        expect(text).toContain('model=deepseek/reasoner');
        expect(text).toContain('turns=4');
    });

    it('names the preserved worktree and the only sanctioned way to reach it', () => {
        const text = describeSubagentResult(result({ isolationPath: '/storage/subagents/worktrees/child-7' }));

        expect(text).toContain('/storage/subagents/worktrees/child-7');
        expect(text).toContain('none of its changes are in the workspace yet');
        expect(text).toContain('action="review"');
        expect(text).toContain('action="apply"');
        expect(text).toContain('action="cleanup"');
        expect(text).toContain('Never edit another agent\'s worktree directly');
    });

    it('does not invent a worktree for a shared-workspace child', () => {
        const text = describeSubagentResult(result());

        expect(text).not.toContain('worktree');
        expect(text).toContain('Use this agentId for inspect, resume, send, or dismiss.');
    });

    it('carries the preserved worktree path out on the foreground result', async () => {
        const coordinator = new SubagentCoordinator(1);
        const worktree = '/storage/subagents/worktrees/isolated-child';
        const manager = new SubagentManager(coordinator, new IsolatedFactory(worktree), {
            parentSessionId: 'parent',
            createAgentId: () => 'isolated-child',
        });

        const foreground = await manager.runForeground(spec());

        expect(foreground.isolationPath).toBe(worktree);
        expect(describeSubagentResult(foreground)).toContain(worktree);
        await manager.dispose();
        coordinator.dispose();
    });

    it('omits the worktree when the child shared the workspace', async () => {
        const coordinator = new SubagentCoordinator(1);
        const manager = new SubagentManager(coordinator, new IsolatedFactory(), {
            parentSessionId: 'parent',
            createAgentId: () => 'shared-child',
        });

        const foreground = await manager.runForeground(spec());

        expect(foreground.isolationPath).toBeUndefined();
        await manager.dispose();
        coordinator.dispose();
    });
});

function result(overrides: Partial<SubagentForegroundResult> = {}): SubagentForegroundResult {
    return {
        agentId: 'child-7',
        result: 'Refactored the card renderer.',
        model: { provider: 'deepseek', id: 'reasoner' },
        turnCount: 4,
        truncated: false,
        ...overrides,
    };
}

function spec(): ResolvedAgentSpec {
    return {
        name: 'handle',
        source: 'invocation',
        task: 'Refactor one renderer.',
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
        maxTurns: 2,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'worktree',
        diagnostics: [],
    };
}
