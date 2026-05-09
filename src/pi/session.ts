import * as vscode from 'vscode';
import * as process from 'node:process';
import type { AgentSession, AgentSessionEvent, SessionManager, ModelRegistry, ResourceLoader } from '@mariozechner/pi-coding-agent';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo, SkillInfo, ImageAttachment, FileAttachment } from '../shared/protocol';
import { EventRouter } from './events';
import { getAuthStorage, disposeAuthStorage, reloadCredentials } from './auth';
import { getModelRegistry, getAvailableModels, findModel, disposeModelRegistry } from './models';
import { createCodexMonitorExtension } from './codex-monitor';
import { getCodexUsageStore } from './codex-usage-store';
import { getBundledPiPackagePaths } from './bundled-packages';
import { createClaudeMdInjectorExtension } from './claude-md-injector';
import { createTodoExtension } from './todo/extension';
import { TodoStore } from './todo/store';

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
    readonly todoStore = new TodoStore();

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

        // Default todo visibility = OFF. The tool is registered (so its
        // state survives across toggles via branch replay) but excluded
        // from the active set, so the model never sees the tool's
        // schema or its promptGuidelines. PR4 will wire the per-tab
        // toggle to flip this via `setTodoVisibility(true)`.
        this.setTodoVisibility(false);

        const model = session.model;
        this._outputChannel.appendLine(
            `Pi session initialized. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
        );
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
    setTodoVisibility(visible: boolean): void {
        const session = this._session;
        if (!session) return;
        const active = session.getActiveToolNames();
        const present = active.includes('todo');
        if (visible === present) return;
        const next = visible
            ? [...active, 'todo']
            : active.filter((name) => name !== 'todo');
        session.setActiveToolsByName(next);
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
            createTodoExtension(this.todoStore),
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

    async prompt(text: string, images?: ImageAttachment[], files?: FileAttachment[]): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        const augmentedText = this._augmentTextWithFiles(text, files);
        await this._session.prompt(augmentedText, images?.length ? { images } : undefined);
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
        await this._session.compact(customInstructions);
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
        let tokens = usage.tokens;
        let percent = usage.percent;
        let estimated = false;

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
