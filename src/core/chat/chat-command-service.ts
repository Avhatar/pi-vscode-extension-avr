import type {
    AgentClientMessage,
    AgentServerMessage,
    CacheMode,
} from '../../shared/agent-protocol';
import type { FileMentionsPort } from '../ports/chat-platform';
import {
    ChatService,
    type ChatServiceTab,
    type DirectPromptCallbacks,
    type FileHistoryTarget,
    type StreamingCommandCallbacks,
} from './chat-service';

export interface ChatCommandSession {
    getModels(): any[];
    getCurrentModel(): any;
    getThinkingLevel(): string | undefined;
    setModel(provider: string, modelId: string): Promise<void>;
    setThinkingLevel(level: string): void;
    getSessions(): Promise<any[]>;
    readonly session?: { readonly sessionId?: string };
    getSkills(): any[];
}

export type ChatCommandIntent =
    | { readonly type: 'setCacheMode'; readonly mode: CacheMode }
    | { readonly type: 'setModel'; readonly provider: string; readonly modelId: string }
    | { readonly type: 'setThinkingLevel'; readonly level: string }
    | { readonly type: 'toggleFavorite'; readonly provider: string; readonly modelId: string }
    | { readonly type: 'newSession' }
    | { readonly type: 'loadSession'; readonly sessionPath: string }
    | { readonly type: 'createTab' }
    | { readonly type: 'closeTab'; readonly tabId: string }
    | { readonly type: 'switchTab'; readonly tabId: string }
    | { readonly type: 'setTodoEnabled'; readonly enabled: boolean }
    | { readonly type: 'setSubagentsEnabled'; readonly enabled: boolean }
    | { readonly type: 'setPlanModeEnabled'; readonly enabled: boolean }
    | { readonly type: 'setFileUndoViewEnabled'; readonly enabled: boolean }
    | { readonly type: 'setToolDisabled'; readonly toolName: string; readonly disabled: boolean }
    | { readonly type: 'setToolsBulk'; readonly disabled: string[] };

export interface ChatCommandCallbacks {
    readonly directPrompt: DirectPromptCallbacks;
    readonly streaming: StreamingCommandCallbacks;
    readonly fileMentions: FileMentionsPort;
    getFavorites(): readonly string[];
    handleName(text: string, hasAttachments: boolean, publishState?: boolean): boolean;
    publishState(): void;
    emit(message: AgentServerMessage): void;
    notifyFileHistory(kind: 'restore' | 'redo', fileCount: number): void;
}

export interface ChatCommandOutcome {
    readonly intent?: ChatCommandIntent;
}

export type ChatCommandTab = ChatServiceTab
    & FileHistoryTarget
    & { readonly session: ChatServiceTab['session'] & FileHistoryTarget['session'] & ChatCommandSession };

export function parseNameCommand(text: string): string | undefined | null {
    const trimmed = text.trim();
    if (trimmed === '/name') return undefined;
    const match = /^\/name\s+([\s\S]+)$/.exec(trimmed);
    if (!match) return null;
    return match[1].replace(/\s+/g, ' ').trim().slice(0, 60) || undefined;
}

/** Portable routing for commands whose semantics belong to the shared agent application. */
export class ChatCommandService {
    constructor(private readonly chat: ChatService) {}

    async dispatch(
        tab: ChatCommandTab,
        message: AgentClientMessage,
        callbacks: ChatCommandCallbacks,
    ): Promise<ChatCommandOutcome> {
        switch (message.type) {
            case 'prompt':
                if (callbacks.handleName(
                    message.text,
                    Boolean(message.images?.length || message.files?.length),
                )) return {};
                await this.chat.dispatchDirectPrompt(tab, message, callbacks.directPrompt);
                return {};
            case 'steer':
            case 'followUp':
                if (callbacks.handleName(
                    message.text,
                    Boolean(message.images?.length || message.files?.length),
                )) return {};
                await this.chat.dispatchStreamingCommand(message, callbacks.streaming);
                return {};
            case 'abort':
                await this.chat.dispatchStreamingCommand(message, callbacks.streaming);
                return {};
            case 'queueMessage':
                if (callbacks.handleName(message.text, false)) return {};
                this.chat.applyQueueControl(tab, message);
                callbacks.publishState();
                return {};
            case 'editQueuedMessage':
            case 'removeQueuedMessage':
            case 'cancelQueue':
                this.chat.applyQueueControl(tab, message);
                callbacks.publishState();
                return {};
            case 'setCacheMode':
                return { intent: { type: 'setCacheMode', mode: message.mode } };
            case 'setTodoEnabled':
            case 'setSubagentsEnabled':
            case 'setPlanModeEnabled':
            case 'setFileUndoViewEnabled':
            case 'setToolDisabled':
            case 'setToolsBulk':
                return { intent: message };
            case 'getModels':
                callbacks.emit({
                    type: 'models',
                    models: tab.session.getModels(),
                    current: tab.session.getCurrentModel(),
                    thinkingLevel: tab.session.getThinkingLevel(),
                    favorites: [...callbacks.getFavorites()],
                });
                return {};
            case 'setModel':
                return { intent: message };
            case 'toggleFavorite':
                return {
                    intent: {
                        type: 'toggleFavorite',
                        provider: message.provider,
                        modelId: message.modelId,
                    },
                };
            case 'setThinkingLevel':
                return { intent: message };
            case 'newSession':
                return { intent: { type: 'newSession' } };
            case 'loadSession':
                return { intent: { type: 'loadSession', sessionPath: message.sessionPath } };
            case 'getSessions':
                callbacks.emit({
                    type: 'sessions',
                    sessions: await tab.session.getSessions(),
                    currentSessionId: tab.session.session?.sessionId,
                });
                return {};
            case 'getState':
                callbacks.publishState();
                return {};
            case 'renameTab':
                callbacks.handleName(`/name ${message.name}`, false);
                return {};
            case 'getSkills':
                callbacks.emit({ type: 'skills', skills: tab.session.getSkills() });
                return {};
            case 'searchWorkspaceFiles':
                if (!callbacks.fileMentions.isReady) {
                    const indexing = callbacks.fileMentions.ensureIndexed();
                    callbacks.emit({
                        type: 'workspaceFileSuggestions',
                        requestId: message.requestId,
                        query: message.query,
                        isIndexing: true,
                        items: [],
                    });
                    await indexing;
                }
                callbacks.emit({
                    type: 'workspaceFileSuggestions',
                    requestId: message.requestId,
                    query: message.query,
                    items: await callbacks.fileMentions.search(message.query),
                });
                return {};
            case 'undoFileChange':
                await this.chat.undoFileChange(tab, message.filePath, message.toolCallId);
                callbacks.publishState();
                return {};
            case 'restoreCheckpoint': {
                const files = await this.chat.restoreCheckpoint(tab, message.messageIndex);
                if (files.length > 0) callbacks.notifyFileHistory('restore', files.length);
                callbacks.publishState();
                return {};
            }
            case 'redoCheckpoint': {
                const files = await this.chat.redoCheckpoint(tab);
                if (files.length > 0) callbacks.notifyFileHistory('redo', files.length);
                callbacks.publishState();
                return {};
            }
            case 'createTab':
                return { intent: { type: 'createTab' } };
            case 'closeTab':
                return { intent: { type: 'closeTab', tabId: message.tabId } };
            case 'switchTab':
                return { intent: { type: 'switchTab', tabId: message.tabId } };
        }
        const exhaustive: never = message;
        return exhaustive;
    }
}
