import { TurnNotificationGate } from '../../notifications/turn-notification-gate';
import type { CacheEffective, CodexTurnUsage, CodexUsageSnapshot } from '../../shared/agent-protocol';
import type { ProjectToolSelectionDefault } from '../../shared/project-tool-default';

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
    turnDurationMs?: number;
    totalTurnDurationMs?: number;
}

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
    isStreamingLocal: boolean;
    isCompacting: boolean;
    codexTurnBaseline?: CodexUsageSnapshot | null;
    codexTurnModelId?: string;
    errorReportedThisRun: boolean;
    lastTurnEndAt: number;
    maxIdleGapMs: number;
    cacheEffective: CacheEffective;
    readonly pendingTools: Map<string, { name: string; startTime: number }>;
    projectToolDefault?: ProjectToolSelectionDefault;

    private _subscriptions: Array<() => void> = [];
    private _disposePromise?: Promise<void>;

    constructor(options: TabRuntimeOptions<TSession, TDiff, TCheckpoint>) {
        this.id = options.id;
        this.name = 'New Agent';
        this.session = options.session;
        this.diffManager = options.diffManager;
        this.checkpointManager = options.checkpointManager;
        this.turnCounter = 0;
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
        this.isStreamingLocal = false;
        this.isCompacting = false;
        this.errorReportedThisRun = false;
        this.lastTurnEndAt = 0;
        this.maxIdleGapMs = 0;
        this.cacheEffective = 'short';
        this.pendingTools = new Map();
        this.projectToolDefault = options.projectToolDefault;
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

    resetSessionProjection(projectToolDefault?: ProjectToolSelectionDefault): void {
        this.projectToolDefault = projectToolDefault;
        this.turnCounter = 0;
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
        this.turnNotificationGate.reset();
        this.queuedMessages = [];
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
