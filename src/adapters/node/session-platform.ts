import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import {
    DEFAULT_SESSION_RUNTIME_PORTS,
    type ModelSelection,
    type ModelSelectionOption,
    type SessionCodexUsagePort,
    type SessionDialogPort,
    type SessionRuntimePorts,
    type SessionSettingValues,
    type SessionSettingsPort,
    type SessionWorkspacePort,
} from '../../core/ports/session-platform';

const MATCH_OPTIONS = {
    dot: true,
    nocase: process.platform === 'win32',
} as const;

type TrustSource = boolean | (() => boolean);

/** Explicit-root workspace adapter for the production Node host. */
export class NodeSessionWorkspace implements SessionWorkspacePort {
    private readonly _root: string;

    constructor(root: string, private readonly _trusted: TrustSource) {
        this._root = fs.realpathSync.native(path.resolve(root));
    }

    getRoot(): string {
        return this._root;
    }

    isTrusted(): boolean {
        return typeof this._trusted === 'function' ? this._trusted() : this._trusted;
    }

    async findFiles(
        root: string,
        include: string,
        exclude: string,
        maxResults: number,
    ): Promise<string[]> {
        if (!Number.isInteger(maxResults) || maxResults <= 0) return [];
        const searchRoot = fs.realpathSync.native(path.resolve(root));
        assertWithinRoot(this._root, searchRoot);
        const results: string[] = [];
        await walkFiles(searchRoot, '', include, exclude, maxResults, results);
        return results;
    }
}

export class ObjectSessionSettings implements SessionSettingsPort {
    constructor(private readonly _values: Partial<SessionSettingValues> = {}) {}

    get<Key extends keyof SessionSettingValues>(
        key: Key,
        fallback: SessionSettingValues[Key],
    ): SessionSettingValues[Key] {
        const value = this._values[key];
        return value === undefined ? fallback : value as SessionSettingValues[Key];
    }
}

export interface CallbackSessionDialogOptions {
    warning?: (message: string) => void;
    selectModel?: (
        models: readonly ModelSelectionOption[],
        placeHolder: string,
    ) => Promise<ModelSelection | undefined>;
}

export class CallbackSessionDialogs implements SessionDialogPort {
    constructor(private readonly _options: CallbackSessionDialogOptions = {}) {}

    showWarning(message: string): void {
        this._options.warning?.(message);
    }

    selectModel(
        models: readonly ModelSelectionOption[],
        placeHolder: string,
    ): Promise<ModelSelection | undefined> {
        return this._options.selectModel?.(models, placeHolder) ?? Promise.resolve(undefined);
    }
}

export interface NodeSessionRuntimePortOptions {
    workspace: SessionWorkspacePort;
    settings?: SessionSettingsPort;
    dialogs?: SessionDialogPort;
    bundledPiPackagePaths?: readonly string[];
    codexUsage?: SessionCodexUsagePort;
}

export function createNodeSessionRuntimePorts(
    options: NodeSessionRuntimePortOptions,
): SessionRuntimePorts {
    return {
        workspace: options.workspace,
        settings: options.settings ?? new ObjectSessionSettings(),
        dialogs: options.dialogs ?? new CallbackSessionDialogs(),
        resources: {
            bundledPiPackagePaths: [...(options.bundledPiPackagePaths ?? [])],
        },
        codexUsage: options.codexUsage ?? DEFAULT_SESSION_RUNTIME_PORTS.codexUsage,
    };
}

async function walkFiles(
    root: string,
    relativeDirectory: string,
    include: string,
    exclude: string,
    maxResults: number,
    results: string[],
): Promise<void> {
    const directory = relativeDirectory
        ? path.join(root, ...relativeDirectory.split('/'))
        : root;
    const entries = await promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (results.length >= maxResults) return;
        const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            if (isExcluded(relativePath, exclude, true)) continue;
            await walkFiles(root, relativePath, include, exclude, maxResults, results);
            continue;
        }
        if (!entry.isFile() || isExcluded(relativePath, exclude, false)) continue;
        if (minimatch(relativePath, include, MATCH_OPTIONS)) {
            results.push(path.join(root, ...relativePath.split('/')));
        }
    }
}

function isExcluded(relativePath: string, pattern: string, directory: boolean): boolean {
    if (!pattern) return false;
    if (minimatch(relativePath, pattern, MATCH_OPTIONS)) return true;
    return directory && minimatch(`${relativePath}/__pi_probe__`, pattern, MATCH_OPTIONS);
}

function assertWithinRoot(workspaceRoot: string, candidate: string): void {
    const relative = path.relative(workspaceRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Workspace search root is outside the configured workspace.');
    }
}
