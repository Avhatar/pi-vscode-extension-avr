import * as path from 'path';
import * as vscode from 'vscode';
import type { FileMentionsPort } from '../core/ports/chat-platform';
import {
    DEFAULT_FILE_MENTION_CONFIG_PATH,
    augmentPromptWithFileMentions,
    compileFileMentionExcludePatterns,
    createFileMentionEntry,
    extractValidFileMentions,
    isFileMentionPathExcluded,
    normalizeFileMentionPath,
    resolveFileMentionConfig,
    searchFileMentionEntries,
    toFileMentionExcludeGlob,
    type FileMentionConfig,
    type FileMentionEntry,
    type ProjectFileMentionConfig,
} from '../core/files/file-mentions';
import type { WorkspaceFileSuggestion } from '../shared/agent-protocol';

interface WorkspaceFileEntry extends FileMentionEntry {
    uri: vscode.Uri;
}
const REBUILD_BURST_THRESHOLD = 25;
const REBUILD_DEBOUNCE_MS = 800;

export class WorkspaceFileMentions implements vscode.Disposable, FileMentionsPort {
    private _entries: WorkspaceFileEntry[] = [];
    private _entriesByRelativePath = new Map<string, WorkspaceFileEntry>();
    private _indexingPromise: Promise<void> | undefined;
    private _ready = false;
    private _disposed = false;
    private _warmupTimer: NodeJS.Timeout | undefined;
    private _rebuildTimer: NodeJS.Timeout | undefined;
    private _pendingWatcherEvents = 0;
    private _watcher: vscode.FileSystemWatcher | undefined;
    private _configWatcher: vscode.FileSystemWatcher | undefined;
    private _configPath = DEFAULT_FILE_MENTION_CONFIG_PATH;
    private _config: FileMentionConfig | undefined;
    private _excludeRegexes: RegExp[] = [];
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly _outputChannel: vscode.OutputChannel) {
        this._watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this._watcher.onDidCreate(uri => { void this._onFileCreated(uri); }, undefined, this._disposables);
        this._watcher.onDidDelete(uri => this._onFileDeleted(uri), undefined, this._disposables);
        this._disposables.push(this._watcher);

        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('pi-code.fileMentions')) {
                    this._invalidateAndRebuild();
                }
            }),
        );

        this._resetConfigWatcher(DEFAULT_FILE_MENTION_CONFIG_PATH);
    }

    get isReady(): boolean {
        return this._ready;
    }

    get isIndexing(): boolean {
        return !!this._indexingPromise;
    }

    warmup(delayMs = 1000): void {
        if (this._disposed || this._warmupTimer || this._ready || this._indexingPromise) return;
        this._warmupTimer = setTimeout(() => {
            this._warmupTimer = undefined;
            void this.ensureIndexed();
        }, delayMs);
    }

    async ensureIndexed(): Promise<void> {
        if (this._disposed) return;
        if (this._ready) return;
        if (this._indexingPromise) return this._indexingPromise;

        this._indexingPromise = this._buildIndex()
            .catch((err: any) => {
                this._outputChannel.appendLine(`Workspace file mention indexing failed: ${err?.message ?? String(err)}`);
            })
            .finally(() => {
                this._indexingPromise = undefined;
            });
        return this._indexingPromise;
    }

    async search(query: string, maxSuggestions?: number): Promise<WorkspaceFileSuggestion[]> {
        if (this._disposed) return [];
        await this.ensureIndexed();
        if (!this._ready) return [];

        const config = this._config ?? await this._loadEffectiveConfig();
        if (!config.enabled) return [];

        return searchFileMentionEntries(
            this._entries,
            query,
            maxSuggestions ?? config.maxSuggestions,
        );
    }

    async augmentPromptIfNeeded(text: string): Promise<string> {
        if (!text.includes('@')) return text;
        await this.ensureIndexed();
        return this.augmentPrompt(text);
    }

    augmentPrompt(text: string): string {
        return augmentPromptWithFileMentions(text, this._entriesByRelativePath);
    }

    extractValidMentions(text: string): string[] {
        if (!this._ready) return [];
        return extractValidFileMentions(text, this._entriesByRelativePath);
    }

    dispose(): void {
        this._disposed = true;
        if (this._warmupTimer) clearTimeout(this._warmupTimer);
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._configWatcher?.dispose();
        this._configWatcher = undefined;
        for (const disposable of this._disposables) {
            try { disposable.dispose(); } catch { /* ignore */ }
        }
        this._disposables.length = 0;
        this._entries = [];
        this._entriesByRelativePath.clear();
    }

    private async _buildIndex(): Promise<void> {
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder) {
            this._entries = [];
            this._entriesByRelativePath.clear();
            this._ready = true;
            return;
        }

        const config = await this._loadEffectiveConfig();
        this._config = config;
        this._resetConfigWatcher(config.configPath);
        if (!config.enabled) {
            this._entries = [];
            this._entriesByRelativePath.clear();
            this._excludeRegexes = [];
            this._ready = true;
            return;
        }

        this._excludeRegexes = compileFileMentionExcludePatterns(config.exclude);
        const excludeGlob = toFileMentionExcludeGlob(config.exclude);
        const started = Date.now();
        const uris = await vscode.workspace.findFiles('**/*', excludeGlob);
        const entries: WorkspaceFileEntry[] = [];
        const byPath = new Map<string, WorkspaceFileEntry>();

        for (const uri of uris) {
            const relativePath = this._relativePath(uri);
            if (!relativePath || this._isExcluded(relativePath)) continue;
            const entry: WorkspaceFileEntry = { uri, ...createFileMentionEntry(relativePath) };
            entries.push(entry);
            byPath.set(entry.relativePathLower, entry);
        }

        entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        this._entries = entries;
        this._entriesByRelativePath = byPath;
        this._ready = true;
        this._outputChannel.appendLine(`Workspace file mention index ready: ${entries.length} file(s) in ${Date.now() - started} ms.`);
    }

    private async _loadEffectiveConfig(): Promise<FileMentionConfig> {
        const settings = vscode.workspace.getConfiguration('pi-code');
        const projectConfigPath = normalizeFileMentionPath(
            settings.get<string>('fileMentions.configPath', DEFAULT_FILE_MENTION_CONFIG_PATH)
                || DEFAULT_FILE_MENTION_CONFIG_PATH,
        );
        const projectConfig = await this._loadProjectConfig(projectConfigPath);
        return resolveFileMentionConfig({
            enabled: settings.get<boolean>('fileMentions.enabled', true),
            useDefaultExcludes: settings.get<boolean>('fileMentions.useDefaultExcludes', true),
            exclude: settings.get<string[]>('fileMentions.exclude', []),
            maxSuggestions: settings.get<number>('fileMentions.maxSuggestions', 30),
            configPath: projectConfigPath,
        }, projectConfig);
    }

    private async _loadProjectConfig(configPath: string): Promise<ProjectFileMentionConfig> {
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder || !configPath) return {};
        const uri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            ...normalizeFileMentionPath(configPath).split('/').filter(Boolean),
        );
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const raw = Buffer.from(bytes).toString('utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (err: any) {
            if (err?.code !== 'FileNotFound' && err?.name !== 'EntryNotFound') {
                this._outputChannel.appendLine(`Failed to load workspace file mention config ${configPath}: ${err?.message ?? String(err)}`);
            }
            return {};
        }
    }

    private async _onFileCreated(uri: vscode.Uri): Promise<void> {
        if (!this._ready || this._disposed) return;
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if ((stat.type & vscode.FileType.Directory) !== 0) return;
        } catch {
            return;
        }
        const relativePath = this._relativePath(uri);
        if (!relativePath || this._isExcluded(relativePath)) return;
        this._pendingWatcherEvents++;
        if (this._pendingWatcherEvents > REBUILD_BURST_THRESHOLD) {
            this._scheduleRebuild();
            return;
        }
        const key = relativePath.toLowerCase();
        if (this._entriesByRelativePath.has(key)) return;
        const entry: WorkspaceFileEntry = { uri, ...createFileMentionEntry(relativePath) };
        this._entriesByRelativePath.set(key, entry);
        this._entries.push(entry);
        this._entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        this._resetWatcherEventCountSoon();
    }

    private _onFileDeleted(uri: vscode.Uri): void {
        if (!this._ready || this._disposed) return;
        const relativePath = this._relativePath(uri);
        if (!relativePath) return;
        this._pendingWatcherEvents++;
        if (this._pendingWatcherEvents > REBUILD_BURST_THRESHOLD) {
            this._scheduleRebuild();
            return;
        }
        const key = relativePath.toLowerCase();
        if (!this._entriesByRelativePath.delete(key)) return;
        this._entries = this._entries.filter(entry => entry.relativePathLower !== key);
        this._resetWatcherEventCountSoon();
    }

    private _scheduleRebuild(): void {
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = undefined;
            this._pendingWatcherEvents = 0;
            this._invalidateAndRebuild();
        }, REBUILD_DEBOUNCE_MS);
    }

    private _resetWatcherEventCountSoon(): void {
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._rebuildTimer = setTimeout(() => {
            this._rebuildTimer = undefined;
            this._pendingWatcherEvents = 0;
        }, REBUILD_DEBOUNCE_MS);
    }

    private _invalidateAndRebuild(): void {
        this._ready = false;
        this._config = undefined;
        this._entries = [];
        this._entriesByRelativePath.clear();
        void this.ensureIndexed();
    }

    private _resetConfigWatcher(configPath: string): void {
        const normalized = normalizeFileMentionPath(
            configPath || DEFAULT_FILE_MENTION_CONFIG_PATH,
        );
        if (this._configWatcher && this._configPath === normalized) return;
        this._configWatcher?.dispose();
        this._configPath = normalized;
        this._configWatcher = vscode.workspace.createFileSystemWatcher(normalized);
        this._configWatcher.onDidCreate(() => this._invalidateAndRebuild());
        this._configWatcher.onDidChange(() => this._invalidateAndRebuild());
        this._configWatcher.onDidDelete(() => this._invalidateAndRebuild());
    }

    private _relativePath(uri: vscode.Uri): string | undefined {
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder) return undefined;
        const rel = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        return normalizeFileMentionPath(rel);
    }

    private _isExcluded(relativePath: string): boolean {
        return isFileMentionPathExcluded(relativePath, this._excludeRegexes);
    }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}
