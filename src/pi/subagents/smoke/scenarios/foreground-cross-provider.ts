import { SubagentCoordinator, abortError } from '../../coordinator';
import { SubagentManager } from '../../manager';
import type {
    ChildSessionEvent,
    ChildSessionFactory,
    ChildSessionHandle,
    SubagentCompletion,
} from '../../runtime';
import { SubagentRunError } from '../../runtime';
import type { AvailableModel, ResolvedAgentSpec, SubagentRunStatus } from '../../types';
import type { SmokeScenario } from '../types';

export const foregroundCrossProviderScenario: SmokeScenario = {
    id: 'foreground-cross-provider',
    label: 'Phase 2: Foreground cross-provider runtime',
    description: 'Simulates isolated child lifecycle, structured completion, recovery, timeout, abort, limits, and exact model failure.',
    fixtureSeed: 'phase-2-foreground-v1',
    async run({ logger }) {
        const coordinator = new SubagentCoordinator(1);
        const factory = new ScriptedChildFactory();
        let nextId = 1;
        const manager = new SubagentManager(coordinator, factory, {
            parentSessionId: 'smoke-parent-session',
            parentTabId: 'smoke-tab',
            resultByteLimit: 96,
            createAgentId: () => `smoke-agent-${nextId++}`,
            log: (message) => logger.event('manager-log', { message }),
        });
        const transitions = new Map<string, SubagentRunStatus[]>();
        const unsubscribe = manager.onDidChange((snapshot) => {
            for (const run of snapshot.runs) {
                const states = transitions.get(run.agentId) ?? [];
                if (states.at(-1) !== run.status) states.push(run.status);
                transitions.set(run.agentId, states);
            }
            logger.event('runtime-snapshot', {
                runs: snapshot.runs.map((run) => ({
                    agentId: run.agentId,
                    status: run.status,
                    model: run.model ? `${run.model.provider}/${run.model.id}` : undefined,
                    tool: run.currentTool,
                    turns: run.turnCount,
                })),
                activeCount: snapshot.activeCount,
                queuedCount: snapshot.queuedCount,
            });
        });

        try {
            logger.step('foreground-success-start', {
                parentModel: 'openai/gpt-parent',
                childModel: 'deepseek/deepseek-reasoner',
            });
            const success = await manager.runForeground(spec('success', 'deepseek', 'deepseek-reasoner'));
            logger.assert('cross-provider-child-model', modelKey(success.model) === 'deepseek/deepseek-reasoner', 'deepseek/deepseek-reasoner', modelKey(success.model));
            logger.assert('structured-completion-returned', success.result.includes('Authentication analysis complete'), true, success.result.includes('Authentication analysis complete'));
            logger.assert('tool-activity-and-completion-lifecycle', sameStates(transitions.get(success.agentId), ['queued', 'starting', 'running', 'completed']), ['queued', 'starting', 'running', 'completed'], transitions.get(success.agentId));
            logger.assert('child-session-disposed', factory.disposed.has(success.agentId), true, factory.disposed.has(success.agentId));

            const recovery = await manager.runForeground(spec('recovery', 'anthropic', 'claude-review'));
            logger.assert('incomplete-first-response-recovers-once', factory.promptCounts.get(recovery.agentId) === 2, 2, factory.promptCounts.get(recovery.agentId));
            logger.assert('recovery-completion-returned', recovery.result === 'Recovered structured result.', 'Recovered structured result.', recovery.result);

            const truncated = await manager.runForeground(spec('truncated', 'deepseek', 'deepseek-reasoner'));
            logger.assert('result-byte-cap-applied', truncated.truncated && Buffer.byteLength(truncated.result, 'utf8') <= 96, true, { truncated: truncated.truncated, bytes: Buffer.byteLength(truncated.result, 'utf8') });

            const unavailable = await captureFailure(() => manager.runForeground(spec('unavailable', 'missing', 'model')));
            logger.event('runtime-failure', { case: 'unavailable', reason: unavailable?.reason, message: unavailable?.message });
            logger.assert('exact-unavailable-model-no-fallback', unavailable?.reason === 'runtime-error' && unavailable.message.includes('no fallback'), true, unavailable?.message);

            const timeoutSpec = spec('timeout', 'deepseek', 'deepseek-reasoner');
            timeoutSpec.timeoutMinutes = 0.0001;
            const timeout = await captureFailure(() => manager.runForeground(timeoutSpec));
            logger.event('runtime-failure', { case: 'timeout', reason: timeout?.reason, message: timeout?.message });
            logger.assert('timeout-aborts-child', timeout?.reason === 'timeout', 'timeout', timeout?.reason);

            const abortController = new AbortController();
            const cancelledPromise = manager.runForeground(spec('cancel', 'deepseek', 'deepseek-reasoner'), abortController.signal);
            setTimeout(() => abortController.abort(), 1);
            const cancelled = await captureFailure(() => cancelledPromise);
            logger.event('runtime-failure', { case: 'cancel', reason: cancelled?.reason, message: cancelled?.message });
            logger.assert('external-abort-cancels-child', cancelled?.reason === 'cancelled', 'cancelled', cancelled?.reason);

            const maxTurnsSpec = spec('max-turns', 'deepseek', 'deepseek-reasoner');
            maxTurnsSpec.maxTurns = 1;
            const maxTurns = await captureFailure(() => manager.runForeground(maxTurnsSpec));
            logger.event('runtime-failure', { case: 'max-turns', reason: maxTurns?.reason, message: maxTurns?.message });
            logger.assert('max-turn-limit-aborts-child', maxTurns?.reason === 'max-turns', 'max-turns', maxTurns?.reason);

            const incomplete = await captureFailure(() => manager.runForeground(spec('incomplete', 'deepseek', 'deepseek-reasoner')));
            logger.event('runtime-failure', { case: 'incomplete', reason: incomplete?.reason, partial: Boolean(incomplete?.partialResult) });
            const incompletePromptCount = incomplete ? factory.promptCounts.get(incomplete.agentId) : undefined;
            logger.assert('missing-completion-fails-after-recovery', incomplete?.reason === 'incomplete' && incompletePromptCount === 2, { reason: 'incomplete', promptCount: 2 }, { reason: incomplete?.reason, promptCount: incompletePromptCount });

            const snapshot = manager.getSnapshot();
            logger.assert('all-runs-terminal-after-scenario', snapshot.activeCount === 0 && snapshot.queuedCount === 0, { activeCount: 0, queuedCount: 0 }, { activeCount: snapshot.activeCount, queuedCount: snapshot.queuedCount });
        } finally {
            unsubscribe();
            await manager.dispose();
            coordinator.dispose();
            logger.step('foreground-runtime-cleanup', { result: 'PASS', liveSessions: factory.liveSessions });
            logger.assert('no-child-session-leaks', factory.liveSessions === 0, 0, factory.liveSessions);
        }
    },
};

class ScriptedChildFactory implements ChildSessionFactory {
    readonly disposed = new Set<string>();
    readonly promptCounts = new Map<string, number>();
    liveSessions = 0;

    async create(spec: ResolvedAgentSpec, context: { agentId: string; signal: AbortSignal }): Promise<ChildSessionHandle> {
        if (spec.model.provider === 'missing') {
            throw new Error(`Subagent model missing/model is unavailable; no fallback was applied.`);
        }
        this.liveSessions += 1;
        return new ScriptedChildSession(spec, context, this);
    }
}

class ScriptedChildSession implements ChildSessionHandle {
    readonly sessionId: string;
    readonly model: AvailableModel;
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private completion: SubagentCompletion | undefined;
    private lastAssistantText: string | undefined;
    private disposed = false;

    constructor(
        private readonly spec: ResolvedAgentSpec,
        private readonly context: { agentId: string; signal: AbortSignal },
        private readonly owner: ScriptedChildFactory,
    ) {
        this.sessionId = `child-${context.agentId}`;
        this.model = { ...spec.model };
    }

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(text: string): Promise<void> {
        const count = (this.owner.promptCounts.get(this.context.agentId) ?? 0) + 1;
        this.owner.promptCounts.set(this.context.agentId, count);
        if (this.spec.name === 'timeout' || this.spec.name === 'cancel') {
            await waitForAbort(this.context.signal);
            throw abortError('Scripted child aborted.');
        }
        if (this.spec.name === 'max-turns') {
            this.lastAssistantText = 'Still investigating.';
            this.emit({ type: 'turn-ended', assistantText: this.lastAssistantText });
            await waitForAbort(this.context.signal);
            throw abortError('Scripted max-turn child aborted.');
        }
        if (this.spec.name === 'incomplete') {
            this.lastAssistantText = count === 1 ? 'Unstructured first answer.' : 'Unstructured recovery answer.';
            this.emit({ type: 'turn-ended', assistantText: this.lastAssistantText });
            return;
        }
        if (this.spec.name === 'recovery' && count === 1) {
            this.lastAssistantText = 'I forgot the completion tool.';
            this.emit({ type: 'turn-ended', assistantText: this.lastAssistantText });
            return;
        }

        this.emit({ type: 'tool-started', toolName: 'read', toolCallId: `read-${count}` });
        this.emit({ type: 'tool-ended', toolName: 'read', toolCallId: `read-${count}`, isError: false });
        const result = this.spec.name === 'recovery'
            ? 'Recovered structured result.'
            : this.spec.name === 'truncated'
                ? '😀'.repeat(100)
                : 'Authentication analysis complete with workspace evidence.';
        this.completion = { result, summary: 'Smoke completion' };
        this.emit({ type: 'completion', completion: { ...this.completion } });
        this.emit({ type: 'turn-ended', assistantText: undefined });
    }

    async steer(_text: string): Promise<void> {
        // Deterministic fixture accepts steering without provider activity.
    }

    async abort(): Promise<void> {
        // The manager-owned signal drives scripted cancellation.
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.listeners.clear();
        this.owner.disposed.add(this.context.agentId);
        this.owner.liveSessions -= 1;
    }

    getCompletion(): SubagentCompletion | undefined {
        return this.completion ? { ...this.completion } : undefined;
    }

    getLastAssistantText(): string | undefined {
        return this.lastAssistantText;
    }

    private emit(event: ChildSessionEvent): void {
        for (const listener of this.listeners) listener(event);
    }
}

function spec(name: string, provider: string, id: string): ResolvedAgentSpec {
    return {
        name,
        description: `${name} smoke agent`,
        source: 'invocation',
        task: 'Inspect the authentication flow and return evidence.',
        instructions: 'Read only. Return a structured result.',
        model: { provider, id, name: `${provider}/${id}` },
        modelSource: 'invocation',
        tools: ['read'],
        toolTrace: {
            registered: ['read', 'complete_subagent'],
            active: ['read', 'complete_subagent'],
            childSafe: ['read'],
            denied: ['subagent'],
            effective: ['read'],
        },
        maxTurns: 4,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };
}

async function captureFailure(operation: () => Promise<unknown>): Promise<SubagentRunError | undefined> {
    try {
        await operation();
        return undefined;
    } catch (error) {
        return error instanceof SubagentRunError ? error : undefined;
    }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function modelKey(model: AvailableModel): string {
    return `${model.provider}/${model.id}`;
}

function sameStates(actual: SubagentRunStatus[] | undefined, expected: SubagentRunStatus[]): boolean {
    return actual?.length === expected.length && actual.every((value, index) => value === expected[index]);
}
