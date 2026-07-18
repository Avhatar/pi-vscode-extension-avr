import type * as vscode from 'vscode';
import type {
    ChatPlatformPorts,
    ChatStatePorts,
    FileMentionsPort,
    StateStore,
} from '../../core/ports/chat-platform';

type StateSource = Pick<vscode.Memento, 'get' | 'update'>;
type StateContext = Pick<vscode.ExtensionContext, 'workspaceState' | 'globalState'>;

export class VsCodeStateStore implements StateStore {
    constructor(private readonly _source: StateSource) {}

    get<T>(key: string): T | undefined;
    get<T>(key: string, fallback: T): T;
    get<T>(key: string, fallback?: T): T | undefined {
        return this._source.get(key, fallback) as T | undefined;
    }

    update(key: string, value: unknown): PromiseLike<void> {
        return this._source.update(key, value);
    }
}

export function createVsCodeChatStatePorts(context: StateContext): ChatStatePorts {
    return {
        workspace: new VsCodeStateStore(context.workspaceState),
        global: new VsCodeStateStore(context.globalState),
    };
}

export function createVsCodeChatPlatformPorts(
    context: StateContext,
    fileMentions: FileMentionsPort,
): ChatPlatformPorts {
    return {
        state: createVsCodeChatStatePorts(context),
        fileMentions,
    };
}
