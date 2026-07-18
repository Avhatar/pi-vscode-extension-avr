import { describe, expect, it, vi } from 'vitest';
import type { SessionRuntimePorts } from '../../../core/ports/session-platform';
import {
    VsCodeSessionSettings,
    VsCodeWorkspacePort,
} from '../../../adapters/vscode/session-platform';
import { ChatController } from '../../../controllers/chat-controller';
import { PiSessionManager } from '../../../pi/session';

describe('portable session workspace and settings ports', () => {
    it('adapts VS Code workspace root, trust, file discovery, and typed configuration', async () => {
        const findFiles = vi.fn(async () => [{ fsPath: '/workspace/CLAUDE.md' }]);
        const source = {
            workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
            isTrusted: true,
            findFiles,
            getConfiguration: vi.fn(() => ({
                get: (key: string, fallback: unknown) => key === 'allowedTools' ? ['read'] : fallback,
            })),
        };
        const createRelativePattern = vi.fn((root: string, pattern: string) => ({ root, pattern }));
        const workspace = new VsCodeWorkspacePort(source as any, createRelativePattern as any);
        const settings = new VsCodeSessionSettings(source as any);

        expect(workspace.getRoot()).toBe('/workspace');
        expect(workspace.isTrusted()).toBe(true);
        await expect(workspace.findFiles('/workspace', '**/CLAUDE.md', '**/node_modules/**', 1))
            .resolves.toEqual(['/workspace/CLAUDE.md']);
        expect(createRelativePattern).toHaveBeenCalledWith('/workspace', '**/CLAUDE.md');
        expect(findFiles).toHaveBeenCalledWith(
            { root: '/workspace', pattern: '**/CLAUDE.md' },
            '**/node_modules/**',
            1,
        );
        expect(settings.get('allowedTools', [])).toEqual(['read']);
        expect(settings.get('lsp.enabled', false)).toBe(false);
        expect(source.getConfiguration).toHaveBeenCalledWith('pi-code');
    });

    it('preserves one port set for replacement session construction', () => {
        const ports: SessionRuntimePorts = {
            workspace: {
                getRoot: () => '/workspace',
                isTrusted: () => true,
                findFiles: async () => [],
            },
            settings: { get: (_key, fallback) => fallback },
            dialogs: {
                showWarning: () => undefined,
                selectModel: async () => undefined,
            },
        };
        const secrets = {
            get: vi.fn(async () => undefined),
            store: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        const manager = new PiSessionManager(
            { appendLine: vi.fn() },
            secrets,
            undefined,
            undefined,
            undefined,
            undefined,
            ports,
        );

        expect(manager.ports).toBe(ports);

        const controller = Object.create(ChatController.prototype) as any;
        controller._sessionLogger = manager.logger;
        controller._sessionSecrets = manager.secrets;
        controller._sessionPorts = ports;
        controller._context = { secrets: undefined };
        controller._subagentCoordinator = undefined;
        controller._subagentStore = undefined;
        controller._writeIsolation = undefined;
        controller._childToolFactories = undefined;
        const replacement = controller._createSessionManager();

        expect(replacement.logger).toBe(manager.logger);
        expect(replacement.secrets).toBe(manager.secrets);
        expect(replacement.ports).toBe(ports);

        replacement.dispose();
        manager.dispose();
    });
});
