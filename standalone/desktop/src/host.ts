import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { NodeFileMentions } from '../../../src/adapters/node/file-mentions';
import { JsonStateStore } from '../../../src/adapters/node/json-state-store';
import { NodeLogger, type NodeLogSink } from '../../../src/adapters/node/logger';
import { NodeSessionLock } from '../../../src/adapters/node/session-lock';
import {
    NodeSessionWorkspace,
    createNodeSessionRuntimePorts,
} from '../../../src/adapters/node/session-platform';
import { NodeWorkspaceFileState } from '../../../src/adapters/node/workspace-file-state';
import { ChatHost, type ChatHostTabRequest, type PersistedChatHostTabs } from '../../../src/core/chat/chat-host';
import { parseNameCommand } from '../../../src/core/chat/chat-command-service';
import { collectOrphanedTools } from '../../../src/core/chat/chat-event-policy';
import {
    FILE_UNDO_VIEW_KEY_PREFIX,
    PLAN_MODE_KEY_PREFIX,
    PROJECT_TOOL_DEFAULT_KEY,
    TODO_ENABLED_KEY_PREFIX,
    composeEffectiveDisabledTools,
    computeEffectiveCache,
    decorateDirectPrompt,
    prepareCacheForRequest,
    readDisabledTools,
    readSessionBoolean,
    writeDisabledTools,
    writeSessionBoolean,
} from '../../../src/core/chat/chat-preferences';
import { ChatService, countUserTurns } from '../../../src/core/chat/chat-service';
import { TabRegistry } from '../../../src/core/chat/tab-registry';
import { TabRuntime } from '../../../src/core/chat/tab-runtime';
import { CheckpointManager } from '../../../src/core/files/checkpoint-manager';
import { DiffManager } from '../../../src/core/files/diff-manager';
import type { FileMentionsPort, StateStore } from '../../../src/core/ports/chat-platform';
import type { FileStatePort } from '../../../src/core/ports/file-state';
import type { Logger } from '../../../src/core/ports/logger';
import type {
    SecretStore,
    SessionSettingValues,
} from '../../../src/core/ports/session-platform';
import { getBundledPiPackagePaths } from '../../../src/pi/bundled-packages';
import { PiSessionManager } from '../../../src/pi/session';
import { ChildToolFactoryRegistry } from '../../../src/pi/subagents/child-tools';
import { SubagentCoordinator } from '../../../src/pi/subagents/coordinator';
import { SubagentCapabilityGate } from '../../../src/pi/subagents/gating';
import { routeSubagentMutation } from '../../../src/pi/subagents/mutations';
import { SubagentRunStore } from '../../../src/pi/subagents/persistence';
import { WriteIsolationManager } from '../../../src/pi/subagents/write-isolation';
import type {
    AgentClientMessage,
    AgentServerMessage,
    CacheEffective,
    CacheMode,
    FileAttachment,
    ImageAttachment,
    SerializedAgentState,
} from '../../../src/shared/agent-protocol';
import {
    parseProjectToolSelectionDefault,
    type ProjectToolSelectionDefault,
} from '../../../src/shared/project-tool-default';
import { DesktopSessionSettings } from './desktop-state';
import type { DesktopAgentBackend } from './ipc-host';

const TABS_STATE_KEY = 'pi-code.tabs';
const CACHE_MODE_KEY = 'pi-code.cacheMode';
const FAVORITES_KEY = 'pi-code.favoriteModels';

export type DesktopTab = TabRuntime<PiSessionManager, DiffManager, CheckpointManager>;

export interface DesktopChatRuntimeDefaults {
    readonly todoEnabled?: boolean;
    readonly subagentsEnabled?: boolean;
    readonly planModeEnabled?: boolean;
    readonly fileUndoViewEnabled?: boolean;
}

export interface DesktopChatRuntimeDependencies {
    readonly workspaceState: StateStore;
    readonly globalState: StateStore;
    readonly fileMentions: FileMentionsPort;
    readonly fileState: FileStatePort;
    readonly logger: Logger;
    readonly createSession: () => PiSessionManager;
    readonly emit: (message: AgentServerMessage, tabId?: string) => void;
    readonly defaults?: DesktopChatRuntimeDefaults;
    readonly disposeDependencies?: () => void | Promise<void>;
}

export interface ProductionDesktopHostOptions {
    readonly workspaceRoot: string;
    readonly appDataRoot: string;
    readonly packageRoot: string;
    readonly workspaceTrusted: boolean;
    readonly emit: (message: AgentServerMessage, tabId?: string) => void;
    readonly log?: NodeLogSink;
    readonly sessionSettings?: Partial<SessionSettingValues>;
    readonly globalState?: StateStore;
    readonly secrets?: SecretStore;
    readonly defaults?: DesktopChatRuntimeDefaults;
    readonly subagentMaxConcurrency?: number;
}

/** Composition-only desktop owner around the shared ChatHost and Pi runtime. */
export class DesktopChatRuntime implements DesktopAgentBackend {
    readonly host: ChatHost<DesktopTab>;

    private readonly tabs = new TabRegistry<DesktopTab>();
    private readonly chat = new ChatService({ now: () => Date.now() });
    private readonly subagentGate: SubagentCapabilityGate;
    private cacheMode: CacheMode = 'auto';
    private favorites = new Set<string>();
    private initialized = false;
    private shuttingDown = false;
    private disposePromise?: Promise<void>;
    private shutdownPromise?: Promise<void>;

    constructor(private readonly dependencies: DesktopChatRuntimeDependencies) {
        this.subagentGate = new SubagentCapabilityGate(
            dependencies.workspaceState,
            () => dependencies.defaults?.subagentsEnabled ?? false,
        );
        const storedMode = dependencies.globalState.get<unknown>(CACHE_MODE_KEY);
        if (storedMode === 'short' || storedMode === 'long' || storedMode === 'auto') {
            this.cacheMode = storedMode;
        }
        const storedFavorites = dependencies.globalState.get<unknown>(FAVORITES_KEY);
        if (Array.isArray(storedFavorites)) {
            this.favorites = new Set(storedFavorites.filter(
                (value): value is string => typeof value === 'string',
            ));
        }

        this.host = new ChatHost({
            tabs: this.tabs,
            chat: this.chat,
            factory: (request) => this.createTabState(request),
            commandCallbacks: (tab) => this.createCommandCallbacks(tab),
            stateContext: (tab) => ({
                cacheMode: this.cacheMode,
                getCacheEffective: () => this.computeEffectiveCache(tab),
                getFileUndoViewEnabled: () => this.isFileUndoViewEnabled(tab),
            }),
            preferences: {
                getCacheMode: () => this.cacheMode,
                setCacheMode: async (mode) => {
                    this.cacheMode = mode;
                    await this.dependencies.globalState.update(CACHE_MODE_KEY, mode);
                },
                getFavorites: () => [...this.favorites],
                setFavorites: async (favorites) => {
                    this.favorites = new Set(favorites);
                    await this.dependencies.globalState.update(FAVORITES_KEY, [...this.favorites]);
                },
                getProjectToolDefault: () => this.getProjectToolDefault(),
                applyPersistedToolSelection: (tab) => this.applyPersistedToolSelection(tab),
                refreshCacheEffective: (tab) => {
                    tab.cacheEffective = this.computeEffectiveCache(tab);
                },
                getDisabledTools: (tab) => this.getDisabledTools(tab),
                setDisabledTools: (tab, disabled) => writeDisabledTools(
                    this.dependencies.workspaceState,
                    tab.session.sessionPath,
                    disabled,
                ),
                setTodoEnabled: (tab, enabled) => writeSessionBoolean(
                    this.dependencies.workspaceState,
                    TODO_ENABLED_KEY_PREFIX,
                    tab.session.sessionPath,
                    enabled,
                ),
                setSubagentsEnabled: (tab, enabled) => this.subagentGate.setEnabled(
                    tab.session.sessionPath,
                    enabled,
                    false,
                ),
                setPlanModeEnabled: (tab, enabled) => writeSessionBoolean(
                    this.dependencies.workspaceState,
                    PLAN_MODE_KEY_PREFIX,
                    tab.session.sessionPath,
                    enabled,
                ),
                setFileUndoViewEnabled: (tab, enabled) => writeSessionBoolean(
                    this.dependencies.workspaceState,
                    FILE_UNDO_VIEW_KEY_PREFIX,
                    tab.session.sessionPath,
                    enabled,
                ),
            },
            effects: {
                bindTab: (tab) => this.bindTab(tab),
                persistTabs: () => this.persistTabs(),
                tabsChanged: () => undefined,
                publishState: (tabId) => this.publishState(tabId),
                openTab: () => undefined,
                activeTabChanged: () => undefined,
                tabRenamed: (_tabId, _name) => undefined,
                modelsChanged: () => this.publishModels(),
                reportCommandFailure: (type, tabId, error) => {
                    const message = errorMessage(error);
                    this.dependencies.logger.appendLine(
                        `[desktop command error] type=${type} tab=${tabId}: ${message}`,
                    );
                    this.dependencies.emit({ type: 'error', message }, tabId);
                },
                restoreFailed: (entry, error) => {
                    this.dependencies.logger.appendLine(
                        `Failed to restore tab "${entry.name}": ${errorMessage(error)}`,
                    );
                },
            },
            eventEffects: {
                reportAgentError: (tab, raw) => this.reportAgentIssue(
                    tab,
                    raw || 'The AI provider returned an error.',
                    'error',
                ),
                reportAgentNotice: (tab, message, severity) => {
                    this.reportAgentIssue(tab, message, severity);
                },
                showAutoRetry: (event) => {
                    const attempt = Number(event.attempt ?? 0);
                    const maximum = Number(event.maxAttempts ?? 0);
                    this.dependencies.emit({
                        type: 'error',
                        severity: 'info',
                        message: `Provider retry ${attempt}/${maximum}: ${String(event.errorMessage ?? '')}`,
                    });
                },
                logTurnEnd: (tab, assistant) => {
                    this.dependencies.logger.appendLine(
                        `[turn end] tab="${tab.name || tab.id}" stopReason=${String(assistant?.stopReason ?? 'unknown')}`,
                    );
                },
                sweepPendingTools: (tab, assistant) => this.sweepPendingTools(tab, assistant),
                emitAgentEvent: (tabId, event) => {
                    this.dependencies.emit({ type: 'agentEvent', event }, tabId);
                },
                dispatchNextQueued: (tab) => this.dispatchNextQueued(tab),
            },
        });
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        const persisted = parsePersistedTabs(
            this.dependencies.workspaceState.get<unknown>(TABS_STATE_KEY),
        );
        if (persisted && persisted.tabs.length > 0) {
            await this.host.restoreTabs(persisted);
        }
        if (this.tabs.size === 0) await this.host.createTab();
    }

    dispatch(message: AgentClientMessage, sourceTabId?: string) {
        if (this.shuttingDown) {
            return Promise.resolve({
                ok: false as const,
                code: 'host_shutting_down',
                message: 'The desktop host is shutting down.',
            });
        }
        return this.host.dispatch(message, sourceTabId);
    }

    getState(tabId?: string): SerializedAgentState | undefined {
        return this.host.getState(tabId);
    }

    shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shuttingDown = true;
        const tabs = [...this.tabs.values()];
        const sessionShutdowns = tabs.map((tab) => tab.session.shutdown());
        this.shutdownPromise = Promise.allSettled(sessionShutdowns).then(async (results) => {
            let firstError = results.find(
                (result): result is PromiseRejectedResult => result.status === 'rejected',
            )?.reason;
            try {
                await this.dispose();
            } catch (error) {
                firstError ??= error;
            }
            if (firstError !== undefined) throw firstError;
        });
        return this.shutdownPromise;
    }

    dispose(): Promise<void> {
        this.disposePromise ??= this.disposeOnce();
        return this.disposePromise;
    }

    private async disposeOnce(): Promise<void> {
        let firstError: unknown;
        for (const tab of [...this.tabs.values()]) {
            try {
                await tab.disposeResources();
            } catch (error) {
                firstError ??= error;
            } finally {
                this.tabs.remove(tab.id);
            }
        }
        try {
            await this.dependencies.disposeDependencies?.();
        } catch (error) {
            firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
    }

    private async createTabState(request: ChatHostTabRequest): Promise<DesktopTab> {
        const session = this.dependencies.createSession();
        let checkpoint: CheckpointManager | undefined;
        let diff: DiffManager | undefined;
        try {
            if (request.kind === 'new') await session.initialize();
            else await session.initializeFromPath(request.sessionPath);
            checkpoint = new CheckpointManager(this.dependencies.fileState);
            diff = new DiffManager(session, checkpoint, this.dependencies.fileState);
            const tab = new TabRuntime({
                id: createTabId(),
                session,
                diffManager: diff,
                checkpointManager: checkpoint,
                projectToolDefault: request.kind === 'new'
                    ? this.getProjectToolDefault()
                    : undefined,
                initialTurnCounter: countUserTurns(session.getMessages()),
            });
            if (request.kind === 'sessionPath' && request.name) tab.name = request.name;
            return tab;
        } catch (error) {
            await Promise.resolve(diff?.dispose()).catch(() => undefined);
            await Promise.resolve(checkpoint?.dispose()).catch(() => undefined);
            await Promise.resolve(session.dispose()).catch(() => undefined);
            throw error;
        }
    }

    private bindTab(tab: DesktopTab): void {
        tab.session.setSubagentParentTabId(tab.id);
        const subscriptions: Array<() => void> = [
            tab.session.events.onAll((event) => {
                void this.host.handleEvent(tab, event).catch((error) => {
                    this.dependencies.logger.appendLine(
                        `[desktop event error] tab=${tab.id}: ${errorMessage(error)}`,
                    );
                });
            }),
            tab.diffManager.onFileChange((change) => {
                this.dependencies.emit({ type: 'fileChange', change }, tab.id);
            }),
            tab.session.todoStore.subscribe(() => this.publishState(tab.id)),
        ];
        const subagentState = tab.session.onSubagentStateChanged(() => this.publishState(tab.id));
        const subagentMutation = tab.session.onSubagentMutation((event) => {
            routeSubagentMutation(event, tab.diffManager);
        });
        const subagentNotification = tab.session.onSubagentNotification(() => this.publishState(tab.id));
        subscriptions.push(
            () => subagentState.dispose(),
            () => subagentMutation.dispose(),
            () => subagentNotification.dispose(),
        );
        this.applyPersistedToolSelection(tab);
        for (const unsubscribe of subscriptions) tab.addSubscription(unsubscribe);
    }

    private createCommandCallbacks(tab: DesktopTab) {
        return {
            directPrompt: {
                decoratePrompt: (text: string) => decorateDirectPrompt(
                    text,
                    this.isPlanModeEnabled(tab),
                ),
                augmentPrompt: (text: string) => this.dependencies.fileMentions.augmentPromptIfNeeded(text),
                compact: (instructions?: string) => tab.session.compact(instructions),
                prompt: (
                    text: string,
                    images?: ImageAttachment[],
                    files?: FileAttachment[],
                ) => tab.session.prompt(text, images, files),
                prepareRequest: () => this.prepareCacheForRequest(tab),
                logPrompt: () => this.logPromptToolState(tab, 'prompt'),
                publishState: () => this.publishState(tab.id),
                reportDetachedFailure: (error: unknown) => {
                    this.dependencies.logger.appendLine(
                        `[desktop prompt error] tab=${tab.id}: ${errorMessage(error)}`,
                    );
                },
            },
            streaming: {
                augmentPrompt: (text: string) => this.dependencies.fileMentions.augmentPromptIfNeeded(text),
                prepareRequest: () => this.prepareCacheForRequest(tab),
                logPrompt: (kind: 'steer' | 'followUp') => this.logPromptToolState(tab, kind),
                steer: (
                    text: string,
                    images?: ImageAttachment[],
                    files?: FileAttachment[],
                ) => tab.session.steer(text, images, files),
                followUp: (
                    text: string,
                    images?: ImageAttachment[],
                    files?: FileAttachment[],
                ) => tab.session.followUp(text, images, files),
                abort: () => tab.session.abort(),
            },
            fileMentions: this.dependencies.fileMentions,
            handleName: (text: string, hasAttachments: boolean, publishState = true) => (
                this.handleName(tab, text, hasAttachments, publishState)
            ),
            publishState: () => this.publishState(tab.id),
            emit: (message: AgentServerMessage) => this.dependencies.emit(message, tab.id),
            notifyFileHistory: (kind: 'restore' | 'redo', fileCount: number) => {
                this.dependencies.emit({
                    type: 'error',
                    severity: 'info',
                    message: kind === 'restore'
                        ? `Restored ${fileCount} file(s) to checkpoint.`
                        : `Re-applied ${fileCount} file(s).`,
                }, tab.id);
            },
        };
    }

    private handleName(
        tab: DesktopTab,
        text: string,
        hasAttachments: boolean,
        publishState: boolean,
    ): boolean {
        const name = parseNameCommand(text);
        if (name === null) return false;
        if (!name) throw new Error('Usage: /name <name>');
        if (hasAttachments) {
            throw new Error('The /name command cannot include attachments. Remove attachments and try again.');
        }
        tab.session.setSessionName(name);
        this.host.refreshTabName(tab);
        if (publishState) this.publishState(tab.id);
        return true;
    }

    private dispatchNextQueued(tab: DesktopTab): Promise<void> {
        return this.chat.dispatchNextQueued(tab, {
            augmentPrompt: (text) => this.dependencies.fileMentions.augmentPromptIfNeeded(text),
            compact: (instructions) => tab.session.compact(instructions),
            prompt: (text, onAgentStart) => {
                const stopWatching = tab.session.events.on('agent_start', onAgentStart);
                return tab.session.prompt(text).finally(stopWatching);
            },
            isSessionStreaming: () => tab.session.isStreaming,
            handleLocalCommand: (text) => this.handleName(tab, text, false, false),
            scheduleRetry: (retry) => {
                queueMicrotask(() => {
                    void retry().catch((error) => this.dependencies.logger.appendLine(
                        `[desktop queued retry error] ${errorMessage(error)}`,
                    ));
                });
            },
            prepareRequest: () => this.prepareCacheForRequest(tab),
            logQueuedPrompt: () => this.logPromptToolState(tab, 'queued'),
            publishState: () => this.publishState(tab.id),
            reportError: (error) => this.dependencies.logger.appendLine(
                `[desktop queued prompt error] ${errorMessage(error)}`,
            ),
        });
    }

    private persistTabs(): void {
        const entries = this.tabs.list()
            .map((tab) => ({
                name: tab.name,
                sessionPath: tab.session.sessionPath,
            }))
            .filter((entry): entry is { name: string; sessionPath: string } => (
                typeof entry.sessionPath === 'string' && entry.sessionPath.length > 0
            ));
        const activeIndex = Math.max(
            0,
            entries.findIndex((entry) => this.tabs.active?.session.sessionPath === entry.sessionPath),
        );
        void Promise.resolve(this.dependencies.workspaceState.update(TABS_STATE_KEY, {
            tabs: entries,
            activeIndex,
        } satisfies PersistedChatHostTabs)).catch((error) => {
            this.dependencies.logger.appendLine(
                `[desktop state persistence error] ${errorMessage(error)}`,
            );
        });
    }

    private publishState(tabId: string): void {
        const state = this.host.getState(tabId);
        if (state) this.dependencies.emit({ type: 'stateSync', state }, tabId);
    }

    private publishModels(): void {
        const tab = this.host.activeTab;
        if (!tab) return;
        this.dependencies.emit({
            type: 'models',
            models: tab.session.getModels(),
            current: tab.session.getCurrentModel(),
            thinkingLevel: tab.session.getThinkingLevel(),
            favorites: [...this.favorites],
        }, tab.id);
    }

    private getProjectToolDefault(): ProjectToolSelectionDefault | undefined {
        return parseProjectToolSelectionDefault(
            this.dependencies.workspaceState.get<unknown>(PROJECT_TOOL_DEFAULT_KEY),
        );
    }

    private isTodoEnabled(tab: DesktopTab): boolean {
        const fallback = tab.projectToolDefault
            ? tab.projectToolDefault.enabled.includes('todo')
            : this.dependencies.defaults?.todoEnabled ?? true;
        return readSessionBoolean(
            this.dependencies.workspaceState,
            TODO_ENABLED_KEY_PREFIX,
            tab.session.sessionPath,
            fallback,
        );
    }

    private isSubagentsEnabled(tab: DesktopTab): boolean {
        const key = this.subagentGate.key(tab.session.sessionPath);
        const stored = key ? this.dependencies.workspaceState.get<unknown>(key) : undefined;
        if (typeof stored === 'boolean') return stored;
        if (tab.projectToolDefault) return tab.projectToolDefault.enabled.includes('subagent');
        return this.subagentGate.isEnabled(tab.session.sessionPath);
    }

    private isPlanModeEnabled(tab: DesktopTab): boolean {
        return readSessionBoolean(
            this.dependencies.workspaceState,
            PLAN_MODE_KEY_PREFIX,
            tab.session.sessionPath,
            this.dependencies.defaults?.planModeEnabled ?? false,
        );
    }

    private isFileUndoViewEnabled(tab: DesktopTab): boolean {
        return readSessionBoolean(
            this.dependencies.workspaceState,
            FILE_UNDO_VIEW_KEY_PREFIX,
            tab.session.sessionPath,
            this.dependencies.defaults?.fileUndoViewEnabled ?? false,
        );
    }

    private getDisabledTools(tab: DesktopTab): string[] {
        return readDisabledTools(
            this.dependencies.workspaceState,
            tab.session.sessionPath,
            tab.projectToolDefault,
            tab.session.getRegisteredToolsInfo().map((tool) => tool.name),
        );
    }

    private applyPersistedToolSelection(tab: DesktopTab): void {
        const disabled = composeEffectiveDisabledTools(
            this.getDisabledTools(tab),
            this.isTodoEnabled(tab),
            this.isSubagentsEnabled(tab),
        );
        tab.session.applyToolSelection(disabled);
    }

    private cachePolicyInput(tab: DesktopTab) {
        const model = tab.session.getCurrentModel();
        return {
            cacheMode: this.cacheMode,
            provider: model?.provider,
            modelId: model?.id,
            lastTurnEndAt: tab.lastTurnEndAt,
            maxIdleGapMs: tab.maxIdleGapMs,
            contextTokens: tab.session.serializeState().contextUsage?.tokens ?? 0,
            now: Date.now(),
        };
    }

    private computeEffectiveCache(tab: DesktopTab): CacheEffective {
        return computeEffectiveCache(this.cachePolicyInput(tab));
    }

    private prepareCacheForRequest(tab: DesktopTab): void {
        const prepared = prepareCacheForRequest(this.cachePolicyInput(tab));
        tab.maxIdleGapMs = prepared.maxIdleGapMs;
        tab.cacheEffective = prepared.effective;
        process.env.PI_CACHE_RETENTION = prepared.effective === 'long' ? 'long' : '';
    }

    private logPromptToolState(
        tab: DesktopTab,
        source: 'prompt' | 'queued' | 'steer' | 'followUp',
    ): void {
        const snapshot = tab.session.debugSnapshotTools();
        this.dependencies.logger.appendLine(
            `[${source}] tab="${tab.name || tab.id}" active-count=${snapshot.active.length} `
            + `todo=${snapshot.hasTodo} subagent=${snapshot.hasSubagent}`,
        );
    }

    private reportAgentIssue(
        tab: DesktopTab,
        message: string,
        severity: 'error' | 'warning' | 'info',
    ): void {
        if (tab.errorReportedThisRun) return;
        tab.errorReportedThisRun = true;
        if (severity === 'error') {
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
        }
        this.dependencies.emit({ type: 'error', message, severity }, tab.id);
    }

    private sweepPendingTools(tab: DesktopTab, assistant: any): void {
        if (tab.pendingTools.size === 0) return;
        const orphaned = collectOrphanedTools(tab.pendingTools, Date.now());
        tab.pendingTools.clear();
        for (const entry of orphaned) {
            this.dependencies.logger.appendLine(
                `[tool orphan] tab="${tab.name || tab.id}" tool=${entry.name} callId=${entry.id}`,
            );
        }
        if (assistant?.stopReason === 'aborted' || tab.errorReportedThisRun) return;
        const names = orphaned.map((entry) => entry.name).join(', ');
        this.reportAgentIssue(
            tab,
            `Tool calls did not report completion this turn (${names}). The response may be incomplete.`,
            'warning',
        );
    }
}

export function createDesktopChatRuntime(
    dependencies: DesktopChatRuntimeDependencies,
): DesktopChatRuntime {
    return new DesktopChatRuntime(dependencies);
}

export async function createProductionDesktopHost(
    options: ProductionDesktopHostOptions,
): Promise<DesktopChatRuntime> {
    if (!options.workspaceTrusted) {
        throw new Error('The desktop host cannot initialize an untrusted workspace.');
    }
    const workspace = new NodeSessionWorkspace(options.workspaceRoot, true);
    const workspaceRoot = workspace.getRoot();
    const logger = new NodeLogger(options.log);
    const stateRoot = path.join(options.appDataRoot, 'state');
    const workspaceKey = createHash('sha256').update(workspaceRoot).digest('hex');
    const stateLocks = new NodeSessionLock({
        applicationId: 'pi-code-desktop-state',
        staleAfterMs: 0,
    });
    const stateStoreOptions = { lock: stateLocks } as const;
    const workspaceState = await JsonStateStore.open(
        path.join(stateRoot, 'workspaces', `${workspaceKey}.json`),
        stateStoreOptions,
    );
    const globalState = options.globalState ?? await JsonStateStore.open(
        path.join(stateRoot, 'global.json'),
        stateStoreOptions,
    );
    const fileMentions = new NodeFileMentions({ workspaceRoot, logger });
    const fileState = new NodeWorkspaceFileState({
        workspaceRoot: () => workspaceRoot,
        cwd: () => workspaceRoot,
    });
    const subagentCoordinator = new SubagentCoordinator(options.subagentMaxConcurrency ?? 4);
    const subagentStore = new SubagentRunStore(options.appDataRoot);
    await subagentStore.initialize();
    const writeIsolation = new WriteIsolationManager(
        options.appDataRoot,
        (message) => logger.appendLine(message),
    );
    const childToolFactories = new ChildToolFactoryRegistry();
    const bundledPiPackagePaths = getBundledPiPackagePaths(
        options.packageRoot,
        (message) => logger.appendLine(message),
    );
    const sessionPorts = createNodeSessionRuntimePorts({
        workspace,
        settings: new DesktopSessionSettings(globalState, {
            ...options.sessionSettings,
            'lsp.enabled': false,
            'mcp.importClaudeCode': false,
        }),
        bundledPiPackagePaths,
        sessionLocks: new NodeSessionLock({ applicationId: 'pi-code-desktop' }),
    });
    const runtime = createDesktopChatRuntime({
        workspaceState,
        globalState,
        fileMentions,
        fileState,
        logger,
        defaults: options.defaults,
        emit: options.emit,
        createSession: () => new PiSessionManager(
            logger,
            options.secrets,
            subagentCoordinator,
            subagentStore,
            writeIsolation,
            childToolFactories,
            sessionPorts,
        ),
        disposeDependencies: async () => {
            fileMentions.dispose();
            subagentCoordinator.dispose();
            await Promise.all([
                workspaceState.flush(),
                flushStateStore(globalState),
            ]);
        },
    });
    await runtime.initialize();
    return runtime;
}

async function flushStateStore(state: StateStore): Promise<void> {
    const candidate = state as StateStore & { flush?: () => Promise<void> };
    await candidate.flush?.();
}

function parsePersistedTabs(value: unknown): PersistedChatHostTabs | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as { tabs?: unknown; activeIndex?: unknown };
    if (!Array.isArray(candidate.tabs)) return undefined;
    const tabs = candidate.tabs.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const tab = entry as { name?: unknown; sessionPath?: unknown };
        return typeof tab.name === 'string'
            && typeof tab.sessionPath === 'string'
            && tab.sessionPath.length > 0
            ? [{ name: tab.name, sessionPath: tab.sessionPath }]
            : [];
    });
    return {
        tabs,
        activeIndex: typeof candidate.activeIndex === 'number'
            ? Math.max(0, Math.trunc(candidate.activeIndex))
            : 0,
    };
}

function createTabId(): string {
    return `desktop-${randomUUID()}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
