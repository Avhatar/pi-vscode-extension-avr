import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import * as path from 'node:path';
import type { FileMentionsPort } from '../../core/ports/chat-platform';
import type { Logger } from '../../core/ports/logger';
import {
    augmentPromptWithFileMentions,
    compileFileMentionExcludePatterns,
    createFileMentionEntry,
    isFileMentionPathExcluded,
    resolveFileMentionConfig,
    searchFileMentionEntries,
    toFileMentionExcludeGlob,
    type FileMentionConfig,
    type FileMentionEntry,
    type FileMentionSettingsInput,
    type ProjectFileMentionConfig,
} from '../../core/files/file-mentions';
import type { WorkspaceFileSuggestion } from '../../shared/agent-protocol';
import { NodeSessionWorkspace } from './session-platform';

export interface NodeFileMentionWatcher {
    close(): void;
}

export type NodeFileMentionWatchFactory = (
    root: string,
    listener: () => void,
) => NodeFileMentionWatcher;

export interface NodeFileMentionsOptions {
    readonly workspaceRoot: string;
    readonly settings?: FileMentionSettingsInput;
    readonly logger?: Pick<Logger, 'appendLine'>;
    readonly watch?: boolean;
    readonly watchFactory?: NodeFileMentionWatchFactory;
    readonly rebuildDebounceMs?: number;
}

const MAX_INDEXED_FILES = Number.MAX_SAFE_INTEGER;

/** Node filesystem index for the shared portable file-mention policy. */
export class NodeFileMentions implements FileMentionsPort {
    private readonly _workspaceRoot: string;
    private readonly _workspace: NodeSessionWorkspace;
    private readonly _settings: FileMentionSettingsInput;
    private readonly _logger: Pick<Logger, 'appendLine'> | undefined;
    private readonly _watchEnabled: boolean;
    private readonly _watchFactory: NodeFileMentionWatchFactory;
    private readonly _rebuildDebounceMs: number;
    private _entries: FileMentionEntry[] = [];
    private _entriesByRelativePath = new Map<string, FileMentionEntry>();
    private _config: FileMentionConfig | undefined;
    private _indexingPromise: Promise<void> | undefined;
    private _watcher: NodeFileMentionWatcher | undefined;
    private _rebuildTimer: NodeJS.Timeout | undefined;
    private _rebuildAfterIndex = false;
    private _ready = false;
    private _disposed = false;

    constructor(options: NodeFileMentionsOptions) {
        this._workspaceRoot = fs.realpathSync.native(path.resolve(options.workspaceRoot));
        this._workspace = new NodeSessionWorkspace(this._workspaceRoot, true);
        this._settings = options.settings ?? {};
        this._logger = options.logger;
        this._watchEnabled = options.watch ?? true;
        this._watchFactory = options.watchFactory ?? defaultWatchFactory;
        this._rebuildDebounceMs = Math.max(0, options.rebuildDebounceMs ?? 250);
    }

    get isReady(): boolean {
        return this._ready;
    }

    async ensureIndexed(): Promise<void> {
        if (this._disposed || this._ready) return;
        if (this._indexingPromise) return this._indexingPromise;
        this._indexingPromise = this._buildIndex()
            .catch((error: unknown) => {
                this._logger?.appendLine(
                    `Workspace file mention indexing failed: ${errorMessage(error)}`,
                );
            })
            .finally(() => {
                this._indexingPromise = undefined;
                if (this._rebuildAfterIndex && !this._disposed) {
                    this._rebuildAfterIndex = false;
                    this._invalidateAndRebuild();
                }
            });
        return this._indexingPromise;
    }

    async search(query: string, maxSuggestions?: number): Promise<WorkspaceFileSuggestion[]> {
        if (this._disposed) return [];
        await this.ensureIndexed();
        if (!this._ready || !this._config?.enabled) return [];
        return searchFileMentionEntries(
            this._entries,
            query,
            maxSuggestions ?? this._config.maxSuggestions,
        );
    }

    async augmentPromptIfNeeded(text: string): Promise<string> {
        if (!text.includes('@')) return text;
        await this.ensureIndexed();
        return augmentPromptWithFileMentions(text, this._entriesByRelativePath);
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._ready = false;
        this._entries = [];
        this._entriesByRelativePath.clear();
        this._config = undefined;
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this._rebuildTimer = undefined;
        this._rebuildAfterIndex = false;
        this._watcher?.close();
        this._watcher = undefined;
    }

    private async _buildIndex(): Promise<void> {
        const baseConfig = resolveFileMentionConfig(this._settings);
        const projectConfig = await this._loadProjectConfig(baseConfig.configPath);
        const config = resolveFileMentionConfig(this._settings, projectConfig);
        const compiledExcludes = compileFileMentionExcludePatterns(config.exclude);
        let entries: FileMentionEntry[] = [];
        if (config.enabled) {
            const files = await this._workspace.findFiles(
                this._workspaceRoot,
                '**/*',
                toFileMentionExcludeGlob(config.exclude) ?? '',
                MAX_INDEXED_FILES,
            );
            entries = files
                .map((filePath) => path.relative(this._workspaceRoot, filePath))
                .filter((relativePath) => relativePath
                    && !relativePath.startsWith('..')
                    && !path.isAbsolute(relativePath))
                .map(createFileMentionEntry)
                .filter((entry) => !isFileMentionPathExcluded(
                    entry.relativePath,
                    compiledExcludes,
                ))
                .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        }
        if (this._disposed) return;
        this._entries = entries;
        this._entriesByRelativePath = new Map(
            entries.map((entry) => [entry.relativePathLower, entry]),
        );
        this._config = config;
        this._ready = true;
        this._ensureWatcher();
        this._logger?.appendLine(
            `Workspace file mention index ready: ${entries.length} file(s).`,
        );
    }

    private async _loadProjectConfig(configPath: string): Promise<ProjectFileMentionConfig> {
        try {
            const absolutePath = path.resolve(
                this._workspaceRoot,
                ...configPath.split('/').filter(Boolean),
            );
            const relative = path.relative(this._workspaceRoot, absolutePath);
            if (path.isAbsolute(configPath)
                || relative.startsWith('..')
                || path.isAbsolute(relative)) {
                throw new Error('File mention config path is outside the workspace.');
            }
            const parsed = JSON.parse(await promises.readFile(absolutePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            const candidate = parsed as Record<string, unknown>;
            return {
                ...(typeof candidate.useDefaultExcludes === 'boolean'
                    ? { useDefaultExcludes: candidate.useDefaultExcludes }
                    : {}),
                ...(Array.isArray(candidate.exclude)
                    ? { exclude: candidate.exclude.filter((value): value is string => typeof value === 'string') }
                    : {}),
                ...(typeof candidate.maxSuggestions === 'number'
                    ? { maxSuggestions: candidate.maxSuggestions }
                    : {}),
            };
        } catch (error) {
            if (!isMissingFileError(error)) {
                this._logger?.appendLine(
                    `Failed to load workspace file mention config ${configPath}: ${errorMessage(error)}`,
                );
            }
            return {};
        }
    }

    private _ensureWatcher(): void {
        if (!this._watchEnabled || this._watcher || this._disposed) return;
        try {
            this._watcher = this._watchFactory(this._workspaceRoot, () => {
                if (this._disposed) return;
                if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
                this._rebuildTimer = setTimeout(() => {
                    this._rebuildTimer = undefined;
                    if (this._disposed) return;
                    if (this._indexingPromise) {
                        this._rebuildAfterIndex = true;
                        return;
                    }
                    this._invalidateAndRebuild();
                }, this._rebuildDebounceMs);
            });
        } catch (error) {
            this._logger?.appendLine(
                `Workspace file mention watcher failed: ${errorMessage(error)}`,
            );
        }
    }

    private _invalidateAndRebuild(): void {
        this._ready = false;
        this._entries = [];
        this._entriesByRelativePath.clear();
        this._config = undefined;
        void this.ensureIndexed();
    }
}

function defaultWatchFactory(root: string, listener: () => void): NodeFileMentionWatcher {
    return fs.watch(root, { recursive: true }, () => listener());
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
