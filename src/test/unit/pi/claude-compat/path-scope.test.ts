import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectNestedClaudeFiles, isSameOrDescendant } from '../../../../pi/claude-compat/path-scope';

const temporaryDirectories: string[] = [];

function createWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-scope-'));
    temporaryDirectories.push(directory);
    return directory;
}

function writeFile(filePath: string, content = ''): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Claude path scope', () => {
    it('collects nested instructions from general to specific without the root bootstrap', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'CLAUDE.md'));
        writeFile(path.join(cwd, 'src', 'CLAUDE.md'));
        writeFile(path.join(cwd, 'src', 'CLAUDE.local.md'));
        writeFile(path.join(cwd, 'src', 'feature', 'CLAUDE.md'));
        writeFile(path.join(cwd, 'src', 'feature', 'CLAUDE.local.md'));
        const target = path.join(cwd, 'src', 'feature', 'file.ts');
        writeFile(target);

        const result = collectNestedClaudeFiles(cwd, target);

        expect(result.map((file) => path.relative(cwd, file).replace(/\\/g, '/'))).toEqual([
            'src/CLAUDE.md',
            'src/CLAUDE.local.md',
            'src/feature/CLAUDE.md',
            'src/feature/CLAUDE.local.md',
        ]);
    });

    it('rejects sibling paths that merely share the workspace prefix', () => {
        const parent = createWorkspace();
        const cwd = path.join(parent, 'project');
        const siblingTarget = path.join(parent, 'project-other', 'file.ts');
        writeFile(siblingTarget);

        expect(isSameOrDescendant(cwd, siblingTarget)).toBe(false);
        expect(collectNestedClaudeFiles(cwd, siblingTarget)).toEqual([]);
    });
});
