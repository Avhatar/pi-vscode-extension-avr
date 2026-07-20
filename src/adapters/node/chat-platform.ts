import type {
    ChatPlatformPorts,
    FileMentionsPort,
    StateStore,
} from '../../core/ports/chat-platform';
import type { FileChangePlatformPorts } from '../../core/ports/file-state';

export interface NodeChatPlatformPortOptions {
    readonly workspace: StateStore;
    readonly global: StateStore;
    readonly fileMentions: FileMentionsPort;
    readonly fileChanges: FileChangePlatformPorts;
}

export function createNodeChatPlatformPorts(
    options: NodeChatPlatformPortOptions,
): ChatPlatformPorts {
    return {
        state: {
            workspace: options.workspace,
            global: options.global,
        },
        fileMentions: options.fileMentions,
        fileChanges: options.fileChanges,
    };
}
