import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceFileMentions } from '../../../workspace/file-mentions';
import {
    resetTestWorkspace,
    setTestWorkspaceFiles,
    setTestWorkspaceRoot,
} from '../../mocks/vscode';

describe('WorkspaceFileMentions', () => {
    let temporaryDirectory: string;
    let mentions: WorkspaceFileMentions;
    let output: string[];
    let outsideFile: string;

    beforeEach(() => {
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-mentions-test-'));
        outsideFile = path.join(path.dirname(temporaryDirectory), `${path.basename(temporaryDirectory)}-outside.ts`);
        setTestWorkspaceRoot(temporaryDirectory);
        output = [];
        mentions = new WorkspaceFileMentions({
            appendLine(value: string): void {
                output.push(value);
            },
        } as any);
    });

    afterEach(() => {
        mentions.dispose();
        resetTestWorkspace();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        fs.rmSync(outsideFile, { force: true });
    });

    it('indexes only allowed files within the workspace and formats canonical mentions', async () => {
        const foo = createFile('src/Foo.ts');
        const fooBar = createFile('src/FooBar.ts');
        const spaced = createFile('docs/space name.md');
        const excluded = createFile('node_modules/pkg/a.js');
        fs.writeFileSync(outsideFile, 'outside\n', 'utf8');
        setTestWorkspaceFiles([foo, fooBar, spaced, excluded, outsideFile]);

        await mentions.ensureIndexed();

        expect(mentions.isReady).toBe(true);
        expect(output).toEqual([
            expect.stringMatching(/^Workspace file mention index ready: 3 file\(s\) in \d+ ms\.$/),
        ]);
        expect((await mentions.search('foo')).map(result => result.relativePath)).toEqual([
            'src/Foo.ts',
            'src/FooBar.ts',
        ]);
        expect(await mentions.search('space')).toEqual([{
            relativePath: 'docs/space name.md',
            basename: 'space name.md',
            insertText: '@{docs/space name.md} ',
        }]);

        const prompt = 'Review @SRC/foo.ts and @{docs/space name.md}; again @src/Foo.ts.';
        expect(mentions.augmentPrompt(prompt)).toBe(
            `${prompt}\n\nReferenced workspace files to inspect if needed:\n` +
            '- docs/space name.md\n' +
            '- src/Foo.ts',
        );

    });

    function createFile(relativePath: string): string {
        const absolutePath = path.join(temporaryDirectory, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, relativePath, 'utf8');
        return absolutePath;
    }
});
