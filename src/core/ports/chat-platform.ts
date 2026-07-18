import type { WorkspaceFileSuggestion } from '../../shared/agent-protocol';

export interface StateStore {
    get<T>(key: string): T | undefined;
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
}

export interface ChatStatePorts {
    readonly workspace: StateStore;
    readonly global: StateStore;
}

export interface FileMentionsPort {
    readonly isReady: boolean;
    ensureIndexed(): Promise<void>;
    search(query: string, maxSuggestions?: number): Promise<WorkspaceFileSuggestion[]>;
    augmentPromptIfNeeded(text: string): Promise<string>;
}

export interface ChatPlatformPorts {
    readonly state: ChatStatePorts;
    readonly fileMentions: FileMentionsPort;
}
