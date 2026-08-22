import { TurnNotificationGate } from './turn-notification-gate';
import type {
    CacheEffective,
    CodexTurnUsage,
    CodexUsageSnapshot,
    DeepSeekTurnUsage,
} from '../../shared/agent-protocol';
import type { ProjectToolSelectionDefault } from '../../shared/project-tool-default';
import type { SubagentStatEntry, ToolStatEntry } from '../../shared/tool-timing';

export interface TabSessionResource {
    dispose(): void | Promise<void>;
}

export interface TabDisposableResource {
    dispose(): void | Promise<void>;
}

export interface TabMessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
    codexTurn?: CodexTurnUsage;
    deepSeekTurn?: DeepSeekTurnUsage;
    turnDurationMs?: number;
    totalTurnDurationMs?: number;
    toolStats?: ToolStatEntry[];
    /**
     * Live entries owned by `TabRuntime.subagentStats`. Held by reference on
     * purpose: a background child settles after its turn closed, and the turn
     * summary has to pick that up without rewriting history.
     */
    subagentStats?: SubagentStatEntry[];
}

/**
 * Upper bound on remembered per-call tool durations. Only the chat cards still
 * on screen read this map, so an old entry is dead weight; the cap keeps a
 * long-lived tab from growing without limit.
 */
export const TOOL_DURATION_HISTORY_LIMIT = 5000;

/** Upper bound on delegated runs tracked for turn summaries in one tab. */
export const SUBAGENT_STAT_HISTORY_LIMIT = 500;

/**
 * Upper bound on assistant messages retaining turn metadata. Keys are message
 * identities rather than compact-context positions, so the map no longer shrinks
 * when the context is compacted and needs its own ceiling.
 */
export const MESSAGE_META_HISTORY_LIMIT = 2000;

export interface TabRuntimeOptions<
    TSession extends TabSessionResource,
    TDiff extends TabDisposableResource,
    TCheckpoint extends TabDisposableResource,
> {
    id: string;
    session: TSession;
    diffManager: TDiff;
    checkpointManager: TCheckpoint;
    projectToolDefault?: ProjectToolSelectionDefault;
    initialTurnCounter?: number;
}

/**
 * Portable owner for one chat tab's resources and transient projection state.
 * Concrete session, diff, and checkpoint implementations are supplied by the host.
 */
export class TabRuntime<
    TSession extends TabSessionResource,
    TDiff extends TabDisposableResource,
    TCheckpoint extends TabDisposableResource,
> {
    readonly id: string;
    name: string;
    readonly session: TSession;
    readonly diffManager: TDiff;
    readonly checkpointManager: TCheckpoint;
    turnCounter: number;
    suspendedMessages: any[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    totalTurnDurationMs: number;
    /** Keyed by `assistantMetaKey`, not by position — compaction rewrites order. */
    readonly messageMeta: Map<string, TabMessageMeta>;
    readonly turnNotificationGate: TurnNotificationGate;
    hasNotification: boolean;
    queuedMessages: string[];
    queuedRetryHead?: string;
    queuedRetryAttempts: number;
    isStreamingLocal: boolean;
    isCompacting: boolean;
    codexTurnBaseline?: CodexUsageSnapshot | null;
    codexTurnModelId?: string;
    deepSeekSessionCostBaseline?: number;
    deepSeekAccountFingerprint?: string;
    errorReportedThisRun: boolean;
    lastTurnEndAt: number;
    maxIdleGapMs: number;
    cacheEffective: CacheEffective;
    readonly pendingTools: Map<string, { name: string; startTime: number; args?: unknown }>;
    /** Wall-clock duration of every finished tool call, keyed by tool call id. */
    readonly toolDurations: Map<string, number>;
    /** Per-tool totals for the turn currently running, keyed by display name. */
    readonly turnToolStats: Map<string, ToolStatEntry>;
    /** Delegated runs observed in this tab, keyed by agent id. Mutated in place. */
    readonly subagentStats: Map<string, SubagentStatEntry>;
    /** Agent ids first observed during the turn currently running. */
    readonly turnSubagentIds: Set<string>;
    /** Start time of in-flight child tool calls, keyed by namespaced call id. */
    readonly pendingSubagentTools: Map<string, number>;
    projectToolDefault?: ProjectToolSelectionDefault;

    private _subscriptions: Array<() => void> = [];
    private _disposePromise?: Promise<void>;

    constructor(options: TabRuntimeOptions<TSession, TDiff, TCheckpoint>) {
        this.id = options.id;
        this.name = 'New Agent';
        this.session = options.session;
        this.diffManager = options.diffManager;
        this.checkpointManager = options.checkpointManager;
        this.turnCounter = Math.max(0, Math.trunc(options.initialTurnCounter ?? 0));
        this.suspendedMessages = [];
        this.streamingText = '';
        this.streamingThinking = '';
        this.isThinking = false;
        this.thinkingStartTime = 0;
        this.streamingThinkingDuration = 0;
        this.agentStartTime = 0;
        this.totalTurnDurationMs = 0;
        this.messageMeta = new Map();
        this.turnNotificationGate = new TurnNotificationGate();
        this.hasNotification = false;
        this.queuedMessages = [];
        this.queuedRetryAttempts = 0;
        this.isStreamingLocal = false;
        this.isCompacting = false;
        this.errorReportedThisRun = false;
        this.lastTurnEndAt = 0;
        this.maxIdleGapMs = 0;
        this.cacheEffective = 'short';
        this.pendingTools = new Map();
        this.toolDurations = new Map();
        this.turnToolStats = new Map();
        this.subagentStats = new Map();
        this.turnSubagentIds = new Set();
        this.pendingSubagentTools = new Map();
        this.projectToolDefault = options.projectToolDefault;
    }

    /**
     * Fetch the accounting row for one delegated run, creating it on first
     * sight. Rows are mutated in place so a turn summary that already holds one
     * keeps seeing current numbers after a background child settles.
     *
     * A run first seen while the agent is streaming is charged to that turn;
     * restored history and late arrivals are tracked without being charged to
     * whatever turn happens to be open.
     */
    subagentStat(agentId: string, name?: string): SubagentStatEntry {
        const existing = this.subagentStats.get(agentId);
        if (existing) {
            // The tool-event channel carries no run name, so a row created from
            // a child tool call adopts the real name on the next run sync.
            if (name && existing.name === agentId) existing.name = name;
            return existing;
        }

        const created: SubagentStatEntry = {
            agentId,
            name: name || agentId,
            status: 'active',
            durationMs: 0,
            toolDurationMs: 0,
            toolCalls: 0,
        };
        this.subagentStats.set(agentId, created);
        if (this.isStreamingLocal) this.turnSubagentIds.add(agentId);
        // Evicted rows stop receiving updates but stay rendered in the turn
        // summaries that already reference them.
        while (this.subagentStats.size > SUBAGENT_STAT_HISTORY_LIMIT) {
            const oldest = this.subagentStats.keys().next();
            if (oldest.done) break;
            this.subagentStats.delete(oldest.value);
        }
        return created;
    }

    /**
     * Store one assistant message's turn metadata, evicting the oldest entries
     * once the history cap is reached. An evicted card simply loses its footer
     * detail; nothing else depends on the map.
     */
    recordMessageMeta(key: string, meta: TabMessageMeta): void {
        this.messageMeta.set(key, meta);
        while (this.messageMeta.size > MESSAGE_META_HISTORY_LIMIT) {
            const oldest = this.messageMeta.keys().next();
            if (oldest.done) break;
            this.messageMeta.delete(oldest.value);
        }
    }

    /**
     * Remember how long one tool call took and fold it into the running turn
     * total. Oldest entries are evicted first once the history cap is reached.
     */
    recordToolDuration(toolCallId: string, durationMs: number): void {
        const normalized = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
        this.toolDurations.delete(toolCallId);
        this.toolDurations.set(toolCallId, normalized);
        while (this.toolDurations.size > TOOL_DURATION_HISTORY_LIMIT) {
            const oldest = this.toolDurations.keys().next();
            if (oldest.done) break;
            this.toolDurations.delete(oldest.value);
        }
    }

    addSubscription(unsubscribe: () => void): void {
        this._subscriptions.push(unsubscribe);
    }

    unsubscribe(): void {
        const subscriptions = this._subscriptions;
        this._subscriptions = [];
        let firstError: unknown;
        let didThrow = false;

        for (const unsubscribe of subscriptions) {
            try {
                unsubscribe();
            } catch (error) {
                if (!didThrow) {
                    firstError = error;
                    didThrow = true;
                }
            }
        }

        if (didThrow) throw firstError;
    }

    resetSessionProjection(
        projectToolDefault?: ProjectToolSelectionDefault,
        initialTurnCounter = 0,
    ): void {
        this.projectToolDefault = projectToolDefault;
        this.turnCounter = Math.max(0, Math.trunc(initialTurnCounter));
        this.suspendedMessages = [];
        this.name = 'New Agent';
        this.streamingText = '';
        this.streamingThinking = '';
        this.isThinking = false;
        this.thinkingStartTime = 0;
        this.streamingThinkingDuration = 0;
        this.agentStartTime = 0;
        this.totalTurnDurationMs = 0;
        this.isStreamingLocal = false;
        this.isCompacting = false;
        this.messageMeta.clear();
        this.toolDurations.clear();
        this.turnToolStats.clear();
        this.subagentStats.clear();
        this.turnSubagentIds.clear();
        this.pendingSubagentTools.clear();
        this.turnNotificationGate.reset();
        this.queuedMessages = [];
        this.queuedRetryHead = undefined;
        this.queuedRetryAttempts = 0;
        this.lastTurnEndAt = 0;
        this.maxIdleGapMs = 0;
    }

    disposeResources(): Promise<void> {
        this._disposePromise ??= this._disposeResourcesOnce();
        return this._disposePromise;
    }

    private async _disposeResourcesOnce(): Promise<void> {
        let firstError: unknown;
        let didThrow = false;
        const attempt = async (dispose: () => void | Promise<void>): Promise<void> => {
            try {
                await dispose();
            } catch (error) {
                if (!didThrow) {
                    firstError = error;
                    didThrow = true;
                }
            }
        };

        await attempt(() => this.unsubscribe());
        await attempt(() => this.diffManager.dispose());
        await attempt(() => this.checkpointManager.dispose());
        await attempt(() => this.session.dispose());

        if (didThrow) throw firstError;
    }
}
