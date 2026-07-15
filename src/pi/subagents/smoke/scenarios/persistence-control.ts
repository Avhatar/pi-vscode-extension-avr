import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SubagentCoordinator } from '../../coordinator';
import { projectSubagentLauncherSnapshot } from '../../launcher-state';
import { SubagentManager } from '../../manager';
import { SubagentRunStore } from '../../persistence';
import type {
    ChildSessionEvent, ChildSessionFactory, ChildSessionHandle, SubagentCompletion,
} from '../../runtime';
import type { AvailableModel, ResolvedAgentSpec, SubagentRun } from '../../types';
import type { SmokeScenario } from '../types';

export const persistenceControlScenario: SmokeScenario = {
    id: 'persistence-control',
    label: 'Phase 5: Persistence and control',
    description: 'Uses temporary storage to persist, reload, inspect, steer, stop, resume, dismiss, and clean retained child metadata without polluting History.',
    fixtureSeed: 'phase-5-persistence-control-v1',
    async run({ logger, showLauncherSnapshot }) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-persistence-smoke-'));
        const store = new SubagentRunStore(root);
        const parentSessionId = 'smoke-parent-session';
        const parentSessionPath = path.join(root, 'ordinary-history', 'parent.jsonl');
        const transcriptDirectory = await store.ensureTranscriptDirectory(parentSessionId);
        await fs.mkdir(path.dirname(parentSessionPath), { recursive: true });
        await fs.writeFile(parentSessionPath, '{"type":"session","id":"parent"}\n', 'utf8');
        const factory = new PersistentControlFactory(transcriptDirectory);
        const coordinator = new SubagentCoordinator(2);
        let manager: SubagentManager | undefined;
        let restoredManager: SubagentManager | undefined;
        try {
            await store.initialize();
            manager = createManager(coordinator, factory, store, parentSessionId, parentSessionPath, [], ['persistent-child']);
            const first = await manager.runForeground(spec('persistent-review', 'Initial persistent review.'));
            const firstRun = manager.getSnapshot().runs.find((run) => run.agentId === first.agentId)!;
            await manager.dispose();
            manager = undefined;

            const loaded = await store.loadParent(parentSessionId, 50_000);
            logger.event('persistence-reload', {
                records: loaded.length,
                agentIds: loaded.map((record) => record.agentId),
                transcript: loaded[0]?.run.transcriptPath,
            });
            logger.assert('persisted-agent-and-parent-relationship', loaded.length === 1 && loaded[0].agentId === first.agentId && loaded[0].parentSessionId === parentSessionId, true, loaded.map((record) => ({ agentId: record.agentId, parent: record.parentSessionId })));
            logger.assert('definition-and-model-snapshot-restored', loaded[0].definitionSnapshot.name === 'persistent-review' && loaded[0].run.model?.provider === 'deepseek', 'persistent-review on deepseek', { name: loaded[0].definitionSnapshot.name, model: loaded[0].run.model });

            const transcriptBeforeResume = await store.readTranscript(parentSessionId, first.agentId);
            logger.assert('transcript-inspection-available', Boolean(transcriptBeforeResume?.includes('Initial persistent review.')), true, Boolean(transcriptBeforeResume));
            logger.assert('child-transcript-outside-ordinary-history', Boolean(loaded[0].run.transcriptPath) && !loaded[0].run.transcriptPath!.startsWith(path.dirname(parentSessionPath)), true, loaded[0].run.transcriptPath);
            const ordinaryHistory = (await fs.readdir(path.dirname(parentSessionPath))).filter((name) => name.endsWith('.jsonl'));
            logger.assert('ordinary-history-has-no-child-session', ordinaryHistory.length === 1 && ordinaryHistory[0] === 'parent.jsonl', ['parent.jsonl'], ordinaryHistory);
            await fs.appendFile(parentSessionPath, '{"type":"compaction","summary":"parent only"}\n', 'utf8');
            logger.assert('parent-compaction-does-not-touch-child-transcript', await store.readTranscript(parentSessionId, first.agentId) === transcriptBeforeResume, true, true);

            restoredManager = createManager(
                coordinator, factory, store, parentSessionId, parentSessionPath, loaded, ['active-child'],
            );
            const resumed = await restoredManager.resumeForeground(first.agentId, 'Resume with a focused follow-up.');
            logger.assert('resume-reuses-persistent-agent-id', resumed.agentId === first.agentId, first.agentId, resumed.agentId);
            const resumedTranscript = await store.readTranscript(parentSessionId, first.agentId);
            logger.assert('resume-appends-to-existing-transcript', Boolean(resumedTranscript?.includes('Resume with a focused follow-up.')) && (resumedTranscript?.length ?? 0) > (transcriptBeforeResume?.length ?? 0), true, resumedTranscript?.length);

            const activePromise = restoredManager.runForeground(spec('active-control', 'Wait for steering and stop.'));
            await factory.waitForActive();
            const activeRun = restoredManager.getSnapshot().runs.find((run) => run.name === 'active-control')!;
            const steered = await restoredManager.steer(activeRun.agentId, 'Focus on the authentication boundary.');
            logger.assert('active-run-accepts-steering', steered, true, steered);
            logger.assert('active-run-stop-routes-by-agent-id', restoredManager.stop(activeRun.agentId), true, true);
            await activePromise.catch(() => undefined);
            const stoppedRun = restoredManager.getSnapshot().runs.find((run) => run.agentId === activeRun.agentId);
            logger.assert('stopped-run-becomes-cancelled', stoppedRun?.status === 'cancelled', 'cancelled', stoppedRun?.status);
            const controlledTranscript = await store.readTranscript(parentSessionId, activeRun.agentId);
            logger.assert('steering-is-written-to-child-transcript', Boolean(controlledTranscript?.includes('Focus on the authentication boundary.')), true, Boolean(controlledTranscript));

            let staleError = '';
            try { await restoredManager.resumeForeground('stale-agent-id', 'Should fail.'); }
            catch (error) { staleError = error instanceof Error ? error.message : String(error); }
            logger.assert('stale-agent-id-fails-explicitly', staleError.includes('Unknown or stale'), true, staleError);

            const dismissed = await restoredManager.dismiss(first.agentId);
            logger.assert('terminal-run-dismissed-from-launcher-state', dismissed && !restoredManager.getSnapshot().runs.some((run) => run.agentId === first.agentId), true, dismissed);
            const transcriptAfterDismiss = await store.readTranscript(parentSessionId, first.agentId);
            logger.assert('dismiss-keeps-transcript-for-retention-window', Boolean(transcriptAfterDismiss), true, Boolean(transcriptAfterDismiss));

            const staleRun: SubagentRun = {
                ...firstRun,
                agentId: 'retention-stale',
                transcriptPath: path.join(transcriptDirectory, 'retention-stale.jsonl'),
                finishedAt: 1_000,
            };
            await fs.writeFile(staleRun.transcriptPath!, 'stale transcript\n', 'utf8');
            await store.save(parentSessionId, parentSessionPath, staleRun, spec('stale', 'Old.'), 1_000);
            const cleanup = await store.cleanup(500, 2_000);
            logger.event('persistence-cleanup', { ...cleanup });
            logger.assert('retention-cleanup-removes-stale-record-and-transcript', cleanup.recordsRemoved === 1 && cleanup.transcriptsRemoved === 1, 'records=1 transcripts=1', cleanup);

            const detailTranscript = transcriptAfterDismiss!;
            const detailRun = {
                ...firstRun,
                status: 'completed' as const,
                activity: 'Persistent transcript ready for inspection',
                transcriptPath: loaded[0].run.transcriptPath,
            };
            const launcher = projectSubagentLauncherSnapshot({
                runs: [detailRun], activeCount: 0, queuedCount: 0,
            }, {
                enabled: true,
                toggleDisabled: false,
                now: detailRun.finishedAt ?? 50_000,
                smokeSimulation: true,
            });
            launcher.runs[0].canInspect = true;
            showLauncherSnapshot?.(launcher, { [first.agentId]: detailTranscript });
            logger.event('persistence-detail-injected', {
                installedHost: Boolean(showLauncherSnapshot),
                agentId: first.agentId,
                transcriptBytes: Buffer.byteLength(detailTranscript, 'utf8'),
                availableUntilReset: true,
            });
            logger.assert('manual-detail-snapshot-remains-until-reset', launcher.smokeSimulation === true && launcher.runs[0].canInspect, true, launcher.runs[0]);
            logger.step('persistence-control-ready-for-inspection', {
                result: 'PASS',
                instruction: showLauncherSnapshot
                    ? 'Click Inspect on the retained Subagents row, then Reset.'
                    : 'Unit host has no visual launcher.',
            });
        } finally {
            await restoredManager?.dispose();
            await manager?.dispose();
            coordinator.dispose();
            await fs.rm(root, { recursive: true, force: true });
            logger.step('persistence-control-fixture-cleanup', { root, result: 'PASS' });
        }
    },
};

function createManager(
    coordinator: SubagentCoordinator,
    factory: ChildSessionFactory,
    store: SubagentRunStore,
    parentSessionId: string,
    parentSessionPath: string,
    restoredRecords: Awaited<ReturnType<SubagentRunStore['loadParent']>>,
    agentIds: string[],
): SubagentManager {
    let index = 0;
    return new SubagentManager(coordinator, factory, {
        parentSessionId,
        restoredRecords,
        createAgentId: () => agentIds[index++] ?? `extra-${index}`,
        terminalRetentionMs: 60_000,
        persistRun: (run, definition) => store.save(parentSessionId, parentSessionPath, run, definition),
        dismissRun: async (agentId) => { await store.dismiss(parentSessionId, agentId); },
    });
}

class PersistentControlFactory implements ChildSessionFactory {
    private activeReadyResolve?: () => void;
    private activeReady = new Promise<void>((resolve) => { this.activeReadyResolve = resolve; });

    constructor(private readonly directory: string) {}

    async create(spec: ResolvedAgentSpec, context: { agentId: string; signal: AbortSignal }): Promise<ChildSessionHandle> {
        const transcriptPath = path.join(this.directory, `${context.agentId}.jsonl`);
        await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'session', id: context.agentId })}\n`, 'utf8');
        return new PersistentControlChild(
            spec,
            transcriptPath,
            context.signal,
            spec.name === 'active-control' ? () => this.activeReadyResolve?.() : undefined,
        );
    }

    async resume(spec: ResolvedAgentSpec, transcriptPath: string, context: { signal: AbortSignal }): Promise<ChildSessionHandle> {
        return new PersistentControlChild(spec, transcriptPath, context.signal);
    }

    waitForActive(): Promise<void> { return this.activeReady; }
}

class PersistentControlChild implements ChildSessionHandle {
    readonly sessionId: string;
    readonly model: AvailableModel;
    private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
    private completion?: SubagentCompletion;
    private releaseActive?: () => void;

    constructor(
        private readonly spec: ResolvedAgentSpec,
        readonly transcriptPath: string,
        private readonly signal: AbortSignal,
        private readonly onActive?: () => void,
    ) {
        this.sessionId = path.basename(transcriptPath, '.jsonl');
        this.model = spec.model;
    }

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(text: string): Promise<void> {
        await this.append({ type: 'message', message: { role: 'user', content: text } });
        if (this.spec.name === 'active-control') {
            this.onActive?.();
            await new Promise<void>((resolve) => {
                this.releaseActive = resolve;
                if (this.signal.aborted) resolve();
                else this.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return;
        }
        this.completion = { result: `Persistent result for: ${text}` };
        await this.append({ type: 'message', message: { role: 'assistant', content: this.completion.result } });
        this.emit({ type: 'completion', completion: { ...this.completion } });
        this.emit({ type: 'turn-ended', assistantText: this.completion.result });
    }

    async steer(text: string): Promise<void> {
        await this.append({ type: 'custom_message', customType: 'steer', content: text });
    }

    async abort(): Promise<void> { this.releaseActive?.(); }
    dispose(): void { this.listeners.clear(); }
    getCompletion(): SubagentCompletion | undefined { return this.completion ? { ...this.completion } : undefined; }
    getLastAssistantText(): string | undefined { return this.completion?.result; }

    private emit(event: ChildSessionEvent): void {
        for (const listener of this.listeners) listener(event);
    }

    private async append(value: unknown): Promise<void> {
        await fs.appendFile(this.transcriptPath, `${JSON.stringify(value)}\n`, 'utf8');
    }
}

function spec(name: string, task: string): ResolvedAgentSpec {
    return {
        name,
        source: 'invocation',
        task,
        model: { provider: 'deepseek', id: 'deepseek-reasoner' },
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
