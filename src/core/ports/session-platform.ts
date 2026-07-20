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
}

export type SessionLockOwnerLiveness = 'alive' | 'dead' | 'unknown';

export interface SessionLockConflict {
    readonly sessionPath: string;
    readonly lockPath: string;
    readonly owner: SessionLockOwner | undefined;
    readonly ownerLiveness: SessionLockOwnerLiveness;
    readonly ageMs: number | undefined;
    readonly staleRecoveryAllowed: boolean;
}

export class SessionLockConflictError extends Error {
    readonly code = 'SESSION_LOCK_CONFLICT';

    constructor(readonly conflict: SessionLockConflict) {
        super(conflict.owner
            ? `Session is already open for writing by ${conflict.owner.applicationId} `
                + `(process ${conflict.owner.processId} on ${conflict.owner.hostname}).`
            : 'Session is already locked for writing.');
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
    recoverStale(sessionPath: string, expectedOwnerId: string): Promise<SessionLockHandle>;
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
