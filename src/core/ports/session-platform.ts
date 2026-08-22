export interface SecretStore {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
}

export interface ModelSelectionOption {
    provider: string;
    id: string;
    label: string;
}

export interface ModelSelection {
    provider: string;
    modelId: string;
}

export interface SessionDialogPort {
    showWarning(message: string): void;
    selectModel(
        models: readonly ModelSelectionOption[],
        placeHolder: string,
    ): Promise<ModelSelection | undefined>;
}

export interface SessionSettingValues {
    allowedTools: string[];
    'todo.promptGuidelines': string | undefined;
    'lsp.enabled': boolean;
    'mcp.importClaudeCode': boolean;
    'rawMode.enabled': boolean;
    thinkingLevel: string;
    defaultModel: string;
    'subagents.defaultModel': string;
    'subagents.allowedModels': string[];
    'subagents.allowInvocationModelOverride': boolean;
    'subagents.defaultMaxTurns': number;
    'subagents.defaultTimeoutMinutes': number;
    'subagents.maxConcurrentPerChat': number;
}

export interface SessionSettingsPort {
    get<Key extends keyof SessionSettingValues>(
        key: Key,
        fallback: SessionSettingValues[Key],
    ): SessionSettingValues[Key];
}

export interface SessionWorkspacePort {
    getRoot(): string | undefined;
    isTrusted(): boolean;
    findFiles(root: string, include: string, exclude: string, maxResults: number): Promise<string[]>;
}

export interface SessionResourcePaths {
    readonly bundledPiPackagePaths: readonly string[];
}

export interface SessionExtensionPort {
    createLspExtension(enabled: boolean): ((api: any) => void) | undefined;
    syncClaudeCodeMcpImport?(enabled: boolean): { changed: boolean; path: string };
}

export interface SessionCodexUsagePort {
    updateFromHeaders(headers: Record<string, string>): boolean;
}

export interface SessionLockOwner {
    readonly ownerId: string;
    readonly applicationId: string;
    readonly processId: number;
    readonly hostname: string;
    readonly acquiredAt: number;
    /**
     * OS boot instant observed by the owner, in epoch milliseconds. It proves a
     * lock predates the current boot, which is the only reliable evidence that a
     * crashed owner is gone after the recorded process id was recycled by an
     * unrelated process. Absent in locks written by older releases.
     */
    readonly bootTimeMs?: number;
}

export type SessionLockOwnerLiveness = 'alive' | 'dead' | 'unknown';

export interface SessionLockConflict {
    readonly sessionPath: string;
    readonly lockPath: string;
    readonly owner: SessionLockOwner | undefined;
    readonly ownerLiveness: SessionLockOwnerLiveness;
    readonly ageMs: number | undefined;
    readonly staleRecoveryAllowed: boolean;
    /** True when the lock was written before the current OS boot. */
    readonly ownerBootMismatch?: boolean;
}

/** Actionable one-line diagnosis of why a writable session could not be opened. */
export function describeSessionLockConflict(conflict: SessionLockConflict): string {
    const owner = conflict.owner;
    if (!owner) {
        return `Session lock file ${conflict.lockPath} cannot be read, so its owner is unknown. `
            + 'Close any other Pi Code instance using this chat, or delete that file and try again.';
    }
    const identity = `${owner.applicationId} (process ${owner.processId} on ${owner.hostname})`;
    if (conflict.ownerLiveness === 'alive') {
        return `Session is already open for writing by ${identity}. `
            + 'Close that chat tab or Pi Code instance, then try again.';
    }
    if (conflict.ownerLiveness === 'dead') {
        return `Session was left locked by ${identity}, which is no longer running. `
            + `Try again to reclaim it, or delete ${conflict.lockPath}.`;
    }
    return `Session is locked by ${identity}, and this machine cannot check whether that `
        + `process still runs. Close it there, or delete ${conflict.lockPath} if that host is offline.`;
}

export class SessionLockConflictError extends Error {
    readonly code = 'SESSION_LOCK_CONFLICT';

    constructor(readonly conflict: SessionLockConflict) {
        super(describeSessionLockConflict(conflict));
        this.name = 'SessionLockConflictError';
    }
}

export interface SessionLockHandle {
    readonly sessionPath: string;
    readonly owner: SessionLockOwner;
    release(): Promise<void>;
}

export interface SessionLockPort {
    acquire(sessionPath: string): Promise<SessionLockHandle>;
    /**
     * Reclaims a lock whose owner is provably gone. `expectedOwnerId` is the
     * owner observed in the conflict, or `undefined` when the lock file could not
     * be parsed; recovery is refused when the on-disk owner no longer matches it.
     */
    recoverStale(
        sessionPath: string,
        expectedOwnerId: string | undefined,
    ): Promise<SessionLockHandle>;
}

export interface SessionRuntimePorts {
    workspace: SessionWorkspacePort;
    settings: SessionSettingsPort;
    dialogs: SessionDialogPort;
    resources: SessionResourcePaths;
    extensions?: SessionExtensionPort;
    codexUsage: SessionCodexUsagePort;
    sessionLocks: SessionLockPort;
}

export const DEFAULT_SESSION_RUNTIME_PORTS: SessionRuntimePorts = {
    workspace: {
        getRoot: () => undefined,
        isTrusted: () => false,
        findFiles: async () => [],
    },
    settings: {
        get: (_key, fallback) => fallback,
    },
    dialogs: {
        showWarning: () => undefined,
        selectModel: async () => undefined,
    },
    resources: {
        bundledPiPackagePaths: [],
    },
    extensions: {
        createLspExtension: () => undefined,
    },
    codexUsage: {
        updateFromHeaders: () => false,
    },
    sessionLocks: {
        acquire: async (sessionPath) => createUnlockedSessionHandle(sessionPath),
        recoverStale: async (sessionPath) => createUnlockedSessionHandle(sessionPath),
    },
};

function createUnlockedSessionHandle(sessionPath: string): SessionLockHandle {
    return {
        sessionPath,
        owner: {
            ownerId: 'unlocked-session',
            applicationId: 'none',
            processId: 0,
            hostname: '',
            acquiredAt: 0,
        },
        release: async () => undefined,
    };
}
