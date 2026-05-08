import * as vscode from 'vscode';
import * as process from 'node:process';
import type { AgentSession, AgentSessionEvent, SessionManager, ModelRegistry, ResourceLoader } from '@mariozechner/pi-coding-agent';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo, SkillInfo, ImageAttachment } from '../shared/protocol';
import { EventRouter } from './events';
import { getAuthStorage, disposeAuthStorage, reloadCredentials } from './auth';
import { getModelRegistry, getAvailableModels, findModel, disposeModelRegistry } from './models';
import { createCodexMonitorExtension } from './codex-monitor';
import { getCodexUsageStore } from './codex-usage-store';
import { getBundledPiPackagePaths } from './bundled-packages';
import { createClaudeMdInjectorExtension } from './claude-md-injector';

export type ToolApprovalHandler = (toolCallId: string, toolName: string, args: any) => Promise<boolean>;

export class PiSessionManager {
    private _session: AgentSession | undefined;
    private _sessionManager: SessionManager | undefined;
    private _modelRegistry: ModelRegistry | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _outputChannel: vscode.OutputChannel;
    private _toolApprovalHandler: ToolApprovalHandler | undefined;
    private _secrets: vscode.SecretStorage | undefined;
    readonly events = new EventRouter();

    constructor(outputChannel: vscode.OutputChannel, secrets?: vscode.SecretStorage) {
        this._outputChannel = outputChannel;
        this._secrets = secrets;
    }

    async reloadCredentials(): Promise<void> {
        await reloadCredentials();
    }

    get session(): AgentSession | undefined {
        return this._session;
    }

    get isReady(): boolean {
        return this._session !== undefined;
    }

    async initialize(): Promise<void> {
        this._outputChannel.appendLine('Initializing Pi session...');
        const { createAgentSession, SessionManager: SM } = await import('@mariozechner/pi-coding-agent');

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        // Bundled extensions like pi-mcp-adapter discover project config files via process.cwd()
        // (e.g. ".mcp.json", ".pi/mcp.json"). In the VS Code extension host process.cwd() is
        // typically the VS Code install directory, not the workspace, so those configs are missed.
        // Chdir to the workspace folder so adapters resolve project files correctly.
        try { if (cwd && process.cwd() !== cwd) { process.chdir(cwd); } } catch { /* ignore — non-fatal */ }
        const authStorage = await getAuthStorage(this._secrets);
        this._modelRegistry = await getModelRegistry();

        this._sessionManager = SM.create(cwd);

        const config = vscode.workspace.getConfiguration('pi-code');
        const allowedTools = config.get<string[]>('allowedTools', []);

        const resourceLoader = await this._buildResourceLoader(cwd);

        const opts: any = {
            cwd,
            authStorage,
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
            resourceLoader,
        };
        if (allowedTools.length > 0) {
            opts.allowedToolNames = allowedTools;
        }

        const { session, modelFallbackMessage } = await createAgentSession(opts);

        await this._bindExtensions(session);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());

        if (modelFallbackMessage) {
            this._outputChannel.appendLine(`Model fallback: ${modelFallbackMessage}`);
        }

        await this._applyDefaultSettings(session);
        this._installToolApprovalHook(session);

        const model = session.model;
        this._outputChannel.appendLine(
            `Pi session initialized. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
        );
    }

    private async _buildResourceLoader(cwd: string): Promise<ResourceLoader> {
        const { DefaultResourceLoader, getAgentDir, SettingsManager } = await import('@mariozechner/pi-coding-agent');
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const usageStore = getCodexUsageStore();
        const factories = [
            createCodexMonitorExtension({
                onResponse: ({ headers }) => {
                    usageStore.updateFromHeaders(headers);
                },
            }),
            createClaudeMdInjectorExtension(),
        ];
        const bundledPackagePaths = getBundledPiPackagePaths((msg) => this._outputChannel.appendLine(msg));
        const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            extensionFactories: factories,
            additionalExtensionPaths: bundledPackagePaths,
        });
        await loader.reload();
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
    }

    private async _applyDefaultSettings(session: AgentSession): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-code');

        const thinkingLevel = config.get<string>('thinkingLevel', 'off');
        if (thinkingLevel && thinkingLevel !== 'off') {
            session.setThinkingLevel(thinkingLevel as any);
        }

        const defaultModel = config.get<string>('defaultModel', '');
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

    async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.prompt(text, images?.length ? { images } : undefined);
    }

    async steer(text: string, images?: ImageAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.steer(text, images?.length ? images : undefined);
    }

    async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.followUp(text, images?.length ? images : undefined);
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
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        // Bundled extensions like pi-mcp-adapter discover project config files via process.cwd()
        // (e.g. ".mcp.json", ".pi/mcp.json"). In the VS Code extension host process.cwd() is
        // typically the VS Code install directory, not the workspace, so those configs are missed.
        // Chdir to the workspace folder so adapters resolve project files correctly.
        try { if (cwd && process.cwd() !== cwd) { process.chdir(cwd); } } catch { /* ignore — non-fatal */ }
        const { SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        this._sessionManager = SM.create(cwd);

        const config = vscode.workspace.getConfiguration('pi-code');
        const allowedTools = config.get<string[]>('allowedTools', []);

        const resourceLoader = await this._buildResourceLoader(cwd);

        const opts: any = {
            cwd,
            authStorage: await getAuthStorage(this._secrets),
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
            resourceLoader,
        };
        if (allowedTools.length > 0) {
            opts.allowedToolNames = allowedTools;
        }

        const { session } = await createAgentSession(opts);

        await this._bindExtensions(session);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        await this._applyDefaultSettings(session);
        this._installToolApprovalHook(session);
    }

    get sessionPath(): string | undefined {
        return this._sessionManager?.getSessionFile();
    }

    async initializeFromPath(sessionPath: string): Promise<void> {
        this._outputChannel.appendLine(`Restoring session from ${sessionPath}...`);
        const { createAgentSession, SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        // Bundled extensions like pi-mcp-adapter discover project config files via process.cwd()
        // (e.g. ".mcp.json", ".pi/mcp.json"). In the VS Code extension host process.cwd() is
        // typically the VS Code install directory, not the workspace, so those configs are missed.
        // Chdir to the workspace folder so adapters resolve project files correctly.
        try { if (cwd && process.cwd() !== cwd) { process.chdir(cwd); } } catch { /* ignore — non-fatal */ }
        const authStorage = await getAuthStorage(this._secrets);
        this._modelRegistry = await getModelRegistry();
        this._sessionManager = SM.open(sessionPath, undefined);

        const config = vscode.workspace.getConfiguration('pi-code');
        const allowedTools = config.get<string[]>('allowedTools', []);

        const resourceLoader = await this._buildResourceLoader(cwd);

        const opts: any = {
            cwd,
            authStorage,
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
            resourceLoader,
        };
        if (allowedTools.length > 0) {
            opts.allowedToolNames = allowedTools;
        }

        const { session } = await createAgentSession(opts);

        await this._bindExtensions(session);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        await this._applyDefaultSettings(session);
        this._installToolApprovalHook(session);

        const model = session.model;
        this._outputChannel.appendLine(
            `Session restored. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
        );
    }

    async getSessions(): Promise<SessionInfo[]> {
        const { SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { createAgentSession, SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        // Bundled extensions like pi-mcp-adapter discover project config files via process.cwd()
        // (e.g. ".mcp.json", ".pi/mcp.json"). In the VS Code extension host process.cwd() is
        // typically the VS Code install directory, not the workspace, so those configs are missed.
        // Chdir to the workspace folder so adapters resolve project files correctly.
        try { if (cwd && process.cwd() !== cwd) { process.chdir(cwd); } } catch { /* ignore — non-fatal */ }
        this._sessionManager = SM.open(sessionPath, undefined);

        const resourceLoader = await this._buildResourceLoader(cwd);

        const { session } = await createAgentSession({
            cwd,
            authStorage: await getAuthStorage(this._secrets),
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
            resourceLoader,
        });

        await this._bindExtensions(session);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        this._installToolApprovalHook(session);
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

    getThinkingLevel(): string | undefined {
        return this._session?.thinkingLevel;
    }

    getAutoApproveTools(): boolean {
        return vscode.workspace.getConfiguration('pi-code').get<boolean>('autoApproveTools', false);
    }

    setToolApprovalHandler(handler: ToolApprovalHandler | undefined): void {
        this._toolApprovalHandler = handler;
    }

    private _installToolApprovalHook(session: AgentSession): void {
        try {
            const runner = session.extensionRunner;
            if (!runner) return;

            const origEmitToolCall = runner.emitToolCall.bind(runner);
            const self = this;

            runner.emitToolCall = async (event: any) => {
                const origResult = await origEmitToolCall(event);
                if (origResult?.block) return origResult;
                if (self.getAutoApproveTools()) return origResult;
                if (!self._toolApprovalHandler) return origResult;

                const approved = await self._toolApprovalHandler(
                    event.toolCallId,
                    event.toolName,
                    event.input,
                );
                if (!approved) {
                    return { block: true, reason: 'User rejected tool call' };
                }
                return origResult;
            };
        } catch {
            this._outputChannel.appendLine('Tool approval hook: extension runner not available, skipping');
        }
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
        };
    }

    private _getContextUsage(): ContextUsageInfo | undefined {
        const usage = this._session?.getContextUsage?.();
        if (!usage) { return undefined; }
        return {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
        };
    }

    async showModelPicker(): Promise<void> {
        const models = this.getModels();
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models available. Check your Pi configuration.');
            return;
        }
        const items = models.map((m) => ({
            label: m.name ?? m.id,
            description: m.provider,
            model: m,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a model',
        });
        if (pick) {
            await this.setModel(pick.model.provider, pick.model.id);
        }
    }

    async dispose(): Promise<void> {
        this._unsubscribe?.();
        this._session?.dispose();
        this._session = undefined;
        this.events.clear();
    }

    static async disposeGlobal(): Promise<void> {
        disposeAuthStorage();
        disposeModelRegistry();
    }
}

function getProviderId(model: any): string {
    return String(model.provider);
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { _serializationFailed: true, type: obj?.type };
    }
}
