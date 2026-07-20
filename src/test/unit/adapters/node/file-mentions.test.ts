import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeFileMentions } from '../../../../adapters/node/file-mentions';

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-node-mentions-'));
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

describe('NodeFileMentions', () => {
    it('matches VS Code ordering, exclusions, insert text, and prompt augmentation', async () => {
        const root = await createWorkspace();
        await writeFile(root, 'src/Foo.ts');
        await writeFile(root, 'src/FooBar.ts');
        await writeFile(root, 'docs/space name.md');
        await writeFile(root, 'node_modules/pkg/hidden.ts');
        await writeFile(root, '.env.local');
        const mentions = new NodeFileMentions({ workspaceRoot: root, watch: false });

        await mentions.ensureIndexed();

        expect(mentions.isReady).toBe(true);
        expect((await mentions.search('foo')).map((item) => item.relativePath)).toEqual([
            'src/Foo.ts',
            'src/FooBar.ts',
        ]);
        expect(await mentions.search('space')).toEqual([{
            relativePath: 'docs/space name.md',
            basename: 'space name.md',
            insertText: '@{docs/space name.md} ',
        }]);
        const prompt = 'Review @SRC/foo.ts and @{docs/space name.md}; again @src/Foo.ts.';
        expect(await mentions.augmentPromptIfNeeded(prompt)).toBe(
            `${prompt}\n\nReferenced workspace files to inspect if needed:\n` +
            '- docs/space name.md\n' +
            '- src/Foo.ts',
        );
        mentions.dispose();
    });

    it('applies project config precedence and suggestion limits', async () => {
        const root = await createWorkspace();
        await writeFile(root, 'src/a.ts');
        await writeFile(root, 'src/b.ts');
        await writeFile(root, 'generated/c.ts');
        await writeFile(root, '.pi/file-mentions.json');
        await fs.writeFile(path.join(root, '.pi', 'file-mentions.json'), JSON.stringify({
            useDefaultExcludes: false,
            exclude: ['generated/**'],
            maxSuggestions: 1,
        }), 'utf8');
        const mentions = new NodeFileMentions({
            workspaceRoot: root,
            watch: false,
            settings: { exclude: ['src/b.ts'], maxSuggestions: 10 },
        });

        await mentions.ensureIndexed();
        expect(await mentions.search('')).toEqual([{
            relativePath: 'src/a.ts',
            basename: 'a.ts',
            insertText: '@src/a.ts ',
        }]);
        expect(await mentions.search('a', 10)).toEqual([{
            relativePath: 'src/a.ts',
            basename: 'a.ts',
            insertText: '@src/a.ts ',
        }]);
        mentions.dispose();
    });

    it('closes the watcher and ignores late watcher events after disposal', async () => {
        const root = await createWorkspace();
        await writeFile(root, 'src/a.ts');
        let listener: (() => void) | undefined;
        const close = vi.fn();
        const log = vi.fn();
        const mentions = new NodeFileMentions({
            workspaceRoot: root,
            logger: { appendLine: log },
            rebuildDebounceMs: 0,
            watchFactory: (_root, callback) => {
                listener = callback;
                return { close };
            },
        });
        await mentions.ensureIndexed();
        await writeFile(root, 'src/b.ts');
        listener?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await mentions.ensureIndexed();
        expect((await mentions.search('b')).map((item) => item.relativePath)).toEqual(['src/b.ts']);
        const loggedBeforeDispose = log.mock.calls.length;

        mentions.dispose();
        listener?.();
        await Promise.resolve();

        expect(close).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledTimes(loggedBeforeDispose);
        expect(await mentions.search('a')).toEqual([]);
    });
});
