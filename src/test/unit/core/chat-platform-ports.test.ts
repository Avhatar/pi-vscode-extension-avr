import { describe, expect, it, vi } from 'vitest';
import type { FileMentionsPort } from '../../../core/ports/chat-platform';
import type { FileChangePlatformPorts } from '../../../core/ports/file-state';
import {
    VsCodeStateStore,
    createVsCodeChatPlatformPorts,
    createVsCodeChatStatePorts,
} from '../../../adapters/vscode/chat-platform';

function createStateSource(initial: Record<string, unknown> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get: vi.fn((key: string, fallback?: unknown) => (
            values.has(key) ? values.get(key) : fallback
        )),
        update: vi.fn(async (key: string, value: unknown) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    };
}

function createFileMentionsPort(): FileMentionsPort {
    return {
        isReady: true,
        ensureIndexed: vi.fn(async () => undefined),
        search: vi.fn(async () => []),
        augmentPromptIfNeeded: vi.fn(async (text: string) => text),
    };
}

describe('portable chat platform ports', () => {
    it('adapts typed reads, fallbacks, writes, and deletion to a VS Code Memento', async () => {
        const source = createStateSource({ existing: 'value' });
        const store = new VsCodeStateStore(source as any);

        expect(store.get<string>('existing')).toBe('value');
        expect(store.get('missing', 'fallback')).toBe('fallback');

        await store.update('new-key', { enabled: true });
        expect(source.values.get('new-key')).toEqual({ enabled: true });
        expect(source.update).toHaveBeenCalledWith('new-key', { enabled: true });

        await store.update('existing', undefined);
        expect(source.values.has('existing')).toBe(false);
        expect(source.update).toHaveBeenCalledWith('existing', undefined);
    });

    it('composes isolated workspace/global state and preserves the file-mentions port identity', async () => {
        const workspaceState = createStateSource({ scope: 'workspace' });
        const globalState = createStateSource({ scope: 'global' });
        const context = { workspaceState, globalState };
        const fileMentions = createFileMentionsPort();
        const fileChanges = {
            fileState: {
                resolvePath: vi.fn((filePath: string) => filePath),
                readText: vi.fn(() => ''),
                exists: vi.fn(() => false),
                writeText: vi.fn(),
                deleteFile: vi.fn(),
            },
            diffPresenter: { openDiff: vi.fn(async () => undefined) },
        } satisfies FileChangePlatformPorts;

        const state = createVsCodeChatStatePorts(context as any);
        const ports = createVsCodeChatPlatformPorts(context as any, fileMentions, fileChanges);

        expect(state.workspace.get('scope')).toBe('workspace');
        expect(state.global.get('scope')).toBe('global');
        expect(ports.state.workspace.get('scope')).toBe('workspace');
        expect(ports.state.global.get('scope')).toBe('global');
        expect(ports.fileMentions).toBe(fileMentions);
        expect(ports.fileChanges).toBe(fileChanges);

        await ports.state.workspace.update('workspace-only', 1);
        expect(workspaceState.values.get('workspace-only')).toBe(1);
        expect(globalState.values.has('workspace-only')).toBe(false);
    });
});
