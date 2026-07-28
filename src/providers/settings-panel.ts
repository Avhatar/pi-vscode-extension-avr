import * as vscode from 'vscode';
import type { SettingsClientMessage, SettingsServerMessage, SettingsData, SkillInfo, OAuthProviderInfo } from '../shared/protocol';
import { API_KEY_PROVIDERS } from '../shared/providers';
import { getAuthStorage, notifyAuthChanged } from '../pi/auth';
import { getCodexUsageStore } from '../pi/codex-usage-store';
import { OAuthLoginFlow } from '../pi/oauth-login-flow';
import { refreshModelRegistry } from '../pi/models';
import { syncClaudeCodeMcpImport } from '../pi/mcp/claude-code-import';
import type { ExternalUrlService } from '../core/ports/external-url';
import type { RawStoragePort } from '../core/ports/raw-storage';
import type { RawRecorderRegistry } from '../core/raw/raw-recorder';

/**
 * Optional dependencies enabling the RawMode statistics block inside the
 * settings panel. Left undefined when RawMode is not wired for the host
 * (e.g. in the standalone desktop app before it grows Raw support).
 */
export interface SettingsRawServices {
    storage: RawStoragePort;
    registry: RawRecorderRegistry;
    onOpenRawView: (sessionPath: string) => void;
    resolveDisplayTitle?: (sessionPath: string) => string | undefined;
}

const API_KEY_PREFIX = 'pi-code.apiKey.';

export class SettingsPanel {
    private static _instance: SettingsPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _extensionUri: vscode.Uri;
    private _secrets: vscode.SecretStorage;
    private _disposables: vscode.Disposable[] = [];
    private _oauthFlows = new Map<string, OAuthLoginFlow>();

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
        private readonly _externalUrls: ExternalUrlService,
        private readonly _rawServices?: SettingsRawServices,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._secrets = secrets;

        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            (msg: SettingsClientMessage) => this._handleMessage(msg),
            undefined,
            this._disposables,
        );

        this._panel.onDidDispose(() => this._dispose(), undefined, this._disposables);

        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pi-code')) {
                this._sendSettings();
            }
        });
        this._disposables.push(configListener);
    }

    static show(
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
        externalUrls: ExternalUrlService,
        rawServices?: SettingsRawServices,
    ): void {
        if (SettingsPanel._instance) {
            SettingsPanel._instance._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'pi-code.settings',
            'Pi Code Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        SettingsPanel._instance = new SettingsPanel(panel, extensionUri, secrets, externalUrls, rawServices);
    }

    private async _handleMessage(msg: SettingsClientMessage): Promise<void> {
        try {
            switch (msg.type) {
                case 'getSettings':
                    await this._sendSettings();
                    break;
                case 'updateSetting':
                    await this._updateSetting(msg.key, msg.value);
                    break;
                case 'setApiKey':
                    await this._secrets.store(`${API_KEY_PREFIX}${msg.provider}`, msg.key);
                    await this._sendSettings();
                    break;
                case 'clearApiKey':
                    await this._secrets.delete(`${API_KEY_PREFIX}${msg.provider}`);
                    await this._sendSettings();
                    break;
                case 'getSkills':
                    await this._sendSkills();
                    break;
                case 'oauthLogin':
                    await this._startOAuthLogin(msg.providerId);
                    break;
                case 'oauthLogout':
                    await this._oauthLogout(msg.providerId);
                    break;
                case 'oauthCancel':
                    this._cancelOAuth(msg.providerId);
                    break;
                case 'oauthSelect':
                    this._submitOAuthSelection(msg.providerId, msg.optionId);
                    break;
                case 'oauthSubmitInput':
                    this._submitOAuthInput(msg.providerId, msg.value);
                    break;
                case 'oauthOpenUrl':
                    await this._openOAuthUrl(msg.url);
                    break;
                case 'rawMode.getStats':
                    await this._sendRawStats();
                    break;
                case 'rawMode.clearSession':
                    await this._clearRawSession(msg.sessionPath);
                    break;
                case 'rawMode.clearAll':
                    await this._clearRawAll();
                    break;
                case 'rawMode.revealStorage':
                    await this._revealRawStorage();
                    break;
                case 'rawMode.openView':
                    this._rawServices?.onOpenRawView(msg.sessionPath);
                    break;
            }
        } catch (err: any) {
            this._post({ type: 'error', message: err.message ?? String(err) });
            if (msg.type === 'updateSetting') await this._sendSettings();
        }
    }

    private async _sendRawStats(): Promise<void> {
        if (!this._rawServices) {
            this._post({
                type: 'rawMode.stats',
                stats: { sessions: [], totalEntries: 0, totalSizeBytes: 0, storageDir: '' },
            });
            return;
        }
        try {
            const summaries = await this._rawServices.storage.list();
            const resolve = this._rawServices.resolveDisplayTitle;
            let totalEntries = 0;
            let totalBytes = 0;
            for (const s of summaries) {
                totalEntries += s.entryCount;
                totalBytes += s.sizeBytes;
                if (resolve && !s.displayTitle) {
                    const title = resolve(s.sessionPath);
                    if (title) s.displayTitle = title;
                }
            }
            this._post({
                type: 'rawMode.stats',
                stats: {
                    sessions: summaries,
                    totalEntries,
                    totalSizeBytes: totalBytes,
                    storageDir: this._rawServices.storage.getStorageDir(),
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'rawMode.error', message });
        }
    }

    private async _clearRawSession(sessionPath: string): Promise<void> {
        if (!this._rawServices) return;
        try {
            await this._rawServices.registry.clearSessionData(
                this._rawServices.storage,
                sessionPath,
            );
            this._rawServices.registry.notifyDataCleared(sessionPath);
        } finally {
            await this._sendRawStats();
        }
    }

    private async _clearRawAll(): Promise<void> {
        if (!this._rawServices) return;
        try {
            const summaries = await this._rawServices.storage.list();
            const clearedPaths = new Set([
                ...summaries.map((summary) => summary.sessionPath),
                ...this._rawServices.registry.all().map((recorder) => recorder.sessionPath),
            ]);
            await this._rawServices.registry.clearAllData(this._rawServices.storage);
            for (const sessionPath of clearedPaths) {
                this._rawServices.registry.notifyDataCleared(sessionPath);
            }
        } finally {
            await this._sendRawStats();
        }
    }

    private async _revealRawStorage(): Promise<void> {
        if (!this._rawServices) return;
        const dir = this._rawServices.storage.getStorageDir();
        try {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'rawMode.error', message });
        }
    }

    private async _updateSetting(key: string, value: any): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-code');
        if (key === 'mcp.importClaudeCode') {
            syncClaudeCodeMcpImport(value === true);
        }
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    private async _sendSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-code');
        const provider = config.get<string>('apiProvider', '');

        const configuredProviders: string[] = [];
        for (const p of API_KEY_PROVIDERS) {
            const stored = await this._secrets.get(`${API_KEY_PREFIX}${p.id}`);
            if (stored) configuredProviders.push(p.id);
        }
        const apiKeySet = !!provider && configuredProviders.includes(provider);

        const authMethod = this._detectAuthMethod(provider, apiKeySet);
        const oauthProviders = await this._getOAuthProviders();

        const data: SettingsData = {
            apiProvider: provider,
            apiKeySet,
            configuredProviders,
            authMethod,
            defaultModel: config.get<string>('defaultModel', ''),
            thinkingLevel: config.get<string>('thinkingLevel', 'off'),
            allowedTools: config.get<string[]>('allowedTools', []),
            todoPromptGuidelines: config.get<string>('todo.promptGuidelines', ''),
            subagentsDefaultEnabled: config.get<boolean>('subagents.defaultEnabled', false),
            subagentsDefaultModel: config.get<string>('subagents.defaultModel', ''),
            subagentsAllowedModels: config.get<string[]>('subagents.allowedModels', []),
            subagentsAllowInvocationModelOverride: config.get<boolean>('subagents.allowInvocationModelOverride', true),
            subagentsDefaultMaxTurns: config.get<number>('subagents.defaultMaxTurns', 30),
            subagentsDefaultTimeoutMinutes: config.get<number>('subagents.defaultTimeoutMinutes', 10),
            subagentsMaxConcurrentGlobal: config.get<number>('subagents.maxConcurrentGlobal', 4),
            subagentsMaxConcurrentPerChat: config.get<number>('subagents.maxConcurrentPerChat', 2),
            mcpImportClaudeCode: config.get<boolean>('mcp.importClaudeCode', false),
            lspEnabled: config.get<boolean>('lsp.enabled', false),
            rawModeEnabled: config.get<boolean>('rawMode.enabled', false),
            perfEnabled: config.get<boolean>('perf.enabled', false),
            prewarmFull: config.get<boolean>('prewarm.full', false),
            userMessageGlowColor: config.get<string>('userMessageGlowColor', '#00aaff'),
            userMessageGlowOpacity: config.get<number>('userMessageGlowOpacity', 40),
            oauthProviders,
        };

        this._post({ type: 'settings', data });
    }

    private async _getOAuthProviders(): Promise<OAuthProviderInfo[]> {
        try {
            const authStorage = await getAuthStorage(this._secrets);
            const providers = authStorage.getOAuthProviders();
            return providers.map((p: any) => ({
                id: String(p.id),
                name: String(p.name ?? p.id),
                signedIn: authStorage.has(String(p.id)),
                usesCallbackServer: !!p.usesCallbackServer,
            }));
        } catch {
            return [];
        }
    }

    private async _startOAuthLogin(providerId: string): Promise<void> {
        if (this._oauthFlows.has(providerId)) {
            this._post({
                type: 'oauthState',
                providerId,
                state: { kind: 'error', message: 'Login already in progress for this provider.' },
            });
            return;
        }

        const authStorage = await getAuthStorage(this._secrets);
        const flow = new OAuthLoginFlow({
            onState: (state) => this._post({ type: 'oauthState', providerId, state }),
            openExternal: (url) => {
                void this._openOAuthUrl(url).catch(() => {
                    // Browser launch failed; the UI still shows the URL for manual opening.
                });
            },
        });
        this._oauthFlows.set(providerId, flow);

        this._post({
            type: 'oauthState',
            providerId,
            state: { kind: 'starting' },
        });

        try {
            await authStorage.login(providerId as any, flow.callbacks);
            this._post({
                type: 'oauthState',
                providerId,
                state: { kind: 'success' },
            });
            await refreshModelRegistry();
            if (providerId === 'openai-codex') getCodexUsageStore().clear();
            notifyAuthChanged(providerId);
            await this._sendSettings();
        } catch (err: any) {
            const message = err?.message ?? String(err);
            this._post({
                type: 'oauthState',
                providerId,
                state: flow.cancelled ? { kind: 'idle' } : { kind: 'error', message },
            });
            // Refresh state so UI shows accurate signed-in status (login may have partially persisted).
            await this._sendSettings();
        } finally {
            flow.finish();
            this._oauthFlows.delete(providerId);
        }
    }

    private async _oauthLogout(providerId: string): Promise<void> {
        const authStorage = await getAuthStorage(this._secrets);
        authStorage.logout(providerId);
        await refreshModelRegistry();
        if (providerId === 'openai-codex') getCodexUsageStore().clear();
        notifyAuthChanged(providerId);
        await this._sendSettings();
    }

    private _cancelOAuth(providerId: string): void {
        this._oauthFlows.get(providerId)?.cancel();
    }

    private _submitOAuthSelection(providerId: string, optionId: string): void {
        this._oauthFlows.get(providerId)?.submitSelection(optionId);
    }

    private _submitOAuthInput(providerId: string, value: string): void {
        this._oauthFlows.get(providerId)?.submitText(value);
    }

    private async _openOAuthUrl(url: string): Promise<void> {
        await this._externalUrls.openHttpUrl(url);
    }

    private async _sendSkills(): Promise<void> {
        try {
            const { loadSkills } = await import('@earendil-works/pi-coding-agent');
            const path = require('path');
            const os = require('os');
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            const agentDir = path.join(os.homedir(), '.pi', 'agent');
            const { skills: rawSkills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
            const skills: SkillInfo[] = rawSkills.map((s: any) => ({
                name: s.name,
                description: s.description ?? '',
                filePath: s.filePath ?? '',
                source: s.sourceInfo?.source ?? '',
                disableModelInvocation: s.disableModelInvocation ?? false,
            }));
            this._post({ type: 'skills', skills });
        } catch {
            this._post({ type: 'skills', skills: [] });
        }
    }

    private _detectAuthMethod(provider: string, hasManualKey: boolean): SettingsData['authMethod'] {
        if (hasManualKey) return 'manual';

        const envVarMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
            google: 'GEMINI_API_KEY',
            'google-vertex': 'GOOGLE_CLOUD_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
            qwen: 'DASHSCOPE_API_KEY',
            'qwen-cn': 'DASHSCOPE_CN_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            groq: 'GROQ_API_KEY',
            cerebras: 'CEREBRAS_API_KEY',
            xai: 'XAI_API_KEY',
            mistral: 'MISTRAL_API_KEY',
            fireworks: 'FIREWORKS_API_KEY',
            huggingface: 'HF_TOKEN',
            'kimi-coding': 'KIMI_API_KEY',
            minimax: 'MINIMAX_API_KEY',
            'minimax-cn': 'MINIMAX_CN_API_KEY',
            zai: 'ZAI_API_KEY',
            'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
        };

        if (provider && envVarMap[provider] && process.env[envVarMap[provider]]) {
            return 'env';
        }

        const fs = require('fs');
        const path = require('path');
        const piAuthDir = path.join(require('os').homedir(), '.pi', 'agent');
        if (fs.existsSync(piAuthDir)) {
            return 'pi-login';
        }

        return 'none';
    }

    private _post(message: SettingsServerMessage): void {
        this._panel.webview.postMessage(message);
    }

    private _dispose(): void {
        SettingsPanel._instance = undefined;
        for (const [, flow] of this._oauthFlows) {
            flow.cancel('Settings panel closed');
        }
        this._oauthFlows.clear();
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    private _getHtml(): string {
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'settings.js'),
        );
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles', 'settings.css'),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Pi Code Settings</title>
</head>
<body>
    <div id="settings-app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
