import { TurnNotificationGate } from './turn-notification-gate';
import type {
    CacheEffective,
    CodexTurnUsage,
    CodexUsageSnapshot,
    DeepSeekTurnUsage,
} from '../../shared/agent-protocol';
import type { ProjectToolSelectionDefault } from '../../shared/project-tool-default';
import type { ToolStatEntry } from '../../shared/tool-timing';

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
}

/**
 * Upper bound on remembered per-call tool durations. Only the chat cards still
 * on screen read this map, so an old entry is dead weight; the cap keeps a
 * long-lived tab from growing without limit.
 */
export const TOOL_DURATION_HISTORY_LIMIT = 5000;

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
    readonly messageMeta: Map<number, TabMessageMeta>;
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
        this.projectToolDefault = options.projectToolDefault;
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
