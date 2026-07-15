import { SubagentCoordinator } from '../../coordinator';
import { SubagentManager } from '../../manager';
import { projectSubagentLauncherSnapshot } from '../../launcher-state';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
    SubagentForegroundResult,
} from '../../runtime';
import type { AvailableModel, ResolvedAgentSpec, SubagentRun } from '../../types';
import type { SmokeScenario } from '../types';

export const backgroundConcurrencyScenario: SmokeScenario = {
    id: 'background-concurrency',
    label: 'Phase 6: Background concurrency',
    description: 'Uses deterministic workers and a fake clock to validate immediate IDs, fairness, global/per-chat limits, notifications, permission wait, stop, parent close, and shutdown cleanup.',
    fixtureSeed: 'phase-6-background-concurrency-v1',
    async run({ logger, showLauncherSnapshot }) {
        let clock = 0;
        const coordinator = new SubagentCoordinator(2);
        const factory = new ControlledBackgroundFactory();
        const notifications: Array<{ parent: string; run: SubagentRun; result?: SubagentForegroundResult; error?: Error }> = [];
        const managerA = manager('parent-a', ['a1', 'a2', 'a3'], coordinator, factory, () => clock, notifications);
        const managerB = manager('parent-b', ['b1', 'b2', 'b3'], coordinator, factory, () => clock, notifications);
        try {
            const a1 = managerA.runBackground(spec('a1'));
            const a2 = managerA.runBackground(spec('a2'));
            const b1 = managerB.runBackground(spec('b1-permission'));
            const b2 = managerB.runBackground(spec('b2'));
            logger.event('background-spawn-returned', {
                ids: [a1.agentId, a2.agentId, b1.agentId, b2.agentId],
                background: [a1.background, a2.background, b1.background, b2.background],
            });
            logger.assert('background-spawn-returns-persistent-ids-immediately', [a1.agentId, a2.agentId, b1.agentId, b2.agentId].join(',') === 'a1,a2,b1,b2', 'a1,a2,b1,b2', [a1.agentId, a2.agentId, b1.agentId, b2.agentId]);
            logger.assert('background-spawn-does-not-wait-for-completion', managerA.getSnapshot().activeCount === 2 && managerB.getSnapshot().activeCount === 2, 'two active/queued per parent', { a: managerA.getSnapshot().activeCount, b: managerB.getSnapshot().activeCount });

            await factory.waitForStarts(2);
            logger.event('background-concurrency-observed', {
                startOrder: factory.startOrder,
                liveGlobal: factory.liveGlobal,
                liveByParent: Object.fromEntries(factory.liveByParent),
            });
            logger.assert('global-concurrency-limit-enforced', factory.maxGlobal === 2, 2, factory.maxGlobal);
            logger.assert('per-parent-concurrency-limit-enforced', [...factory.maxByParent.values()].every((value) => value <= 1), '<=1', Object.fromEntries(factory.maxByParent));
            const visualManagerSnapshot = {
                runs: [...managerA.getSnapshot().runs, ...managerB.getSnapshot().runs],
                activeCount: managerA.getSnapshot().activeCount + managerB.getSnapshot().activeCount,
                queuedCount: managerA.getSnapshot().queuedCount + managerB.getSnapshot().queuedCount,
            };
            const permissionRun = managerB.getSnapshot().runs.find((run) => run.name === 'b1-permission');
            logger.assert('permission-wait-status-surfaced', permissionRun?.status === 'waiting_for_permission' && permissionRun.currentTool === 'read', 'waiting_for_permission/read', { status: permissionRun?.status, tool: permissionRun?.currentTool });
            const pinnedModels = visualManagerSnapshot.runs.map((run) => run.model && `${run.model.provider}/${run.model.id}`);
            logger.assert('auth-and-model-refresh-cannot-reroute-active-runs', pinnedModels.every((model) => model === 'deepseek/deepseek-reasoner'), 'all pinned to deepseek/deepseek-reasoner', pinnedModels);

            clock = 100;
            factory.release('a1');
            await factory.waitForStarts(3);
            clock = 200;
            factory.release('b1');
            await factory.waitForStarts(4);
            logger.assert('fair-cross-tab-start-order', factory.startOrder.join(',') === 'a1,b1,a2,b2', 'a1,b1,a2,b2', factory.startOrder);
            const queuedA2 = managerA.getSnapshot().runs.find((run) => run.name === 'a2');
            logger.assert('queue-wait-metric-recorded', (queuedA2?.queueWaitMs ?? 0) >= 100, '>=100ms', queuedA2?.queueWaitMs);

            logger.assert('stop-routes-to-background-child', managerB.stop('b2'), true, true);
            await waitFor(() => managerB.getSnapshot().runs.find((run) => run.agentId === 'b2')?.status === 'cancelled');
            factory.release('a2');
            await waitFor(() => notifications.filter((entry) => ['a1', 'a2', 'b1', 'b2'].includes(entry.run.agentId)).length === 4);
            logger.event('background-notifications', {
                notifications: notifications.map((entry) => ({ parent: entry.parent, id: entry.run.agentId, status: entry.run.status })),
            });
            logger.assert('completion-and-failure-notifications-delivered', notifications.some((entry) => entry.run.agentId === 'a1' && entry.result) && notifications.some((entry) => entry.run.agentId === 'b2' && entry.error), true, notifications.map((entry) => ({ id: entry.run.agentId, result: Boolean(entry.result), error: Boolean(entry.error) })));

            managerA.runBackground(spec('a3'));
            await factory.waitForStarts(5);
            await managerA.dispose();
            await waitFor(() => notifications.some((entry) => entry.run.agentId === 'a3'));
            logger.assert('parent-close-cancels-owned-background-runs', notifications.find((entry) => entry.run.agentId === 'a3')?.run.status === 'cancelled', 'cancelled', notifications.find((entry) => entry.run.agentId === 'a3')?.run.status);

            managerB.runBackground(spec('b3'));
            await factory.waitForStarts(6);
            coordinator.dispose();
            await waitFor(() => notifications.some((entry) => entry.run.agentId === 'b3'));
            logger.assert('extension-shutdown-cancels-active-background-runs', notifications.find((entry) => entry.run.agentId === 'b3')?.run.status === 'cancelled', 'cancelled', notifications.find((entry) => entry.run.agentId === 'b3')?.run.status);
            await managerB.dispose();
            logger.assert('shutdown-leaves-no-workers-or-queue-orphans', factory.liveGlobal === 0 && coordinator.active === 0 && coordinator.queued === 0, 'all zero', { live: factory.liveGlobal, active: coordinator.active, queued: coordinator.queued });
            logger.assert('child-depth-remains-one', spec('depth-check').tools.every((tool) => tool !== 'subagent'), true, spec('depth-check').tools);
            const launcher = projectSubagentLauncherSnapshot(visualManagerSnapshot, {
                enabled: true, toggleDisabled: false, now: clock, smokeSimulation: true,
            });
            showLauncherSnapshot?.(launcher);
            logger.assert('concurrent-launcher-snapshot-injected', launcher.runs.some((run) => run.status === 'queued') && launcher.runs.some((run) => run.status === 'waiting_for_permission'), 'queued and waiting_for_permission', launcher.runs.map((run) => run.status));
            logger.event('background-launcher-injected', {
                installedHost: Boolean(showLauncherSnapshot), rows: launcher.runs.length,
                statuses: launcher.runs.map((run) => run.status), availableUntilReset: true,
            });
            logger.step('background-concurrency-cleanup', {
                result: 'PASS',
                maxGlobal: factory.maxGlobal,
                maxByParent: Object.fromEntries(factory.maxByParent),
                queueOrder: factory.startOrder,
                orphanCount: factory.liveGlobal + coordinator.active + coordinator.queued,
            });
        } finally {
            await managerA.dispose();
            await managerB.dispose();
            coordinator.dispose();
        }
    },
};

function manager(
    parent: string,
    ids: string[],
    coordinator: SubagentCoordinator,
    factory: ControlledBackgroundFactory,
    now: () => number,
    notifications: Array<{ parent: string; run: SubagentRun; result?: SubagentForegroundResult; error?: Error }>,
): SubagentManager {
    let index = 0;
    return new SubagentManager(coordinator, factory, {
        parentSessionId: parent,
        parentTabId: parent,
        maxConcurrentRuns: 1,
        now,
        createAgentId: () => ids[index++] ?? `${parent}-extra-${index}`,
        onBackgroundSettled(run, result, error) {
            notifications.push({ parent, run, ...(result ? { result } : {}), ...(error ? { error } : {}) });
        },
    });
}

class ControlledBackgroundFactory implements ChildSessionFactory {
    readonly startOrder: string[] = [];
    readonly liveByParent = new Map<string, number>();
    readonly maxByParent = new Map<string, number>();
    liveGlobal = 0;
    maxGlobal = 0;
    private readonly children = new Map<string, ControlledBackgroundChild>();

    async create(spec: ResolvedAgentSpec, context: { agentId: string; signal: AbortSignal }): Promise<ChildSessionHandle> {
        const parent = context.agentId[0];
        const child = new ControlledBackgroundChild(spec, context.agentId, parent, context.signal, this);
        this.children.set(context.agentId, child);
        return child;
    }

    async resume(): Promise<ChildSessionHandle> { throw new Error('not used'); }
    release(name: string): void { this.children.get(name)?.release(); }
    async waitForStarts(count: number): Promise<void> { await waitFor(() => this.startOrder.length >= count); }

    started(name: string, parent: string): void {
        this.startOrder.push(name);
        this.liveGlobal += 1;
        const parentLive = (this.liveByParent.get(parent) ?? 0) + 1;
        this.liveByParent.set(parent, parentLive);
        this.maxGlobal = Math.max(this.maxGlobal, this.liveGlobal);
        this.maxByParent.set(parent, Math.max(this.maxByParent.get(parent) ?? 0, parentLive));
    }

    ended(parent: string): void {
        this.liveGlobal -= 1;
        this.liveByParent.set(parent, Math.max(0, (this.liveByParent.get(parent) ?? 1) - 1));
    }
}

class ControlledBackgroundChild implements ChildSessionHandle {
    readonly sessionId: string;
    readonly model: AvailableModel;
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private completion?: SubagentCompletion;
    private releaseResolve?: () => void;
    private ended = false;

    constructor(
        private readonly spec: ResolvedAgentSpec,
        sessionId: string,
        private readonly parent: string,
        private readonly signal: AbortSignal,
        private readonly owner: ControlledBackgroundFactory,
    ) {
        this.sessionId = sessionId;
        this.model = spec.model;
    }

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(): Promise<void> {
        this.owner.started(this.sessionId, this.parent);
        if (this.spec.name.includes('permission')) this.emit({ type: 'permission-wait', toolName: 'read' });
        try {
            await new Promise<void>((resolve) => {
                this.releaseResolve = resolve;
                if (this.signal.aborted) resolve();
                else this.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (this.signal.aborted) return;
            this.completion = { result: `Background result ${this.spec.name}` };
            this.emit({ type: 'completion', completion: { ...this.completion } });
            this.emit({ type: 'turn-ended', assistantText: this.completion.result });
        } finally {
            if (!this.ended) {
                this.ended = true;
                this.owner.ended(this.parent);
            }
        }
    }

    release(): void { this.releaseResolve?.(); }
    async steer(): Promise<void> {}
    async abort(): Promise<void> { this.release(); }
    dispose(): void { this.release(); this.listeners.clear(); }
    getCompletion(): SubagentCompletion | undefined { return this.completion; }
    getLastAssistantText(): string | undefined { return this.completion?.result; }
    private emit(event: ChildSessionEvent): void { for (const listener of this.listeners) listener(event); }
}

function spec(name: string): ResolvedAgentSpec {
    return {
        name, source: 'invocation', task: `Task ${name}`,
        model: { provider: 'deepseek', id: 'deepseek-reasoner' }, modelSource: 'invocation',
        tools: ['read'], toolTrace: {
            registered: ['read', 'subagent'], active: ['read', 'subagent'], childSafe: ['read'],
            denied: ['subagent'], effective: ['read'],
        },
        maxTurns: 3, timeoutMinutes: 1, background: true,
        contextMode: 'fresh', isolation: 'shared-workspace', diagnostics: [],
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for deterministic background worker state.');
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}
