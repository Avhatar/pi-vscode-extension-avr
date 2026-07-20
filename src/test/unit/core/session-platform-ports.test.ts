import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_SESSION_RUNTIME_PORTS,
    type SessionRuntimePorts,
} from '../../../core/ports/session-platform';
import {
    VsCodeSessionSettings,
    VsCodeWorkspacePort,
    createVsCodeSessionRuntimePorts,
} from '../../../adapters/vscode/session-platform';
import { NodeSessionLock } from '../../../adapters/node/session-lock';
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

    it('composes explicit bundled-package paths and Codex response ownership', () => {
        const bundledPiPackagePaths = ['X:/extensions/pi-code/node_modules/pi-web-access'];
        const codexUsage = { updateFromHeaders: vi.fn(() => true) };

        const ports = createVsCodeSessionRuntimePorts(
            { bundledPiPackagePaths },
            codexUsage,
        );

        expect(ports.resources.bundledPiPackagePaths).toBe(bundledPiPackagePaths);
        expect(ports.codexUsage).toBe(codexUsage);
        expect(ports.sessionLocks).toBeInstanceOf(NodeSessionLock);
        expect(ports.extensions?.createLspExtension).toBeTypeOf('function');
        expect(createVsCodeSessionRuntimePorts().resources.bundledPiPackagePaths).toEqual([]);
    });

    it('keeps session, auth, Codex persistence, and tab notification state free of VS Code imports', () => {
        const readSource = (relativePath: string) => fs.readFileSync(path.resolve(relativePath), 'utf8');
        const sessionSource = readSource('src/pi/session.ts');
        const authSource = readSource('src/pi/auth.ts');
        const codexSource = readSource('src/pi/codex-usage-store.ts');
        const tabSource = readSource('src/core/chat/tab-runtime.ts');

        expect(authSource).not.toMatch(/from ['"]vscode['"]/);
        expect(codexSource).not.toMatch(/from ['"]vscode['"]/);
        expect(sessionSource).not.toMatch(/from ['"].*codex-usage-store['"]/);
        expect(sessionSource).not.toMatch(/from ['"].*\/lsp\/extension['"]/);
        expect(sessionSource).not.toMatch(/from ['"].*\/mcp\/claude-code-import['"]/);
        expect(tabSource).not.toMatch(/notifications\/turn-notification-gate/);
    });

    it('preserves one port set for replacement session construction', async () => {
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
            resources: {
                bundledPiPackagePaths: ['/extension/node_modules/pi-web-access'],
            },
            codexUsage: {
                updateFromHeaders: () => false,
            },
            sessionLocks: DEFAULT_SESSION_RUNTIME_PORTS.sessionLocks,
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

        await replacement.dispose();
        await manager.dispose();
    });
});
