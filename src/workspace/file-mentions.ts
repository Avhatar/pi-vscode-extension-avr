import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceFileSuggestion } from '../shared/protocol';

interface WorkspaceFileEntry {
    uri: vscode.Uri;
    relativePath: string;
    relativePathLower: string;
    basename: string;
    basenameLower: string;
}

interface FileMentionsConfig {
    enabled: boolean;
    useDefaultExcludes: boolean;
    exclude: string[];
    maxSuggestions: number;
    configPath: string;
}

interface ProjectFileMentionsConfig {
    useDefaultExcludes?: boolean;
    exclude?: string[];
    maxSuggestions?: number;
}

const DEFAULT_EXCLUDES = [
    '**/.git/**',
    '**/node_modules/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/coverage/**',
    '**/.vscode-test/**',
    '**/*.map',
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa',
    '**/id_ed25519',
];

const DEFAULT_MAX_SUGGESTIONS = 30;
const DEFAULT_CONFIG_PATH = '.pi/file-mentions.json';
const REBUILD_BURST_THRESHOLD = 25;
const REBUILD_DEBOUNCE_MS = 800;

export class WorkspaceFileMentions implements vscode.Disposable {
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
    private _configPath = DEFAULT_CONFIG_PATH;
    private _config: FileMentionsConfig | undefined;
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

        this._resetConfigWatcher(DEFAULT_CONFIG_PATH);
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

        const limit = Math.max(1, Math.min(200, maxSuggestions ?? config.maxSuggestions));
        const normalizedQuery = normalizePath(query).trim().toLowerCase();
        const scored: Array<{ entry: WorkspaceFileEntry; score: number }> = [];

        for (const entry of this._entries) {
            const score = scoreEntry(entry, normalizedQuery);
            if (score !== null) {
                scored.push({ entry, score });
            }
        }

        scored.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            if (a.entry.relativePath.length !== b.entry.relativePath.length) {
                return a.entry.relativePath.length - b.entry.relativePath.length;
            }
            return a.entry.relativePath.localeCompare(b.entry.relativePath);
        });

        return scored.slice(0, limit).map(({ entry }) => ({
            relativePath: entry.relativePath,
            basename: entry.basename,
            insertText: formatMentionInsertText(entry.relativePath),
        }));
    }

    async augmentPromptIfNeeded(text: string): Promise<string> {
        if (!text.includes('@')) return text;
        await this.ensureIndexed();
        return this.augmentPrompt(text);
    }

    augmentPrompt(text: string): string {
        const mentions = this.extractValidMentions(text);
        if (mentions.length === 0) return text;
        return `${text}\n\nReferenced workspace files to inspect if needed:\n${mentions.map(p => `- ${p}`).join('\n')}`;
    }

    extractValidMentions(text: string): string[] {
        if (!this._ready || this._entriesByRelativePath.size === 0) return [];
        const found: string[] = [];
        const seen = new Set<string>();

        for (const candidate of parseMentionCandidates(text)) {
            const normalized = normalizePath(candidate);
            const key = normalized.toLowerCase();
            const entry = this._entriesByRelativePath.get(key);
            if (!entry || seen.has(key)) continue;
            seen.add(key);
            found.push(entry.relativePath);
        }

        return found;
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

        this._excludeRegexes = config.exclude.map(globToRegExp);
        const excludeGlob = toVsCodeExcludeGlob(config.exclude);
        const started = Date.now();
        const uris = await vscode.workspace.findFiles('**/*', excludeGlob);
        const entries: WorkspaceFileEntry[] = [];
        const byPath = new Map<string, WorkspaceFileEntry>();

        for (const uri of uris) {
            const relativePath = this._relativePath(uri);
            if (!relativePath || this._isExcluded(relativePath)) continue;
            const basename = relativePath.split('/').pop() ?? relativePath;
            const entry: WorkspaceFileEntry = {
                uri,
                relativePath,
                relativePathLower: relativePath.toLowerCase(),
                basename,
                basenameLower: basename.toLowerCase(),
            };
            entries.push(entry);
            byPath.set(entry.relativePathLower, entry);
        }

        entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        this._entries = entries;
        this._entriesByRelativePath = byPath;
        this._ready = true;
        this._outputChannel.appendLine(`Workspace file mention index ready: ${entries.length} file(s) in ${Date.now() - started} ms.`);
    }

    private async _loadEffectiveConfig(): Promise<FileMentionsConfig> {
        const settings = vscode.workspace.getConfiguration('pi-code');
        const projectConfigPath = normalizePath(settings.get<string>('fileMentions.configPath', DEFAULT_CONFIG_PATH) || DEFAULT_CONFIG_PATH);
        const projectConfig = await this._loadProjectConfig(projectConfigPath);

        const settingsUseDefaults = settings.get<boolean>('fileMentions.useDefaultExcludes', true);
        const useDefaultExcludes = projectConfig.useDefaultExcludes ?? settingsUseDefaults;
        const settingsExclude = settings.get<string[]>('fileMentions.exclude', []);
        const projectExclude = Array.isArray(projectConfig.exclude) ? projectConfig.exclude : [];
        const maxSuggestions = clampNumber(
            projectConfig.maxSuggestions ?? settings.get<number>('fileMentions.maxSuggestions', DEFAULT_MAX_SUGGESTIONS),
            1,
            200,
            DEFAULT_MAX_SUGGESTIONS,
        );

        return {
            enabled: settings.get<boolean>('fileMentions.enabled', true),
            useDefaultExcludes,
            exclude: uniquePatterns([
                ...(useDefaultExcludes ? DEFAULT_EXCLUDES : []),
                ...settingsExclude,
                ...projectExclude,
            ]),
            maxSuggestions,
            configPath: projectConfigPath,
        };
    }

    private async _loadProjectConfig(configPath: string): Promise<ProjectFileMentionsConfig> {
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder || !configPath) return {};
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...normalizePath(configPath).split('/').filter(Boolean));
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
        const basename = relativePath.split('/').pop() ?? relativePath;
        const entry: WorkspaceFileEntry = {
            uri,
            relativePath,
            relativePathLower: key,
            basename,
            basenameLower: basename.toLowerCase(),
        };
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
        const normalized = normalizePath(configPath || DEFAULT_CONFIG_PATH);
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
        return normalizePath(rel);
    }

    private _isExcluded(relativePath: string): boolean {
        const normalized = normalizePath(relativePath);
        return this._excludeRegexes.some(regex => regex.test(normalized));
    }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

function formatMentionInsertText(relativePath: string): string {
    return /\s/.test(relativePath) ? `@{${relativePath}} ` : `@${relativePath} `;
}

function parseMentionCandidates(text: string): string[] {
    const candidates: string[] = [];

    const braced = /@\{([^}\r\n]+)\}/g;
    let bracedMatch: RegExpExecArray | null;
    while ((bracedMatch = braced.exec(text)) !== null) {
        candidates.push(bracedMatch[1].trim());
    }

    const normal = /(^|[\s([{:,;])@([^\s{}]+)/g;
    let normalMatch: RegExpExecArray | null;
    while ((normalMatch = normal.exec(text)) !== null) {
        const raw = normalMatch[2];
        if (!raw) continue;
        const trimmed = raw.replace(/[.,;:!?\])]+$/g, '');
        if (trimmed) candidates.push(trimmed);
    }

    return candidates;
}

function scoreEntry(entry: WorkspaceFileEntry, query: string): number | null {
    if (!query) return 1000;

    const basename = entry.basenameLower;
    const relative = entry.relativePathLower;

    if (basename === query) return 0;
    if (basename.startsWith(query)) return 10 + basename.length - query.length;
    const basenameIndex = basename.indexOf(query);
    if (basenameIndex >= 0) return 100 + basenameIndex + basename.length * 0.01;
    if (relative.startsWith(query)) return 200 + relative.length * 0.01;
    const relativeIndex = relative.indexOf(query);
    if (relativeIndex >= 0) return 300 + relativeIndex + relative.length * 0.01;

    const fuzzy = fuzzyScore(relative, query);
    if (fuzzy !== null) return 500 + fuzzy + relative.length * 0.01;

    return null;
}

function fuzzyScore(value: string, query: string): number | null {
    let valueIndex = 0;
    let score = 0;
    let lastMatch = -1;

    for (let queryIndex = 0; queryIndex < query.length; queryIndex++) {
        const ch = query[queryIndex];
        const found = value.indexOf(ch, valueIndex);
        if (found < 0) return null;
        score += found - valueIndex;
        if (lastMatch >= 0 && found === lastMatch + 1) score -= 1;
        lastMatch = found;
        valueIndex = found + 1;
    }

    return score;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniquePatterns(patterns: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const pattern of patterns) {
        const normalized = normalizePath(String(pattern ?? '').trim());
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function toVsCodeExcludeGlob(patterns: string[]): string | undefined {
    if (patterns.length === 0) return undefined;
    if (patterns.length === 1) return patterns[0];
    return `{${patterns.join(',')}}`;
}

function globToRegExp(glob: string): RegExp {
    const normalized = normalizePath(glob);
    let source = '^';
    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        const next = normalized[i + 1];
        if (ch === '*') {
            if (next === '*') {
                const after = normalized[i + 2];
                if (after === '/') {
                    source += '(?:.*/)?';
                    i += 2;
                } else {
                    source += '.*';
                    i += 1;
                }
            } else {
                source += '[^/]*';
            }
            continue;
        }
        if (ch === '?') {
            source += '[^/]';
            continue;
        }
        source += escapeRegExp(ch);
    }
    source += '$';
    return new RegExp(source, 'i');
}

function escapeRegExp(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}
