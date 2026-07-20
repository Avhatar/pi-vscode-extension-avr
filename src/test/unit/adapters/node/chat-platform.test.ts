import { describe, expect, it } from 'vitest';
import { createNodeChatPlatformPorts } from '../../../../adapters/node/chat-platform';

describe('Node chat platform composition', () => {
    it('composes supplied state, file mention, and file change adapters without wrapping identity', () => {
        const workspace = { get: () => undefined, update: async () => undefined } as any;
        const global = { get: () => undefined, update: async () => undefined } as any;
        const fileMentions = {
            isReady: true,
            ensureIndexed: async () => undefined,
            search: async () => [],
            augmentPromptIfNeeded: async (text: string) => text,
        };
        const fileChanges = {
            fileState: {} as any,
            diffPresenter: {} as any,
        };

        expect(createNodeChatPlatformPorts({ workspace, global, fileMentions, fileChanges }))
            .toEqual({
                state: { workspace, global },
                fileMentions,
                fileChanges,
            });
    });
});
