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

export interface SessionRuntimePorts {
    workspace: SessionWorkspacePort;
    settings: SessionSettingsPort;
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
};
