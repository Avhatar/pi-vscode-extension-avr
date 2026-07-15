import { randomUUID } from 'node:crypto';
import { SubagentCoordinator } from './coordinator';
import type {
    ChildSessionFactory,
    ChildSessionHandle,
    SubagentCompletion,
    SubagentForegroundResult,
    SubagentManagerSnapshot,
    SubagentTerminationReason,
} from './runtime';
import { SubagentRunError } from './runtime';
import type { ResolvedAgentSpec, SubagentRun, SubagentRunStatus } from './types';
import type { PersistedSubagentRecord } from './persistence';

interface ActiveRun {
    controller: AbortController;
    child?: ChildSessionHandle;
    reason?: SubagentTerminationReason;
}

export interface SubagentManagerOptions {
    parentSessionId: string;
    parentTabId?: string;
    resultByteLimit?: number;
    now?: () => number;
    createAgentId?: () => string;
    log?: (message: string) => void;
    /** How long terminal rows remain available to launcher subscribers. */
    terminalRetentionMs?: number;
    /** Hard cap for retained terminal rows, independent of retention time. */
    maxRetainedTerminalRuns?: number;
    restoredRecords?: readonly PersistedSubagentRecord[];
    persistRun?: (run: SubagentRun, spec: ResolvedAgentSpec) => Promise<void>;
    dismissRun?: (agentId: string) => Promise<void>;
    maxConcurrentRuns?: number;
    onMutationEvent?: (event: {
        type: 'tool_execution_start' | 'tool_execution_end';
        agentId: string;
        toolCallId: string;
        toolName: string;
        args?: unknown;
        isError?: boolean;
        isolationPath?: string;
    }) => void;
    onBackgroundSettled?: (
        run: SubagentRun,
        result: SubagentForegroundResult | undefined,
        error: Error | undefined,
    ) => Promise<void> | void;
}

export class SubagentManager {
    private readonly runs = new Map<string, SubagentRun>();
    private readonly activeRuns = new Map<string, ActiveRun>();
    private readonly runSpecs = new Map<string, ResolvedAgentSpec>();
    private readonly listeners = new Set<(snapshot: SubagentManagerSnapshot) => void>();
    private readonly runObservers = new Map<string, (run: SubagentRun) => void>();
    private readonly inFlight = new Set<Promise<void>>();
    private readonly now: () => number;
    private readonly createAgentId: () => string;
    private readonly resultByteLimit: number;
    private readonly terminalRetentionMs: number;
    private readonly maxRetainedTerminalRuns: number;
    private readonly terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly maxConcurrentRuns: number;
    private parentActive = 0;
    private readonly parentQueue: Array<{
        signal: AbortSignal;
        run: () => Promise<SubagentForegroundResult>;
        resolve: (value: SubagentForegroundResult) => void;
        reject: (error: unknown) => void;
        onAbort: () => void;
    }> = [];
    private parentTabId: string;
    private persistenceTail: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(
        private readonly coordinator: SubagentCoordinator,
        private readonly factory: ChildSessionFactory,
        private readonly options: SubagentManagerOptions,
    ) {
        this.now = options.now ?? Date.now;
        this.createAgentId = options.createAgentId ?? randomUUID;
        this.resultByteLimit = options.resultByteLimit ?? 50 * 1024;
        this.terminalRetentionMs = options.terminalRetentionMs ?? 10 * 60_000;
        this.maxRetainedTerminalRuns = options.maxRetainedTerminalRuns ?? 20;
        this.maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
        this.parentTabId = options.parentTabId ?? 'unbound';
        if (!Number.isInteger(this.resultByteLimit) || this.resultByteLimit < 1) {
            throw new Error('Subagent resultByteLimit must be a positive integer.');
        }
        if (!Number.isFinite(this.terminalRetentionMs) || this.terminalRetentionMs < 0) {
            throw new Error('Subagent terminalRetentionMs must be a non-negative number.');
        }
        if (!Number.isInteger(this.maxRetainedTerminalRuns) || this.maxRetainedTerminalRuns < 0) {
            throw new Error('Subagent maxRetainedTerminalRuns must be a non-negative integer.');
        }
        if (!Number.isInteger(this.maxConcurrentRuns) || this.maxConcurrentRuns < 1) {
            throw new Error('Subagent maxConcurrentRuns must be a positive integer.');
        }
        for (const record of options.restoredRecords ?? []) {
            const run = cloneRun(record.run);
            run.parentTabId = this.parentTabId;
            this.runs.set(run.agentId, run);
            this.runSpecs.set(run.agentId, cloneSpec(record.definitionSnapshot));
            if (!isActiveStatus(run.status)) this.retainTerminalRun(run);
        }
    }

    setParentTabId(tabId: string): void {
        this.parentTabId = tabId;
        for (const run of this.runs.values()) run.parentTabId = tabId;
        this.emitSnapshot();
    }

    onDidChange(listener: (snapshot: SubagentManagerSnapshot) => void): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    getSnapshot(): SubagentManagerSnapshot {
        const runs = [...this.runs.values()]
            .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
            .map(cloneRun);
        return {
            runs,
            activeCount: runs.filter((run) => isActiveStatus(run.status)).length,
            queuedCount: runs.filter((run) => run.status === 'queued').length,
        };
    }

    async runForeground(
        spec: ResolvedAgentSpec,
        externalSignal?: AbortSignal,
        onRunChange?: (run: SubagentRun) => void,
    ): Promise<SubagentForegroundResult> {
        if (this.disposed) throw new Error('Subagent manager is disposed.');
        const agentId = this.createAgentId();
        const run: SubagentRun = {
            agentId,
            parentSessionId: this.options.parentSessionId,
            parentTabId: this.parentTabId,
            name: spec.name,
            source: spec.source,
            taskPreview: preview(spec.task, 200),
            status: 'queued',
            queuedAt: this.now(),
            model: { ...spec.model },
            turnCount: 0,
        };
        this.runs.set(agentId, run);
        this.runSpecs.set(agentId, cloneSpec(spec));
        this.persist(run, spec);
        this.log(`[subagent queued] agentId=${agentId} name=${spec.name} model=${spec.model.provider}/${spec.model.id}`);
        return this.launchRun(run, spec, false, externalSignal, onRunChange);
    }

    runBackground(spec: ResolvedAgentSpec): { agentId: string; model: ResolvedAgentSpec['model']; background: true } {
        if (this.disposed) throw new Error('Subagent manager is disposed.');
        const agentId = this.createAgentId();
        const run: SubagentRun = {
            agentId,
            parentSessionId: this.options.parentSessionId,
            parentTabId: this.parentTabId,
            name: spec.name,
            source: spec.source,
            taskPreview: preview(spec.task, 200),
            status: 'queued',
            queuedAt: this.now(),
            model: { ...spec.model },
            turnCount: 0,
        };
        this.runs.set(agentId, run);
        this.runSpecs.set(agentId, cloneSpec(spec));
        this.persist(run, spec);
        this.log(`[subagent background queued] agentId=${agentId} name=${spec.name} model=${spec.model.provider}/${spec.model.id}`);
        void this.launchRun(run, spec, false).then(
            async (result) => {
                await this.options.onBackgroundSettled?.(cloneRun(run), result, undefined);
            },
            async (error) => {
                const failure = error instanceof Error ? error : new Error(String(error));
                await this.options.onBackgroundSettled?.(cloneRun(run), undefined, failure);
            },
        ).catch((error) => this.log(`[subagent background notification error] agentId=${agentId} error=${String(error)}`));
        return { agentId, model: { ...spec.model }, background: true };
    }

    async resumeForeground(
        agentId: string,
        task: string,
        externalSignal?: AbortSignal,
        onRunChange?: (run: SubagentRun) => void,
    ): Promise<SubagentForegroundResult> {
        if (this.disposed) throw new Error('Subagent manager is disposed.');
        const run = this.runs.get(agentId);
        const previousSpec = this.runSpecs.get(agentId);
        if (!run || !previousSpec) throw new Error(`Unknown or stale subagent id: ${agentId}.`);
        if (this.activeRuns.has(agentId)) throw new Error(`Subagent ${agentId} is already running.`);
        if (!run.transcriptPath) throw new Error(`Subagent ${agentId} has no persistent transcript to resume.`);
        if (!this.factory.resume) throw new Error('The configured child runtime does not support resume.');
        const spec = { ...cloneSpec(previousSpec), task };
        Object.assign(run, {
            taskPreview: preview(task, 200),
            status: 'queued' as const,
            currentTool: undefined,
            activity: 'Queued for resume',
            queuedAt: this.now(),
            queueWaitMs: undefined,
            startedAt: undefined,
            finishedAt: undefined,
            error: undefined,
            resultPreview: undefined,
            turnCount: 0,
        });
        const terminalTimer = this.terminalTimers.get(agentId);
        if (terminalTimer) clearTimeout(terminalTimer);
        this.terminalTimers.delete(agentId);
        this.runSpecs.set(agentId, spec);
        this.persist(run, spec);
        this.log(`[subagent resume queued] agentId=${agentId} model=${spec.model.provider}/${spec.model.id}`);
        return this.launchRun(run, spec, true, externalSignal, onRunChange);
    }

    async steer(agentId: string, message: string): Promise<boolean> {
        const active = this.activeRuns.get(agentId);
        if (!active?.child || !message.trim()) return false;
        await active.child.steer(message.trim());
        const run = this.runs.get(agentId);
        if (run) this.updateRun(run, { activity: 'Parent sent steering guidance' });
        return true;
    }

    clearIsolationPath(agentId: string): boolean {
        const run = this.runs.get(agentId);
        if (!run?.isolationPath) return false;
        this.updateRun(run, { isolationPath: undefined });
        return true;
    }

    async dismiss(agentId: string): Promise<boolean> {
        const run = this.runs.get(agentId);
        if (!run || isActiveStatus(run.status)) return false;
        this.runs.delete(agentId);
        this.runSpecs.delete(agentId);
        const timer = this.terminalTimers.get(agentId);
        if (timer) clearTimeout(timer);
        this.terminalTimers.delete(agentId);
        if (this.options.dismissRun) {
            this.persistenceTail = this.persistenceTail
                .then(() => this.options.dismissRun!(agentId))
                .catch((error) => this.log(`[subagent persistence error] dismiss agentId=${agentId} error=${String(error)}`));
        }
        this.emitSnapshot();
        return true;
    }

    private async launchRun(
        run: SubagentRun,
        spec: ResolvedAgentSpec,
        resume: boolean,
        externalSignal?: AbortSignal,
        onRunChange?: (run: SubagentRun) => void,
    ): Promise<SubagentForegroundResult> {
        const agentId = run.agentId;
        const active: ActiveRun = { controller: new AbortController() };
        this.activeRuns.set(agentId, active);
        if (onRunChange) this.runObservers.set(agentId, onRunChange);
        const onExternalAbort = (): void => {
            active.reason = 'cancelled';
            active.controller.abort();
        };
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
        if (externalSignal?.aborted) onExternalAbort();
        onRunChange?.(cloneRun(run));
        this.emitSnapshot();

        const execution = this.executeRun(run, active, spec, resume);
        const settled = execution.then(() => undefined, () => undefined);
        this.inFlight.add(settled);
        try {
            return await execution;
        } finally {
            externalSignal?.removeEventListener('abort', onExternalAbort);
            this.activeRuns.delete(agentId);
            this.runObservers.delete(agentId);
            this.inFlight.delete(settled);
            await this.persistenceTail;
        }
    }

    stop(agentId: string): boolean {
        const active = this.activeRuns.get(agentId);
        if (!active) return false;
        active.reason = 'cancelled';
        active.controller.abort();
        void active.child?.abort();
        return true;
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const [agentId, active] of this.activeRuns) {
            active.reason = 'cancelled';
            active.controller.abort();
            void active.child?.abort();
            this.log(`[subagent cancel] agentId=${agentId} reason=manager-dispose`);
        }
        await Promise.allSettled([...this.inFlight]);
        await this.persistenceTail;
        for (const timer of this.terminalTimers.values()) clearTimeout(timer);
        this.terminalTimers.clear();
        this.listeners.clear();
    }

    private async executeRun(
        run: SubagentRun,
        active: ActiveRun,
        spec: ResolvedAgentSpec,
        resume: boolean,
    ): Promise<SubagentForegroundResult> {
        try {
            return await this.scheduleParent(active.controller.signal, () =>
                this.coordinator.schedule(active.controller.signal, async (signal) => {
                const startedAt = this.now();
                this.updateRun(run, {
                    status: 'starting',
                    startedAt,
                    queueWaitMs: Math.max(0, startedAt - (run.queuedAt ?? startedAt)),
                    activity: 'Creating isolated child session',
                });
                let child: ChildSessionHandle | undefined;
                let unsubscribe: (() => void) | undefined;
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    child = resume
                        ? await this.factory.resume!(spec, run.transcriptPath!, { agentId: run.agentId, signal })
                        : await this.factory.create(spec, { agentId: run.agentId, signal });
                    active.child = child;
                    this.updateRun(run, {
                        status: 'running',
                        model: { ...child.model },
                        ...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
                        ...(child.isolationPath ? { isolationPath: child.isolationPath } : {}),
                        activity: 'Processing delegated task',
                    });
                    unsubscribe = child.subscribe((event) => {
                        switch (event.type) {
                            case 'turn-ended': {
                                const turnCount = run.turnCount + 1;
                                this.updateRun(run, {
                                    turnCount,
                                    status: 'running',
                                    currentTool: undefined,
                                    activity: `Completed turn ${turnCount}`,
                                });
                                if (!child?.getCompletion() && run.turnCount >= spec.maxTurns && !signal.aborted) {
                                    active.reason = 'max-turns';
                                    active.controller.abort();
                                    void child?.abort();
                                }
                                break;
                            }
                            case 'tool-started':
                                this.options.onMutationEvent?.({
                                    type: 'tool_execution_start',
                                    agentId: run.agentId,
                                    toolCallId: namespaceChildToolCallId(run.agentId, event.toolCallId),
                                    toolName: event.toolName,
                                    ...(event.args !== undefined ? { args: event.args } : {}),
                                    ...(run.isolationPath ? { isolationPath: run.isolationPath } : {}),
                                });
                                this.updateRun(run, {
                                    status: 'running',
                                    currentTool: event.toolName,
                                    activity: `Running ${event.toolName}`,
                                });
                                break;
                            case 'tool-ended':
                                this.options.onMutationEvent?.({
                                    type: 'tool_execution_end',
                                    agentId: run.agentId,
                                    toolCallId: namespaceChildToolCallId(run.agentId, event.toolCallId),
                                    toolName: event.toolName,
                                    isError: event.isError,
                                    ...(event.args !== undefined ? { args: event.args } : {}),
                                    ...(run.isolationPath ? { isolationPath: run.isolationPath } : {}),
                                });
                                this.updateRun(run, {
                                    status: 'running',
                                    currentTool: undefined,
                                    activity: event.isError ? `${event.toolName} failed` : `${event.toolName} completed`,
                                });
                                break;
                            case 'retrying':
                                this.updateRun(run, {
                                    status: 'retrying',
                                    activity: `Retrying provider request (attempt ${event.attempt})`,
                                });
                                break;
                            case 'permission-wait':
                                this.updateRun(run, {
                                    status: 'waiting_for_permission',
                                    currentTool: event.toolName,
                                    activity: `Waiting for permission: ${event.toolName}`,
                                });
                                break;
                            case 'completion':
                                this.updateRun(run, {
                                    status: 'running',
                                    currentTool: 'complete_subagent',
                                    activity: 'Finalizing result',
                                });
                                break;
                        }
                    });
                    timeout = setTimeout(() => {
                        active.reason = 'timeout';
                        active.controller.abort();
                        void child?.abort();
                    }, spec.timeoutMinutes * 60_000);

                    await child.prompt(spec.task);
                    if (signal.aborted) throw this.abortFailure(active, run);
                    let completion = child.getCompletion();
                    if (!completion) {
                        if (run.turnCount >= spec.maxTurns) {
                            active.reason = 'max-turns';
                            throw this.abortFailure(active, run);
                        }
                        this.updateRun(run, {
                            status: 'running',
                            currentTool: undefined,
                            activity: 'Requesting structured completion',
                        });
                        await child.prompt(
                            'Your previous response did not call complete_subagent. ' +
                            'Call complete_subagent now, by itself, with the complete final result. Do not call any other tool.',
                        );
                        if (signal.aborted) throw this.abortFailure(active, run);
                        completion = child.getCompletion();
                    }
                    if (!completion?.result.trim()) {
                        throw new SubagentRunError(
                            'incomplete',
                            'Subagent did not call complete_subagent with a non-empty result after one recovery turn.',
                            run.agentId,
                            child.getLastAssistantText(),
                        );
                    }
                    const bounded = truncateUtf8(completion.result, this.resultByteLimit);
                    const result: SubagentForegroundResult = {
                        agentId: run.agentId,
                        result: bounded.value,
                        ...(completion.summary ? { summary: completion.summary } : {}),
                        ...(completion.artifacts ? { artifacts: completion.artifacts.map((artifact) => ({ ...artifact })) } : {}),
                        model: { ...child.model },
                        turnCount: run.turnCount,
                        truncated: bounded.truncated,
                    };
                    this.updateRun(run, {
                        status: 'completed',
                        currentTool: undefined,
                        activity: bounded.truncated ? 'Completed (result truncated)' : 'Completed',
                        finishedAt: this.now(),
                        resultPreview: preview(result.result, 500),
                    });
                    this.log(
                        `[subagent end] agentId=${run.agentId} status=completed turns=${run.turnCount} ` +
                        `model=${child.model.provider}/${child.model.id}`,
                    );
                    return result;
                } finally {
                    if (timeout) clearTimeout(timeout);
                    unsubscribe?.();
                    child?.dispose();
                    active.child = undefined;
                }
            }));
        } catch (error) {
            const failure = normalizeFailure(error, active, run);
            const status: SubagentRunStatus = failure.reason === 'cancelled' ? 'cancelled' : 'failed';
            this.updateRun(run, {
                status,
                currentTool: undefined,
                activity: status === 'cancelled' ? 'Cancelled' : 'Failed',
                finishedAt: this.now(),
                error: failure.message,
            });
            this.log(`[subagent end] agentId=${run.agentId} status=${status} reason=${failure.reason} error=${failure.message}`);
            throw failure;
        }
    }

    private scheduleParent(
        signal: AbortSignal,
        operation: () => Promise<SubagentForegroundResult>,
    ): Promise<SubagentForegroundResult> {
        if (signal.aborted) return Promise.reject(abortError());
        return new Promise<SubagentForegroundResult>((resolve, reject) => {
            const entry = {
                signal,
                run: operation,
                resolve,
                reject,
                onAbort: () => {
                    const index = this.parentQueue.indexOf(entry);
                    if (index >= 0) this.parentQueue.splice(index, 1);
                    reject(abortError());
                },
            };
            signal.addEventListener('abort', entry.onAbort, { once: true });
            this.parentQueue.push(entry);
            this.pumpParentQueue();
        });
    }

    private pumpParentQueue(): void {
        while (this.parentActive < this.maxConcurrentRuns && this.parentQueue.length > 0) {
            const entry = this.parentQueue.shift()!;
            entry.signal.removeEventListener('abort', entry.onAbort);
            if (entry.signal.aborted) {
                entry.reject(abortError());
                continue;
            }
            this.parentActive += 1;
            void entry.run().then(entry.resolve, entry.reject).finally(() => {
                this.parentActive -= 1;
                this.pumpParentQueue();
            });
        }
    }

    private abortFailure(active: ActiveRun, run: SubagentRun): SubagentRunError {
        const reason = active.reason ?? 'cancelled';
        const message = reason === 'timeout'
            ? 'Subagent exceeded its execution timeout.'
            : reason === 'max-turns'
                ? 'Subagent exceeded its maximum turn count.'
                : 'Subagent run was cancelled.';
        return new SubagentRunError(reason, message, run.agentId, active.child?.getLastAssistantText());
    }

    private updateRun(run: SubagentRun, patch: Partial<SubagentRun>): void {
        Object.assign(run, patch);
        this.runObservers.get(run.agentId)?.(cloneRun(run));
        const spec = this.runSpecs.get(run.agentId);
        if (spec) this.persist(run, spec);
        if (!isActiveStatus(run.status)) this.retainTerminalRun(run);
        this.emitSnapshot();
    }

    private retainTerminalRun(run: SubagentRun): void {
        const previous = this.terminalTimers.get(run.agentId);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => {
            this.terminalTimers.delete(run.agentId);
            if (this.runs.get(run.agentId) === run && !isActiveStatus(run.status)) {
                this.runs.delete(run.agentId);
                this.emitSnapshot();
            }
        }, this.terminalRetentionMs);
        timer.unref?.();
        this.terminalTimers.set(run.agentId, timer);

        const terminal = [...this.runs.values()]
            .filter((candidate) => !isActiveStatus(candidate.status))
            .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
        for (const expired of terminal.slice(this.maxRetainedTerminalRuns)) {
            this.runs.delete(expired.agentId);
            const expiredTimer = this.terminalTimers.get(expired.agentId);
            if (expiredTimer) clearTimeout(expiredTimer);
            this.terminalTimers.delete(expired.agentId);
        }
    }

    private persist(run: SubagentRun, spec: ResolvedAgentSpec): void {
        if (!this.options.persistRun) return;
        const runSnapshot = cloneRun(run);
        const specSnapshot = cloneSpec(spec);
        this.persistenceTail = this.persistenceTail
            .then(() => this.options.persistRun!(runSnapshot, specSnapshot))
            .catch((error) => this.log(
                `[subagent persistence error] agentId=${run.agentId} error=${error instanceof Error ? error.message : String(error)}`,
            ));
    }

    private emitSnapshot(): void {
        if (this.listeners.size === 0) return;
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            try { listener(snapshot); } catch { /* listener isolation */ }
        }
    }

    private log(message: string): void {
        this.options.log?.(message);
    }
}

export function namespaceChildToolCallId(agentId: string, toolCallId: string): string {
    return `${agentId}:${toolCallId}`;
}

function abortError(): Error {
    const error = new Error('Subagent queue entry was cancelled.');
    error.name = 'AbortError';
    return error;
}

function normalizeFailure(error: unknown, active: ActiveRun, run: SubagentRun): SubagentRunError {
    if (error instanceof SubagentRunError) return error;
    if (active.reason) {
        const message = active.reason === 'timeout'
            ? 'Subagent exceeded its execution timeout.'
            : active.reason === 'max-turns'
                ? 'Subagent exceeded its maximum turn count.'
                : 'Subagent run was cancelled.';
        return new SubagentRunError(active.reason, message, run.agentId, active.child?.getLastAssistantText());
    }
    if (error instanceof Error && error.name === 'AbortError') {
        return new SubagentRunError('cancelled', error.message, run.agentId, active.child?.getLastAssistantText());
    }
    return new SubagentRunError(
        'runtime-error',
        error instanceof Error ? error.message : String(error),
        run.agentId,
        active.child?.getLastAssistantText(),
    );
}

function isActiveStatus(status: SubagentRunStatus): boolean {
    return status === 'queued' || status === 'starting' || status === 'running' ||
        status === 'waiting_for_permission' || status === 'retrying';
}

function cloneRun(run: SubagentRun): SubagentRun {
    return {
        ...run,
        ...(run.model ? { model: { ...run.model } } : {}),
    };
}

function cloneSpec(spec: ResolvedAgentSpec): ResolvedAgentSpec {
    return JSON.parse(JSON.stringify(spec)) as ResolvedAgentSpec;
}

function preview(value: string, maximum: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= maximumBytes) return { value, truncated: false };
    const suffix = '\n\n[Subagent result truncated by Pi Code.]';
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    if (suffixBytes >= maximumBytes) {
        return { value: utf8Prefix(suffix, maximumBytes), truncated: true };
    }
    return {
        value: `${utf8Prefix(value, maximumBytes - suffixBytes)}${suffix}`,
        truncated: true,
    };
}

function utf8Prefix(value: string, maximumBytes: number): string {
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
        else high = middle - 1;
    }
    let result = value.slice(0, low);
    const finalCode = result.charCodeAt(result.length - 1);
    if (finalCode >= 0xD800 && finalCode <= 0xDBFF) result = result.slice(0, -1);
    return result;
}
