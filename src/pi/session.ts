import * as process from 'node:process';
import type { AgentSession, AgentSessionEvent, ModelRegistry, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../core/ports/logger';
import { NOOP_PERF_LOGGER, type PerfLogger } from '../core/ports/perf-logger';
import {
    DEFAULT_SESSION_RUNTIME_PORTS,
    type SecretStore,
    type SessionLockHandle,
    type SessionRuntimePorts,
} from '../core/ports/session-platform';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo, SkillInfo, ImageAttachment, FileAttachment } from '../shared/protocol';
import { TypedEventEmitter } from '../shared/typed-event';
import { safeSerialize } from '../shared/safe-serialize';
import {
    TURN_LIFECYCLE_CUSTOM_TYPE,
    getLatestTurnLifecycleStatus,
    hasIncompleteTurnTail,
} from '../shared/interrupted-turn';
import { EventRouter } from './events';
import { createRawRecorderExtension } from './raw-recorder-extension';
import { RawRecorder, RawRecorderRegistry } from '../core/raw/raw-recorder';
import type { RawStoragePort } from '../core/ports/raw-storage';
import { RAW_SESSION_ONLY_EVENT_KINDS } from '../shared/raw-protocol';
import { getAuthStorage, disposeAuthStorage, reloadCredentials } from './auth';
import { getModelRegistry, getAvailableModels, findModel, refreshModelRegistry, disposeModelRegistry } from './models';
import { createCodexMonitorExtension } from './codex-monitor';
import { getStandardSkillPaths } from './standard-resources';
import { createClaudeContextExtension } from './claude-compat/context-extension';
import { getRootClaudeFiles } from './claude-compat/context';
import { retainNativePiContextFiles } from './claude-compat/boundary';
import { detectClaudeInfrastructure } from './claude-compat/detect';
import type { ClaudeInfrastructure } from './claude-compat/types';
import { CLAUDE_NESTED_SEARCH_EXCLUDE } from './claude-compat/discovery';
import { indexClaudeRules } from './claude-compat/rules';
import { indexClaudeResources } from './claude-compat/resources';
import { indexClaudeAgents } from './subagents/claude-agents';
import { indexPackageAgents } from './subagents/package-agents';
import { createTodoExtension } from './todo/extension';
import { TodoStore } from './todo/store';
import { parseTodoPromptGuidelines } from './todo/tool';
import { installEditToolPreflight } from './tools/preflight-edit';
import { createToolSelectionGuard } from './tool-selection-guard';
import { isContextUsageEstimated } from './context-usage';
import type { SubagentCoordinator } from './subagents/coordinator';
import { SubagentManager } from './subagents/manager';
import { PiChildSessionFactory, CHILD_SAFE_TOOLS } from './subagents/pi-child-session';
import { PiSessionRuntime, type PiSessionRuntimeState } from './session-runtime';
import { AgentRegistry } from './subagents/registry';
import { resolveAgentSpec } from './subagents/resolver';
import { createSubagentExtension } from './subagents/extension';
import type { SubagentInvocation, SubagentRun } from './subagents/types';
import type {
    SubagentExecutionResult, SubagentForegroundResult, SubagentManagerSnapshot,
} from './subagents/runtime';
import type {
    SubagentControlResult, SubagentToolDetails, SubagentToolParams,
} from './subagents/tool';
import type { SubagentRunStore } from './subagents/persistence';
import type { WriteIsolationManager } from './subagents/write-isolation';
import type { ChildToolFactoryRegistry } from './subagents/child-tools';

interface CreatedSessionRuntime extends PiSessionRuntimeState {
    cwd: string;
    modelFallbackMessage?: string;
}

type SessionCreationKind = 'initial' | 'restore' | 'new' | 'load';

export class PiSessionManager {
    private static readonly _instances = new Set<PiSessionManager>();
    private readonly _runtime: PiSessionRuntime;
    private _modelRegistry: ModelRegistry | undefined;
    private _outputChannel: Logger;
    private _secrets: SecretStore | undefined;
    readonly events = new EventRouter();
    readonly todoStore = new TodoStore();
    private _subagentManager: SubagentManager | undefined;
    private _subagentManagerUnsubscribe?: () => void;
    private readonly _onSubagentStateChanged = new TypedEventEmitter<SubagentManagerSnapshot>();
    readonly onSubagentStateChanged = this._onSubagentStateChanged.event;
    private readonly _onSubagentMutation = new TypedEventEmitter<any>();
    readonly onSubagentMutation = this._onSubagentMutation.event;
    private readonly _onSubagentNotification = new TypedEventEmitter<void>();
    readonly onSubagentNotification = this._onSubagentNotification.event;
    private readonly _pendingBackgroundNotifications: Array<{ content: string; details: Record<string, unknown> }> = [];
    private _backgroundNotificationUnsubscribe?: () => void;
    private _subagentParentTabId = 'unbound';
    private _lifecycleTransition?: Promise<unknown>;
    private _disposePromise?: Promise<void>;
    private _shutdownPromise?: Promise<void>;
    private _disposeRequested = false;
    private _shutdownRequested = false;
    private _turnLifecycleOpen = false;

    private _currentRawRecorder: RawRecorder | undefined;
    private readonly _rawSessionOnlyEventKinds: Set<string> = new Set(RAW_SESSION_ONLY_EVENT_KINDS);

    constructor(
        outputChannel: Logger,
        secrets?: SecretStore,
        private readonly _subagentCoordinator?: SubagentCoordinator,
        private readonly _subagentStore?: SubagentRunStore,
        private readonly _writeIsolation?: WriteIsolationManager,
        private readonly _childToolFactories?: ChildToolFactoryRegistry,
        private readonly _ports: SessionRuntimePorts = DEFAULT_SESSION_RUNTIME_PORTS,
        private readonly _rawStorage?: RawStoragePort,
        private readonly _rawRecorderRegistry?: RawRecorderRegistry,
        private readonly _perf: PerfLogger = NOOP_PERF_LOGGER,
    ) {
        this._outputChannel = outputChannel;
        this._secrets = secrets;
        PiSessionManager._instances.add(this);
        this._runtime = new PiSessionRuntime(
            (session) => session.subscribe(this.events.asSessionListener()),
        );
        this._backgroundNotificationUnsubscribe = this.events.onAll((event) => {
            if (event.type === 'agent_end') this._flushBackgroundSubagentNotifications();
            const recorder = this._currentRawRecorder;
            if (recorder && this._isRawModeEnabled() && this._rawSessionOnlyEventKinds.has(event.type)) {
                // Session-listener-only kinds are relayed through the shared
                // EventRouter so nothing is lost when ExtensionAPI does not
                // emit them. Overlapping harness kinds arrive separately from
                // pi.on(...) inside the inline extension and are intentionally
                // not deduplicated — RawMode records verbatim.
                recorder.record(event.type, event);
            }
        });
    }

    get logger(): Logger {
        return this._outputChannel;
    }

    get perf(): PerfLogger {
        return this._perf;
    }

    get ports(): SessionRuntimePorts {
        return this._ports;
    }

    get secrets(): SecretStore | undefined {
        return this._secrets;
    }

    /** Shared JSONL storage for RawMode. Undefined when the host does not provide RawMode services. */
    get rawStorage(): RawStoragePort | undefined {
        return this._rawStorage;
    }

    /** Process-wide RawMode recorder registry. Undefined when the host does not provide RawMode services. */
    get rawRecorderRegistry(): RawRecorderRegistry | undefined {
        return this._rawRecorderRegistry;
    }

    async reloadCredentials(): Promise<void> {
        await reloadCredentials();
    }

    private _getCwd(): string {
        return this._ports.workspace.getRoot() ?? process.cwd();
    }

    private get _session(): AgentSession | undefined {
        return this._runtime.session;
    }

    private get _sessionManager() {
        return this._runtime.sessionManager;
    }

    get session(): AgentSession | undefined {
        return this._runtime.session;
    }

    get isReady(): boolean {
        return this._runtime.isReady;
    }

    get isStreaming(): boolean {
        return this._session?.isStreaming ?? false;
    }

    async initialize(): Promise<void> {
        return this._perf.time('session.initialize', async () => this._runLifecycleTransition(async () => {
            this._outputChannel.appendLine('Initializing Pi session...');
            const state = await this._runtime.start(() => this._createSessionRuntime('initial'));
            await this._completeCandidateActivation(async () => {
                await this._perf.time('session.activateRuntime', () => this._activateSessionRuntime(state));

                if (state.modelFallbackMessage) {
                    this._outputChannel.appendLine(`Model fallback: ${state.modelFallbackMessage}`);
                }
                await this._perf.time('session.applyDefaultSettings', () => this._applyDefaultSettings(state.session));
            });

            // Initial todo visibility is decided by the controller from the
            // per-session persisted toggle (see ChatController._subscribeTab
            // and _applyPersistedTodo). The SDK enables all extension tools
            // by default via `includeAllExtensionTools: true`, so doing
            // nothing here leaves `todo` ON and the controller flips it
            // OFF only when the user explicitly toggled it off for this
            // session.

            const model = state.session.model;
            this._outputChannel.appendLine(
                `Pi session initialized. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
            );
        }));
    }

    /**
     * Show or hide the `todo` tool from the LLM. When hidden, the
     * model sees no schema and no promptGuidelines for it — the system
     * prompt is rebuilt without any todo-related copy
     * (pi-coding-agent/agent-session.js:631 _rebuildSystemPrompt).
     * The tool stays registered either way, so its accumulated state
     * in the conversation branch survives toggles and is restored by
     * the next replay.
     *
     * Idempotent — passing the current visibility is a no-op.
     */
    /** All tools currently in the session registry (anything that can be
     *  activated). Includes built-ins, bundled Pi packages, and dynamically
     *  registered extension tools (`todo`, MCP-adapted tools, LSP tools).
     *  Sorted alphabetically for stable UI rendering. */
    getRegisteredToolNames(): string[] {
        const session = this._session;
        if (!session) return [];
        return session.getAllTools().map((t) => t.name).sort();
    }

    /** Registered-tool metadata: `name`, `description` (the same one shown to
     *  the LLM), source label from `sourceInfo`, and a `hasGuidelines` flag
     *  when the tool ships with promptGuidelines beyond the description.
     *  Used to populate tooltips in the Tools panel. Sorted by name. */
    getRegisteredToolsInfo(): Array<{
        name: string;
        description?: string;
        source?: string;
        hasGuidelines?: boolean;
    }> {
        const session = this._session;
        if (!session) return [];
        return session.getAllTools()
            .map((t: any) => {
                const guidelines = t.promptGuidelines;
                const source: string | undefined = t.sourceInfo?.source;
                return {
                    name: String(t.name),
                    description: typeof t.description === 'string' ? t.description : undefined,
                    source,
                    hasGuidelines: Array.isArray(guidelines) && guidelines.length > 0,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Apply a per-tab denylist to the active-tools set. Active tools become
     * `registered - disabled` (case-sensitive name match). Names in `disabled`
     * that are not currently in the registry are silently skipped — but the
     * caller should still store them so the disable is preserved if the tool
     * comes back later (e.g. an MCP server re-added).
     */
    applyToolSelection(disabled: readonly string[]): void {
        const session = this._session;
        if (!session) {
            this._outputChannel.appendLine('[tool selection] session=<none> — skipped');
            return;
        }
        const registered = session.getAllTools().map((t) => t.name);
        const disabledSet = new Set(disabled);
        const fullActive = registered.filter((t) => !disabledSet.has(t));
        session.setActiveToolsByName(fullActive);
        const after = session.getActiveToolNames();
        this._outputChannel.appendLine(
            `[tool selection] disabled-count=${disabledSet.size} ` +
            `registered=${registered.length} active-after=${after.length}`,
        );
    }

    /** Diagnostic helper — snapshot of the current active-tool set, exposed for
     *  the controller to log at prompt time and after persisted-toggle apply. */
    debugSnapshotTools(): {
        active: string[];
        hasTodo: boolean;
        todoRegistered: boolean;
        hasSubagent: boolean;
        subagentRegistered: boolean;
    } {
        const session = this._session;
        if (!session) {
            return {
                active: [], hasTodo: false, todoRegistered: false,
                hasSubagent: false, subagentRegistered: false,
            };
        }
        const active = session.getActiveToolNames();
        const registered = session.getAllTools().map((tool) => tool.name);
        return {
            active,
            hasTodo: active.includes('todo'),
            todoRegistered: registered.includes('todo'),
            hasSubagent: active.includes('subagent'),
            subagentRegistered: registered.includes('subagent'),
        };
    }

    private async _createSessionRuntime(
        kind: SessionCreationKind,
        sessionPath?: string,
    ): Promise<CreatedSessionRuntime> {
        return this._perf.time('session.createRuntime', () => this._createSessionRuntimeInner(kind, sessionPath), { kind });
    }

    private async _createSessionRuntimeInner(
        kind: SessionCreationKind,
        sessionPath?: string,
    ): Promise<CreatedSessionRuntime> {
        const { createAgentSession, SessionManager: SM } = await this._perf.time(
            'session.createRuntime.sdkImport',
            () => import('@earendil-works/pi-coding-agent'),
        );
        const cwd = this._getCwd();
        // Bundled extensions like pi-mcp-adapter discover project config files via process.cwd()
        // (e.g. ".mcp.json", ".pi/mcp.json"). In the VS Code extension host process.cwd() is
        // typically the VS Code install directory, not the workspace, so those configs are missed.
        // Chdir to the workspace folder so adapters resolve project files correctly.
        try { if (cwd && process.cwd() !== cwd) { process.chdir(cwd); } } catch { /* ignore — non-fatal */ }

        let authStorage;
        if (kind === 'initial' || kind === 'restore') {
            authStorage = await this._perf.time(
                'session.createRuntime.getAuthStorage',
                () => getAuthStorage(this._secrets),
            );
            this._modelRegistry = await this._perf.time(
                'session.createRuntime.getModelRegistry',
                () => getModelRegistry(
                    (message) => this._outputChannel.appendLine(message),
                ),
            );
        } else {
            await this._perf.time(
                'session.createRuntime.refreshModelRegistry',
                () => refreshModelRegistry((message) => this._outputChannel.appendLine(message)),
            );
        }

        if ((kind === 'restore' || kind === 'load') && !sessionPath) {
            throw new Error(`Session path is required for ${kind}`);
        }
        let sessionLock: SessionLockHandle | undefined;
        let candidateSession: AgentSession | undefined;
        let candidateRawRecorder: RawRecorder | undefined;
        try {
            let sessionManager;
            let concreteSessionPath: string;
            if (kind === 'initial' || kind === 'new') {
                sessionManager = this._perf.timeSync('session.createRuntime.sessionManager.create', () => SM.create(cwd));
                const createdSessionPath = sessionManager.getSessionFile();
                if (!createdSessionPath) {
                    throw new Error('Writable Pi session did not provide a session file path.');
                }
                sessionLock = await this._perf.time(
                    'session.createRuntime.sessionLock.acquire',
                    () => this._ports.sessionLocks.acquire(createdSessionPath),
                );
                concreteSessionPath = createdSessionPath;
            } else {
                // SessionManager.open() may migrate and rewrite an older session, so
                // existing sessions must be locked before the SDK opens them.
                sessionLock = await this._perf.time(
                    'session.createRuntime.sessionLock.acquire',
                    () => this._ports.sessionLocks.acquire(sessionPath!),
                );
                sessionManager = this._perf.timeSync(
                    'session.createRuntime.sessionManager.open',
                    () => SM.open(sessionPath!, undefined),
                );
                concreteSessionPath = sessionPath!;
            }
            const allowedTools = kind === 'load'
                ? []
                : this._ports.settings.get('allowedTools', []);
            // Retire any previous recorder before creating a new one; the
            // previous session file will keep its persisted JSONL and can be
            // resumed later via storage.getNextSeq() when reopened.
            await this._perf.time('session.createRuntime.retireRawRecorder', () => this._retireCurrentRawRecorder());
            candidateRawRecorder = await this._perf.time(
                'session.createRuntime.createRawRecorder',
                () => this._createRawRecorderFor(concreteSessionPath),
            );
            const resourceLoader = await this._perf.time(
                'session.createRuntime.buildResourceLoader',
                () => this._buildResourceLoader(cwd, candidateRawRecorder),
            );
            authStorage ??= await this._perf.time(
                'session.createRuntime.getAuthStorage',
                () => getAuthStorage(this._secrets),
            );

            const opts: any = {
                cwd,
                authStorage,
                modelRegistry: this._modelRegistry,
                sessionManager,
                resourceLoader,
            };
            if (allowedTools.length > 0) {
                opts.tools = allowedTools;
            }
            if (candidateRawRecorder) {
                // Raw stream chunks + final response go through SimpleStreamOptions,
                // not through pi.on(...), so they are captured here instead of in
                // the inline Pi extension factory. The setting is read for every
                // callback so active sessions stop and resume capture immediately.
                const recorder = candidateRawRecorder;
                opts.onPayload = (chunk: unknown) => {
                    if (this._isRawModeEnabled()) recorder.record('stream_chunk', chunk);
                };
                opts.onResponse = (response: unknown) => {
                    if (this._isRawModeEnabled()) recorder.record('stream_response', response);
                };
            }

            const { session, modelFallbackMessage } = await this._perf.time(
                'session.createRuntime.createAgentSession',
                () => createAgentSession(opts),
            );
            candidateSession = session;
            await this._perf.time('session.createRuntime.bindExtensions', () => this._bindExtensions(session));
            if (candidateRawRecorder) {
                this._currentRawRecorder = candidateRawRecorder;
            }
            return { session, sessionManager, sessionLock, cwd, modelFallbackMessage };
        } catch (error) {
            try {
                candidateSession?.dispose();
            } catch {
                // Preserve the creation error while attempting complete candidate cleanup.
            }
            try {
                await sessionLock?.release();
            } catch {
                // Preserve the creation error; a surviving sidecar remains safely locked.
            }
            if (candidateRawRecorder) {
                try {
                    this._rawRecorderRegistry?.rebind(candidateRawRecorder.sessionPath, candidateRawRecorder);
                    await this._rawRecorderRegistry?.dispose(candidateRawRecorder.sessionPath);
                    if (!this._rawRecorderRegistry) {
                        await candidateRawRecorder.close();
                    }
                } catch {
                    // Best-effort cleanup; do not shadow the original error.
                }
            }
            throw error;
        }
    }

    private async _createRawRecorderFor(concreteSessionPath: string): Promise<RawRecorder | undefined> {
        if (!this._rawStorage) return undefined;
        const initialSeq = await this._rawStorage.getNextSeq(concreteSessionPath).catch(() => 0);
        const recorder = new RawRecorder({
            storage: this._rawStorage,
            logger: this._outputChannel,
            sessionPath: concreteSessionPath,
            initialSeq,
        });
        if (this._isRawModeEnabled()) {
            recorder.record('recorder_meta', {
                kind: 'recorder_start',
                capturedAtMs: Date.now(),
            });
        }
        this._rawRecorderRegistry?.register(recorder);
        return recorder;
    }

    private _isRawModeEnabled(): boolean {
        return this._ports.settings.get('rawMode.enabled', false);
    }

    private async _retireCurrentRawRecorder(): Promise<void> {
        const existing = this._currentRawRecorder;
        if (!existing) return;
        this._currentRawRecorder = undefined;
        try {
            if (this._rawRecorderRegistry) {
                await this._rawRecorderRegistry.dispose(existing.sessionPath);
            } else {
                await existing.close();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this._outputChannel.appendLine(`Raw recorder close failed: ${message}`);
        }
    }

    private async _activateSessionRuntime(state: CreatedSessionRuntime): Promise<void> {
        await this._resetSubagentManager(state.cwd, state.session);
    }

    private async _completeCandidateActivation(
        activate: () => Promise<void>,
    ): Promise<void> {
        try {
            await activate();
        } catch (error) {
            try {
                await this._runtime.clear();
            } catch {
                // Preserve the activation failure while completing safe teardown where possible.
            }
            throw error;
        }
    }

    private async _buildResourceLoader(cwd: string, rawRecorder?: RawRecorder): Promise<ResourceLoader> {
        const { DefaultResourceLoader, getAgentDir, SettingsManager } = await import('@earendil-works/pi-coding-agent');
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(cwd, agentDir);
        // Guidelines are read here (per resource-loader rebuild) so a
        // settings change picks up next time `_buildResourceLoader`
        // runs — i.e. on the next chat / loadSession / newSession /
        // window reload. The currently-running agent session keeps
        // whatever guidelines it was created with, since the SDK
        // captures tool definitions at session-creation time.
        const todoGuidelines = parseTodoPromptGuidelines(
            this._ports.settings.get('todo.promptGuidelines', undefined),
        );
        const lspEnabled = this._ports.settings.get('lsp.enabled', false);
        const importClaudeCodeMcp = this._ports.settings.get('mcp.importClaudeCode', false);
        const syncClaudeCodeMcpImport = this._ports.extensions?.syncClaudeCodeMcpImport;
        if (syncClaudeCodeMcpImport) {
            try {
                const result = syncClaudeCodeMcpImport(importClaudeCodeMcp);
                if (result.changed) {
                    this._outputChannel.appendLine(
                        `Claude Code MCP import ${importClaudeCodeMcp ? 'enabled' : 'disabled'} in ${result.path}.`,
                    );
                }
            } catch (error) {
                this._outputChannel.appendLine(
                    `Claude Code MCP import sync failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        const bundledPackagePaths = [...this._ports.resources.bundledPiPackagePaths];
        const standardSkillPaths = getStandardSkillPaths(cwd);
        const claudeCompatEnabled = this._ports.settings.get('claudeCompat.enabled', true);
        const rawClaudeCompatMode = this._ports.settings.get('claudeCompat.mode', 'auto');
        const claudeCompatMode: 'auto' | 'on' | 'off' =
            rawClaudeCompatMode === 'on' || rawClaudeCompatMode === 'off' ? rawClaudeCompatMode : 'auto';
        const claudeCompatActive = claudeCompatEnabled && claudeCompatMode !== 'off';
        const claudeInfrastructure = claudeCompatActive
            ? await this._perf.time('session.buildResourceLoader.detectClaudeInfrastructure', () => detectClaudeInfrastructure(cwd, {
                collectNestedClaudeFiles: true,
                collectNestedClaudeSkillFiles: true,
                collapseShimContext: claudeCompatMode !== 'on',
                findNestedClaudeFiles: () => this._ports.workspace.findFiles(
                    cwd,
                    '**/{CLAUDE.md,CLAUDE.local.md}',
                    CLAUDE_NESTED_SEARCH_EXCLUDE,
                    1,
                ),
                findNestedClaudeSkillFiles: () => this._ports.workspace.findFiles(
                    cwd,
                    '**/.claude/skills/**/SKILL.md',
                    CLAUDE_NESTED_SEARCH_EXCLUDE,
                    500,
                ),
            }))
            : ({
                active: false,
                activationReasons: [],
                rootContextFiles: [],
                shimContextFiles: [],
                nestedContextFiles: [],
                nestedSkillFiles: [],
                skillDirectories: [],
                commandDirectories: [],
                agentDirectories: [],
                ruleDirectories: [],
                pluginInstalls: [],
            } satisfies ClaudeInfrastructure);
        if (!claudeCompatEnabled) {
            this._outputChannel.appendLine('Claude compatibility disabled: pi-code.claudeCompat.enabled=false');
        } else if (claudeCompatMode === 'off') {
            this._outputChannel.appendLine('Claude compatibility disabled: pi-code.claudeCompat.mode=off');
        }
        const availableChildTools = [
            ...CHILD_SAFE_TOOLS,
            ...(this._childToolFactories?.listNames() ?? []),
        ];
        const claudeAgents = claudeInfrastructure.active
            ? await this._perf.time('session.buildResourceLoader.indexClaudeAgents', () => indexClaudeAgents({
                cwd,
                workspaceTrusted: this._ports.workspace.isTrusted(),
                availableChildTools,
                projectAgentDirectories: claudeInfrastructure.agentDirectories,
            }))
            : { definitions: [], diagnostics: [] };
        const packageAgents = await this._perf.time(
            'session.buildResourceLoader.indexPackageAgents',
            () => indexPackageAgents(bundledPackagePaths),
        );
        const subagentRegistry = new AgentRegistry({
            cwd,
            workspaceTrusted: this._ports.workspace.isTrusted(),
            packageDefinitions: packageAgents.definitions,
            claudeDefinitions: claudeAgents.definitions,
            additionalDiagnostics: [...packageAgents.diagnostics, ...claudeAgents.diagnostics],
        });
        const subagentRegistrySnapshot = await this._perf.time(
            'session.buildResourceLoader.subagentRegistry.reload',
            () => subagentRegistry.reload(),
        );
        for (const diagnostic of subagentRegistrySnapshot.diagnostics) {
            this._outputChannel.appendLine(
                `[subagent definition] severity=${diagnostic.severity} code=${diagnostic.code} ` +
                `path=${diagnostic.filePath ?? '(none)'} message=${diagnostic.message}`,
            );
        }
        const lspExtension = this._ports.extensions?.createLspExtension(lspEnabled);
        const factories = [
            createCodexMonitorExtension({
                onResponse: ({ headers }) => {
                    this._ports.codexUsage.updateFromHeaders(headers);
                },
            }),
            ...(rawRecorder ? [createRawRecorderExtension(rawRecorder, () => this._isRawModeEnabled())] : []),
            createTodoExtension(this.todoStore, todoGuidelines),
            ...(lspExtension ? [lspExtension] : []),
            createToolSelectionGuard((gateway, target) => {
                this._outputChannel.appendLine(
                    `[tool selection] blocked gateway=${gateway} target=${target} reason=disabled`,
                );
            }),
            createSubagentExtension({
                definitions: subagentRegistrySnapshot.definitions,
                execute: (invocation, signal, onProgress) =>
                    this._executeSubagentInvocation(subagentRegistry, invocation, signal, onProgress),
                control: (action, params, signal, onProgress) =>
                    this._executeSubagentControl(action, params, signal, onProgress),
            }),
        ];
        if (claudeInfrastructure.active) {
            // User-level Claude context is inspected only after a project marker
            // activates compatibility, preserving the inactive-project boundary.
            const contextEnabled = claudeInfrastructure.rootContextFiles.length > 0 ||
                claudeInfrastructure.nestedContextFiles.length > 0 ||
                getRootClaudeFiles(cwd).length > 0;
            const rulesEnabled = claudeInfrastructure.ruleDirectories.length > 0 ||
                indexClaudeRules(cwd).rules.length > 0;
            const resources = indexClaudeResources(cwd, {
                projectSkillDirectories: claudeInfrastructure.skillDirectories,
                projectSkillFiles: claudeInfrastructure.nestedSkillFiles,
                projectCommandDirectories: claudeInfrastructure.commandDirectories,
            });
            factories.push(createClaudeContextExtension({ contextEnabled, rulesEnabled, resources }));
            this._outputChannel.appendLine(
                `Claude compatibility activated: ${claudeInfrastructure.activationReasons.join(', ')} ` +
                `(context=${contextEnabled}, rules=${rulesEnabled}, skills=${resources.skills.length}, commands=${resources.commands.length})`,
            );
        }
        const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            extensionFactories: factories,
            additionalExtensionPaths: bundledPackagePaths,
            // Agent Skills recommends .agents/skills as the cross-client user
            // and project location. Keep Pi's native .pi/skills discovery as a legacy path.
            additionalSkillPaths: standardSkillPaths,
            // Pi natively treats CLAUDE.md as an AGENTS.md-equivalent system
            // context file. Always remove only Claude-authored files from that
            // unbounded path: active projects receive them through the bridge,
            // while inactive projects retain the zero-Claude-content invariant.
            // Native AGENTS.md files remain untouched.
            agentsFilesOverride: (base) => ({
                agentsFiles: retainNativePiContextFiles(base.agentsFiles),
            }),
        });
        await this._perf.time(
            'session.buildResourceLoader.loader.reload',
            () => loader.reload(),
            { bundledPackages: bundledPackagePaths.length, additionalSkills: standardSkillPaths.length },
        );
        if (bundledPackagePaths.length > 0) {
            this._outputChannel.appendLine(
                `Bundled Pi packages registered: ${bundledPackagePaths.length} (${bundledPackagePaths.map((p) => p.split(/[\\/]/).pop()).join(', ')})`,
            );
        }
        return loader;
    }

    // Fires session_start to extensions (e.g. pi-mcp-adapter requires this to initialize its server registry).
    // Mirrors the bindExtensions call that print-mode / interactive-mode / rpc-mode do internally.
    // Without this, bundled extensions stay in their initial state and tools registered via session_start never appear.
    private async _bindExtensions(session: AgentSession): Promise<void> {
        const bindings: any = {
            commandContextActions: {
                waitForIdle: () => session.agent.waitForIdle(),
                reload: async () => { await session.reload(); },
                newSession: async () => undefined,
                fork: async () => ({ cancelled: false }),
                navigateTree: async () => ({ cancelled: false }),
                switchSession: async () => undefined,
            },
            onError: (err: any) => {
                this._outputChannel.appendLine(
                    `Extension error (${err.extensionPath}): ${err.error}`,
                );
            },
        };
        await session.bindExtensions(bindings);
        installEditToolPreflight(session, this._outputChannel);
    }

    private async _applyDefaultSettings(session: AgentSession): Promise<void> {
        const thinkingLevel = this._ports.settings.get('thinkingLevel', 'off');
        if (thinkingLevel && thinkingLevel !== 'off') {
            session.setThinkingLevel(thinkingLevel as any);
        }

        const defaultModel = this._ports.settings.get('defaultModel', '');
        if (defaultModel && this._modelRegistry) {
            const available = getAvailableModels(this._modelRegistry);
            const match = available.find(m => m.id === defaultModel);
            if (match) {
                const model = findModel(this._modelRegistry, match.provider, match.id);
                if (model) {
                    try {
                        await session.setModel(model);
                    } catch (err: any) {
                        this._outputChannel.appendLine(`Failed to set default model: ${err.message}`);
                    }
                }
            }
        }
    }

    async prompt(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        const augmentedText = this._augmentTextWithFiles(text, files);
        this.markTurnStarted();
        try {
            await this._session.prompt(augmentedText, images?.length ? { images } : undefined);
        } catch (error) {
            if (!this._session.isStreaming) this.markTurnCompleted();
            throw error;
        }
    }

    async steer(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        const augmentedText = this._augmentTextWithFiles(text, files);
        await this._session.steer(augmentedText, images?.length ? images : undefined);
    }

    async followUp(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        const augmentedText = this._augmentTextWithFiles(text, files);
        await this._session.followUp(augmentedText, images?.length ? images : undefined);
    }

    /** Prefix the prompt text with file contents (decoded from base64). Binary files get a note instead. */
    private _augmentTextWithFiles(text: string, files?: FileAttachment[]): string {
        if (!files?.length) return text;
        const parts: string[] = [];
        for (const file of files) {
            if (file.binary) {
                parts.push(`[File: ${file.name}] (binary file)\n[/File]\n`);
            } else {
                const content = Buffer.from(file.data, 'base64').toString('utf-8');
                parts.push(`[File: ${file.name}]\n${content}\n[/File]\n`);
            }
        }
        return parts.join('') + text;
    }

    async compact(customInstructions?: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        this.markTurnStarted();
        try {
            await this._session.compact(customInstructions);
            this.markTurnCompleted();
        } catch (error) {
            if (!this._session.isCompacting) this.markTurnCompleted();
            throw error;
        }
    }

    async abort(): Promise<void> {
        if (!this._session) { return; }
        await this._session.abort();
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        if (!this._session || !this._modelRegistry) {
            throw new Error('Session not initialized');
        }
        const model = findModel(this._modelRegistry, provider, modelId);
        if (!model) {
            throw new Error(`Model not found: ${provider}/${modelId}`);
        }
        await this._session.setModel(model);
    }

    setThinkingLevel(level: string): void {
        if (!this._session) { return; }
        this._session.setThinkingLevel(level as any);
    }

    cycleThinkingLevel(): string | undefined {
        if (!this._session) { return undefined; }
        return this._session.cycleThinkingLevel();
    }

    async newSession(): Promise<void> {
        return this._runLifecycleTransition(async () => {
            if (!this._runtime.isReady) { return; }
            await this._subagentManager?.dispose();
            this._subagentManager = undefined;
            const state = await this._runtime.replace(() => this._createSessionRuntime('new'));
            await this._completeCandidateActivation(async () => {
                await this._activateSessionRuntime(state);
                await this._applyDefaultSettings(state.session);
            });
        });
    }

    get sessionPath(): string | undefined {
        return this._sessionManager?.getSessionFile();
    }

    async initializeFromPath(sessionPath: string): Promise<void> {
        return this._perf.time('session.initializeFromPath', async () => this._runLifecycleTransition(async () => {
            this._outputChannel.appendLine(`Restoring session from ${sessionPath}...`);
            const state = await this._runtime.start(
                () => this._createSessionRuntime('restore', sessionPath),
            );
            await this._completeCandidateActivation(async () => {
                await this._perf.time('session.activateRuntime', () => this._activateSessionRuntime(state));
                await this._perf.time('session.applyDefaultSettings', () => this._applyDefaultSettings(state.session));
            });

            const model = state.session.model;
            this._outputChannel.appendLine(
                `Session restored. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
            );
        }));
    }

    async getSessions(): Promise<SessionInfo[]> {
        const { SessionManager: SM } = await import('@earendil-works/pi-coding-agent');
        const cwd = this._getCwd();
        // Bundled extensions like pi-mcp-adapter discover project config files via process.cwd()
        // (e.g. ".mcp.json", ".pi/mcp.json"). In the VS Code extension host process.cwd() is
        // typically the VS Code install directory, not the workspace, so those configs are missed.
        // Chdir to the workspace folder so adapters resolve project files correctly.
        try { if (cwd && process.cwd() !== cwd) { process.chdir(cwd); } } catch { /* ignore — non-fatal */ }
        const sessions = await SM.list(cwd);
        return sessions.map((s: any) => ({
            id: s.id ?? s.sessionId ?? '',
            name: s.name ?? s.sessionName,
            firstMessage: s.firstMessage,
            path: s.path ?? s.filePath ?? '',
            lastModified: s.lastModified ?? s.modifiedAt,
        }));
    }

    async loadSession(sessionPath: string): Promise<void> {
        return this._runLifecycleTransition(async () => {
            if (!this._runtime.isReady) { return; }
            await this._subagentManager?.dispose();
            this._subagentManager = undefined;
            const state = await this._runtime.replace(
                () => this._createSessionRuntime('load', sessionPath),
            );
            await this._completeCandidateActivation(() => this._activateSessionRuntime(state));
        });
    }

    getModels(): ModelInfo[] {
        if (!this._modelRegistry) { return []; }
        return getAvailableModels(this._modelRegistry);
    }

    getCurrentModel(): ModelInfo | undefined {
        const m: any = this._session?.model;
        if (!m) { return undefined; }
        return {
            provider: getProviderId(m),
            id: m.id,
            name: m.name,
            supportsImages: Array.isArray(m.input) ? m.input.includes('image') : undefined,
        };
    }

    /** Copy refreshed registry metadata onto an already-open session model. */
    refreshCurrentModelMetadata(): boolean {
        const current: any = this._session?.model;
        if (!current || !this._modelRegistry) return false;
        const refreshed: any = findModel(this._modelRegistry, getProviderId(current), current.id);
        if (!refreshed || refreshed.contextWindow === current.contextWindow) return false;
        current.contextWindow = refreshed.contextWindow;
        return true;
    }

    getThinkingLevel(): string | undefined {
        return this._session?.thinkingLevel;
    }

    getSkills(): SkillInfo[] {
        if (!this._session) return [];
        try {
            const { skills } = this._session.resourceLoader.getSkills();
            return skills.map((s: any) => ({
                name: s.name,
                description: s.description ?? '',
                filePath: s.filePath ?? '',
                source: s.sourceInfo?.source ?? '',
                disableModelInvocation: s.disableModelInvocation ?? false,
            }));
        } catch {
            return [];
        }
    }

    /** Commands currently mounted by SDK extensions. Temporary diagnostics use
     * this to verify that capability-gated extensions were actually loaded. */
    getCommands(): Array<{ name: string; description?: string; source: string }> {
        if (!this._session) return [];
        try {
            return this._session.resourceLoader.getExtensions().extensions.flatMap((extension) =>
                Array.from(extension.commands.values(), (command) => ({
                    name: command.name,
                    description: command.description,
                    source: command.sourceInfo.source,
                })),
            );
        } catch {
            return [];
        }
    }

    /** Execute an SDK slash command. Diagnostic commands stay local; adapted
     * workflow commands may intentionally submit their bounded prompt. */
    async executeSlashCommand(command: string): Promise<void> {
        if (!this._session) throw new Error('Session not initialized');
        await this._session.prompt(command);
    }

    /** Set the persisted display name of the current Pi session. */
    setSessionName(name: string): void {
        if (!this._session) throw new Error('Session not initialized');
        this._session.setSessionName(name);
    }

    getActiveToolNames(): string[] {
        return this._session?.getActiveToolNames() ?? [];
    }

    getMessages(): any[] {
        return this._session?.state?.messages ?? [];
    }

    setMessages(msgs: any[]): void {
        if (this._session?.state) {
            this._session.state.messages = msgs;
        }
    }

    markTurnStarted(): void {
        if (this._shutdownRequested || this._turnLifecycleOpen) return;
        this._sessionManager?.appendCustomEntry(TURN_LIFECYCLE_CUSTOM_TYPE, { status: 'started' });
        this._turnLifecycleOpen = true;
    }

    markTurnCompleted(): void {
        if (this._shutdownRequested || !this._turnLifecycleOpen) return;
        this._sessionManager?.appendCustomEntry(TURN_LIFECYCLE_CUSTOM_TYPE, { status: 'completed' });
        this._turnLifecycleOpen = false;
    }

    serializeState(): SerializedAgentState {
        const s = this._session;
        if (!s) {
            return {
                messages: [],
                isStreaming: false,
                tools: [],
            };
        }
        const model = s.model;
        let hasInterruptedTurn = false;
        if (!s.isStreaming && !s.isCompacting) {
            const lifecycleStatus = getLatestTurnLifecycleStatus(
                this._sessionManager?.getBranch() ?? [],
            );
            hasInterruptedTurn = lifecycleStatus === 'started'
                || lifecycleStatus === 'interrupted'
                || (lifecycleStatus === undefined && hasIncompleteTurnTail(s.messages));
        }
        return {
            messages: s.messages.map(safeSerialize),
            model: model ? {
                provider: getProviderId(model),
                id: model.id,
                name: model.name,
                supportsImages: Array.isArray((model as any).input) ? (model as any).input.includes('image') : undefined,
            } : undefined,
            thinkingLevel: s.thinkingLevel,
            isStreaming: s.isStreaming,
            tools: s.getActiveToolNames(),
            sessionId: s.sessionId,
            sessionName: s.sessionName,
            contextUsage: this._getContextUsage(),
            ...(!s.isStreaming && !s.isCompacting && hasInterruptedTurn
                ? { interruptedTurn: { reason: 'incomplete_session_tail' as const } }
                : {}),
        };
    }

    private _getContextUsage(): ContextUsageInfo | undefined {
        const usage = this._session?.getContextUsage?.();
        if (!usage) { return undefined; }
        let tokens = usage.tokens;
        let percent = usage.percent;
        let estimated = tokens != null
            && isContextUsageEstimated(this._session?.messages ?? []);

        // The SDK intentionally reports an unknown token count immediately after
        // compaction until a later assistant response provides fresh provider
        // usage. For the VS Code footer and compaction summary card we still
        // want a useful live value, so fall back to the same chars/4 style
        // estimate the SDK uses for messages.
        if (tokens == null && this._session?.messages?.length) {
            tokens = estimateVisibleContextTokens(this._session.messages);
            percent = usage.contextWindow > 0 ? (tokens / usage.contextWindow) * 100 : null;
            estimated = true;
        }

        return {
            tokens,
            contextWindow: usage.contextWindow,
            percent,
            estimated,
        };
    }

    async showModelPicker(): Promise<void> {
        const models = this.getModels();
        if (models.length === 0) {
            this._ports.dialogs.showWarning('No models available. Check your Pi configuration.');
            return;
        }
        const pick = await this._ports.dialogs.selectModel(
            models.map((model) => ({
                provider: model.provider,
                id: model.id,
                label: model.name ?? model.id,
            })),
            'Select a model',
        );
        if (pick) {
            await this.setModel(pick.provider, pick.modelId);
        }
    }

    get subagentManager(): SubagentManager | undefined {
        return this._subagentManager;
    }

    getSubagentSnapshot(): SubagentManagerSnapshot {
        return this._subagentManager?.getSnapshot() ?? { runs: [], activeCount: 0, queuedCount: 0 };
    }

    getSubagentRun(agentId: string): SubagentRun | undefined {
        return this.getSubagentSnapshot().runs.find((run) => run.agentId === agentId);
    }

    stopSubagent(agentId: string): boolean {
        return this._subagentManager?.stop(agentId) ?? false;
    }

    async steerSubagent(agentId: string, message: string): Promise<boolean> {
        return this._subagentManager?.steer(agentId, message) ?? false;
    }

    async resumeSubagent(agentId: string, task: string): Promise<SubagentForegroundResult> {
        const manager = this._subagentManager;
        if (!manager) throw new Error('Subagent runtime is not ready.');
        return manager.resumeForeground(agentId, task);
    }

    async dismissSubagent(agentId: string): Promise<boolean> {
        return this._subagentManager?.dismiss(agentId) ?? false;
    }

    clearSubagentIsolationPath(agentId: string): boolean {
        return this._subagentManager?.clearIsolationPath(agentId) ?? false;
    }

    async readSubagentTranscript(agentId: string): Promise<string | undefined> {
        const parentSessionId = this._session?.sessionId;
        if (!parentSessionId || !this._subagentStore) return undefined;
        return this._subagentStore.readTranscript(parentSessionId, agentId);
    }

    setSubagentParentTabId(tabId: string): void {
        this._subagentParentTabId = tabId;
        this._subagentManager?.setParentTabId(tabId);
    }

    private async _executeSubagentInvocation(
        registry: AgentRegistry,
        invocation: SubagentInvocation,
        signal: AbortSignal | undefined,
        onProgress: (details: SubagentToolDetails) => void,
    ): Promise<SubagentExecutionResult> {
        const manager = this._subagentManager;
        const session = this._session;
        const parentModel = this.getCurrentModel();
        if (!manager || !session || !parentModel || !this._modelRegistry) {
            throw new Error('Subagent runtime is not ready for this parent session.');
        }
        const snapshot = await registry.reload();
        for (const diagnostic of snapshot.diagnostics) {
            this._outputChannel.appendLine(
                `[subagent definition] severity=${diagnostic.severity} code=${diagnostic.code} ` +
                `path=${diagnostic.filePath ?? '(none)'} message=${diagnostic.message}`,
            );
        }

        const defaultModel = this._ports.settings.get('subagents.defaultModel', '').trim();
        const spec = resolveAgentSpec(registry, invocation, {
            availableModels: getAvailableModels(this._modelRegistry),
            parentModel: { provider: parentModel.provider, id: parentModel.id },
            parentThinkingLevel: session.thinkingLevel,
            ...(defaultModel ? { defaultModel } : {}),
            allowedModels: this._ports.settings.get('subagents.allowedModels', []),
            allowInvocationModelOverride: this._ports.settings.get(
                'subagents.allowInvocationModelOverride',
                true,
            ),
            registeredTools: [
                ...session.getAllTools().map((tool) => tool.name),
                ...(this._childToolFactories?.listNames() ?? []),
            ],
            activeTools: [
                ...session.getActiveToolNames(),
                ...(this._childToolFactories?.listNames() ?? []),
            ],
            childSafeTools: [...CHILD_SAFE_TOOLS, ...(this._childToolFactories?.listNames() ?? [])],
            nonChildSafeTools: ['subagent'],
            defaultMaxTurns: this._ports.settings.get('subagents.defaultMaxTurns', 30),
            maxTurns: 100,
            defaultTimeoutMinutes: this._ports.settings.get('subagents.defaultTimeoutMinutes', 10),
            maxTimeoutMinutes: 120,
            defaultContextMode: 'fresh',
            defaultIsolation: 'shared-workspace',
        });
        for (const diagnostic of spec.diagnostics) {
            this._outputChannel.appendLine(`[subagent resolution] code=${diagnostic.code} message=${diagnostic.message}`);
        }
        if (spec.background) return manager.runBackground(spec);
        return manager.runForeground(spec, signal, (run: SubagentRun) => {
            onProgress({
                agentId: run.agentId,
                name: run.name,
                status: run.status,
                ...(run.model ? { model: { provider: run.model.provider, id: run.model.id } } : {}),
                turnCount: run.turnCount,
            });
        });
    }

    private async _executeSubagentControl(
        action: 'resume' | 'send' | 'stop' | 'inspect' | 'dismiss' | 'review' | 'apply' | 'cleanup',
        params: SubagentToolParams,
        signal: AbortSignal | undefined,
        onProgress: (details: SubagentToolDetails) => void,
    ): Promise<SubagentControlResult> {
        const manager = this._subagentManager;
        const agentId = params.agentId?.trim();
        if (!manager || !agentId) throw new Error('Subagent lifecycle control requires a ready runtime and agentId.');
        const existing = manager.getSnapshot().runs.find((run) => run.agentId === agentId);
        if (!existing) throw new Error(`Unknown or stale subagent id: ${agentId}.`);
        const detailsFor = (run: SubagentRun): SubagentToolDetails => ({
            agentId: run.agentId,
            name: run.name,
            status: run.status,
            ...(run.model ? { model: { provider: run.model.provider, id: run.model.id } } : {}),
            turnCount: run.turnCount,
        });

        if (action === 'resume') {
            const task = params.task?.trim();
            if (!task) throw new Error('Subagent resume requires a non-empty follow-up task.');
            const result = await manager.resumeForeground(agentId, task, signal, (run) => onProgress(detailsFor(run)));
            return {
                text: result.result,
                details: {
                    agentId,
                    name: existing.name,
                    status: 'completed',
                    model: { provider: result.model.provider, id: result.model.id },
                    turnCount: result.turnCount,
                    truncated: result.truncated,
                },
            };
        }
        if (action === 'send') {
            const message = params.message?.trim();
            if (!message) throw new Error('Subagent send requires a non-empty message.');
            if (!await manager.steer(agentId, message)) throw new Error(`Subagent ${agentId} is not accepting steering.`);
            const updated = manager.getSnapshot().runs.find((run) => run.agentId === agentId) ?? existing;
            return { text: `Steering guidance sent to subagent ${agentId}.`, details: detailsFor(updated) };
        }
        if (action === 'stop') {
            if (!manager.stop(agentId)) throw new Error(`Subagent ${agentId} is not running.`);
            return { text: `Stop requested for subagent ${agentId}.`, details: detailsFor(existing) };
        }
        if (action === 'inspect') {
            const transcript = await this.readSubagentTranscript(agentId);
            if (!transcript) throw new Error(`Persistent transcript for subagent ${agentId} is unavailable.`);
            const maximum = 50 * 1024;
            const bounded = transcript.length > maximum
                ? `${transcript.slice(0, maximum)}\n… transcript truncated …`
                : transcript;
            return { text: bounded, details: detailsFor(existing) };
        }
        if (action === 'review' || action === 'apply' || action === 'cleanup') {
            if (['queued', 'starting', 'running', 'waiting_for_permission', 'retrying'].includes(existing.status)) {
                throw new Error(`Subagent ${agentId} is still active; wait for it to finish before managing its worktree.`);
            }
            const isolation = this._writeIsolation;
            const worktreePath = existing.isolationPath;
            const workspace = this._ports.workspace.getRoot();
            if (!isolation || !worktreePath || !workspace) {
                throw new Error(`Preserved worktree for subagent ${agentId} is unavailable.`);
            }
            if (action === 'review') {
                const diff = await isolation.getWorktreeDiff(worktreePath);
                const maximum = 50 * 1024;
                const bounded = diff.length > maximum
                    ? `${diff.slice(0, maximum)}\n… worktree diff truncated; inspect the preserved worktree directly for additional context …`
                    : diff;
                return {
                    text: bounded || 'The preserved worktree has no changes.',
                    details: detailsFor(existing),
                };
            }
            if (action === 'apply') {
                await isolation.applyWorktree(workspace, worktreePath);
                return {
                    text: `Applied and staged subagent ${agentId}'s worktree patch. The worktree remains available until cleanup.`,
                    details: detailsFor(existing),
                };
            }
            await isolation.cleanupWorktree(workspace, worktreePath);
            manager.clearIsolationPath(agentId);
            return { text: `Removed subagent ${agentId}'s preserved worktree.`, details: detailsFor(existing) };
        }
        if (!await manager.dismiss(agentId)) throw new Error(`Subagent ${agentId} cannot be dismissed while running.`);
        return { text: `Subagent ${agentId} was dismissed from retained runs.`, details: detailsFor(existing) };
    }

    private _deliverBackgroundSubagentNotification(
        run: SubagentRun,
        result: SubagentForegroundResult | undefined,
        error: Error | undefined,
    ): void {
        const outcome = result ? 'completed' : run.status;
        const body = result?.result ?? error?.message ?? run.error ?? 'No result was returned.';
        const content = [
            '<subagent-notification>',
            `Background subagent ${run.name} (${run.agentId}) ${outcome}.`,
            `Model: ${run.model ? `${run.model.provider}/${run.model.id}` : 'unknown'}`,
            'Result:',
            body,
            '</subagent-notification>',
        ].join('\n');
        const details = {
            agentId: run.agentId,
            name: run.name,
            task: run.task ?? run.taskPreview,
            result: body,
            status: outcome,
            model: run.model,
            turnCount: run.turnCount,
        };
        if (this._session?.isStreaming) {
            this._pendingBackgroundNotifications.push({ content, details });
        } else {
            this._appendBackgroundSubagentNotification(content, details);
        }
        this._outputChannel.appendLine(
            `[subagent parent notification] agentId=${run.agentId} status=${outcome} bytes=${Buffer.byteLength(content, 'utf8')}`,
        );
    }

    private _appendBackgroundSubagentNotification(content: string, details: Record<string, unknown>): void {
        this._sessionManager?.appendCustomMessageEntry(
            'pi-code.subagent-notification', content, true, details,
        );
        this._onSubagentNotification.fire();
    }

    private _flushBackgroundSubagentNotifications(): void {
        for (const notification of this._pendingBackgroundNotifications.splice(0)) {
            this._appendBackgroundSubagentNotification(notification.content, notification.details);
        }
    }

    private async _resetSubagentManager(cwd: string, session: AgentSession): Promise<void> {
        this._subagentManagerUnsubscribe?.();
        this._subagentManagerUnsubscribe = undefined;
        await this._subagentManager?.dispose();
        this._subagentManager = undefined;
        if (!this._subagentCoordinator || !this._modelRegistry) return;
        const authStorage = await getAuthStorage(this._secrets);
        const parentSessionPath = this._sessionManager?.getSessionFile();
        const restoredRecords = this._subagentStore
            ? await this._subagentStore.loadParent(session.sessionId)
            : [];
        const transcriptDirectory = this._subagentStore
            ? await this._subagentStore.ensureTranscriptDirectory(session.sessionId)
            : undefined;
        const childFactory = new PiChildSessionFactory({
            cwd,
            workspaceTrusted: this._ports.workspace.isTrusted(),
            authStorage,
            modelRegistry: this._modelRegistry,
            ...(transcriptDirectory ? { transcriptDirectory } : {}),
            ...(parentSessionPath ? { parentSessionPath } : {}),
            ...(this._writeIsolation ? { writeIsolation: this._writeIsolation } : {}),
            ...(this._childToolFactories ? { childToolFactories: this._childToolFactories } : {}),
            sessionLocks: this._ports.sessionLocks,
            log: (message) => this._outputChannel.appendLine(message),
        });
        this._subagentManager = new SubagentManager(this._subagentCoordinator, childFactory, {
            parentSessionId: session.sessionId,
            parentTabId: this._subagentParentTabId,
            maxConcurrentRuns: this._ports.settings.get('subagents.maxConcurrentPerChat', 2),
            restoredRecords,
            ...(this._subagentStore ? {
                persistRun: (run, spec) => this._subagentStore!.save(
                    session.sessionId, parentSessionPath, run, spec,
                ),
                dismissRun: async (agentId) => {
                    await this._subagentStore!.dismiss(session.sessionId, agentId);
                },
            } : {}),
            onMutationEvent: (event) => this._onSubagentMutation.fire(event),
            onBackgroundSettled: async (run, result, error) => {
                this._deliverBackgroundSubagentNotification(run, result, error);
            },
            log: (message) => this._outputChannel.appendLine(message),
        });
        this._subagentManagerUnsubscribe = this._subagentManager.onDidChange((snapshot) => {
            this._onSubagentStateChanged.fire(snapshot);
        });
    }

    private _runLifecycleTransition<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this._disposeRequested) {
            return Promise.reject(new Error('Pi session manager is disposing'));
        }
        if (this._lifecycleTransition) {
            return Promise.reject(new Error('Pi session manager transition already in progress'));
        }

        let resolveTransition!: (value: Result | PromiseLike<Result>) => void;
        let rejectTransition!: (reason?: unknown) => void;
        const transition = new Promise<Result>((resolve, reject) => {
            resolveTransition = resolve;
            rejectTransition = reject;
        });
        this._lifecycleTransition = transition;
        try {
            void operation().then(resolveTransition, rejectTransition);
        } catch (error) {
            rejectTransition(error);
        }
        return transition.finally(() => {
            if (this._lifecycleTransition === transition) this._lifecycleTransition = undefined;
        });
    }

    shutdown(): Promise<void> {
        if (this._shutdownPromise) return this._shutdownPromise;
        this._shutdownRequested = true;
        if (this._turnLifecycleOpen || this._session?.isStreaming || this._session?.isCompacting) {
            this._sessionManager?.appendCustomEntry(
                TURN_LIFECYCLE_CUSTOM_TYPE,
                { status: 'interrupted' },
            );
            this._turnLifecycleOpen = false;
        }
        const abort = this.abort();
        const dispose = this.dispose();
        this._shutdownPromise = Promise.allSettled([abort, dispose]).then((results) => {
            const failure = results.find(
                (result): result is PromiseRejectedResult => result.status === 'rejected',
            );
            if (failure) throw failure.reason;
        });
        return this._shutdownPromise;
    }

    dispose(): Promise<void> {
        if (this._disposePromise) return this._disposePromise;
        this._disposeRequested = true;
        const pendingTransition = this._lifecycleTransition;
        this._disposePromise = (async () => {
            if (pendingTransition) {
                try {
                    await pendingTransition;
                } catch {
                    // The lifecycle caller receives the original transition failure.
                }
            }

            let firstError: unknown;
            const runCleanup = async (cleanup: () => void | Promise<void>): Promise<void> => {
                try {
                    await cleanup();
                } catch (error) {
                    firstError ??= error;
                }
            };

            const unsubscribeSubagents = this._subagentManagerUnsubscribe;
            this._subagentManagerUnsubscribe = undefined;
            await runCleanup(() => unsubscribeSubagents?.());

            const subagentManager = this._subagentManager;
            this._subagentManager = undefined;
            await runCleanup(async () => subagentManager?.dispose());
            await runCleanup(() => this._flushBackgroundSubagentNotifications());

            const unsubscribeBackground = this._backgroundNotificationUnsubscribe;
            this._backgroundNotificationUnsubscribe = undefined;
            await runCleanup(() => unsubscribeBackground?.());
            await runCleanup(() => this._retireCurrentRawRecorder());
            await runCleanup(() => this._runtime.dispose());
            await runCleanup(() => this._onSubagentStateChanged.dispose());
            await runCleanup(() => this._onSubagentMutation.dispose());
            await runCleanup(() => this._onSubagentNotification.dispose());
            await runCleanup(() => this.events.clear());
            PiSessionManager._instances.delete(this);

            if (firstError !== undefined) throw firstError;
        })();
        return this._disposePromise;
    }

    static async disposeGlobal(): Promise<void> {
        let firstError: unknown;
        for (const manager of [...PiSessionManager._instances]) {
            try {
                await manager.dispose();
            } catch (error) {
                firstError ??= error;
            }
        }
        disposeAuthStorage();
        disposeModelRegistry();
        if (firstError !== undefined) throw firstError;
    }
}

function getProviderId(model: any): string {
    return String(model.provider);
}

function estimateVisibleContextTokens(messages: any[]): number {
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: any): number {
    if (!message || typeof message !== 'object') return 0;
    let chars = 0;
    switch (message.role) {
        case 'user':
            return estimateContentTokens(message.content);
        case 'assistant':
            if (Array.isArray(message.content)) {
                for (const block of message.content) {
                    if (block?.type === 'text') chars += String(block.text ?? '').length;
                    else if (block?.type === 'thinking') chars += String(block.thinking ?? '').length;
                    else if (block?.type === 'toolCall') {
                        chars += String(block.name ?? '').length + JSON.stringify(block.arguments ?? {}).length;
                    }
                }
            } else {
                chars = String(message.content ?? '').length;
            }
            return Math.ceil(chars / 4);
        case 'custom':
        case 'toolResult':
            return estimateContentTokens(message.content);
        case 'bashExecution':
            chars = String(message.command ?? '').length + String(message.output ?? '').length;
            return Math.ceil(chars / 4);
        case 'branchSummary':
        case 'compactionSummary':
            chars = String(message.summary ?? '').length;
            return Math.ceil(chars / 4);
        default:
            return estimateContentTokens(message.content);
    }
}

function estimateContentTokens(content: any): number {
    if (typeof content === 'string') return Math.ceil(content.length / 4);
    if (!Array.isArray(content)) return 0;
    let chars = 0;
    for (const block of content) {
        if (block?.type === 'text') chars += String(block.text ?? '').length;
        else if (block?.type === 'image') chars += 4800;
    }
    return Math.ceil(chars / 4);
}
