import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CallbackSessionDialogs,
    NodeSessionWorkspace,
    ObjectSessionSettings,
    createNodeSessionRuntimePorts,
} from '../../../../adapters/node/session-platform';
import { NodeLogger } from '../../../../adapters/node/logger';

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-node-workspace-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function writeFile(root: string, relativePath: string): Promise<void> {
    const target = path.join(root, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, relativePath, 'utf8');
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })));
});

describe('NodeSessionWorkspace', () => {
    it('uses an explicit canonical root and explicit trust source', async () => {
        const root = await createWorkspace();
        let trusted = false;
        const workspace = new NodeSessionWorkspace(root, () => trusted);

        expect(workspace.getRoot()).toBe(await fs.realpath(root));
        expect(workspace.isTrusted()).toBe(false);
        trusted = true;
        expect(workspace.isTrusted()).toBe(true);
    });

    it('finds files deterministically with include, exclude, bound, and no symlink traversal', async () => {
        const root = await createWorkspace();
        await writeFile(root, 'src/a.ts');
        await writeFile(root, 'src/b.md');
        await writeFile(root, 'src/c.js');
        await writeFile(root, 'node_modules/pkg/hidden.ts');
        await writeFile(root, '.pi/rules/visible.md');
        const outside = await createWorkspace();
        await writeFile(outside, 'escaped.ts');
        await fs.symlink(outside, path.join(root, 'linked'), 'junction');
        const workspace = new NodeSessionWorkspace(root, true);

        const matches = await workspace.findFiles(
            root,
            '**/*.{ts,md}',
            '**/node_modules/**',
            10,
        );
        expect(matches).toEqual([
            path.join(root, '.pi', 'rules', 'visible.md'),
            path.join(root, 'src', 'a.ts'),
            path.join(root, 'src', 'b.md'),
        ]);
        await expect(workspace.findFiles(root, '**/*', '', 2)).resolves.toHaveLength(2);
        expect(matches).not.toContain(path.join(outside, 'escaped.ts'));
    });
});

describe('Node session runtime composition', () => {
    it('supplies settings, dialogs, resources, and usage callbacks without host imports', async () => {
        const root = await createWorkspace();
        const warning = vi.fn();
        const selectModel = vi.fn(async () => ({ provider: 'openai', modelId: 'gpt' }));
        const settings = new ObjectSessionSettings({
            allowedTools: ['read'],
            thinkingLevel: 'high',
        });
        const dialogs = new CallbackSessionDialogs({ warning, selectModel });
        const codexUsage = { updateFromHeaders: vi.fn(() => true) };
        const ports = createNodeSessionRuntimePorts({
            workspace: new NodeSessionWorkspace(root, true),
            settings,
            dialogs,
            bundledPiPackagePaths: [path.join(root, 'packages', 'pi-web-access')],
            codexUsage,
        });

        expect(ports.settings.get('allowedTools', [])).toEqual(['read']);
        expect(ports.settings.get('defaultModel', 'fallback')).toBe('fallback');
        ports.dialogs.showWarning('warning');
        expect(warning).toHaveBeenCalledWith('warning');
        await expect(ports.dialogs.selectModel([], 'Choose')).resolves.toEqual({
            provider: 'openai', modelId: 'gpt',
        });
        expect(ports.resources.bundledPiPackagePaths).toEqual([
            path.join(root, 'packages', 'pi-web-access'),
        ]);
        expect(ports.codexUsage.updateFromHeaders({ header: 'value' })).toBe(true);
    });

    it('forwards logger lines to an injected Node sink', () => {
        const sink = vi.fn();
        const logger = new NodeLogger(sink);
        logger.appendLine('ready');
        expect(sink).toHaveBeenCalledWith('ready');
    });
});
