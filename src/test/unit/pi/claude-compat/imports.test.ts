import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CLAUDE_IMPORT_DEPTH_LIMIT,
    clearInstructionImportCache,
    expandInstructionFiles,
} from '../../../../pi/claude-compat/imports';

const temporaryDirectories: string[] = [];

function createWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-imports-'));
    temporaryDirectories.push(directory);
    return directory;
}

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
    clearInstructionImportCache();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Claude instruction imports', () => {
    it('expands project-relative imports depth-first and deduplicates canonical files', () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, 'root\n@docs/one.md\n@docs/two.md\n');
        writeFile(path.join(cwd, 'docs', 'one.md'), 'one\n@shared.md\n');
        writeFile(path.join(cwd, 'docs', 'two.md'), 'two\n@shared.md\n');
        writeFile(path.join(cwd, 'docs', 'shared.md'), 'shared\n');

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files.map((file) => path.basename(file.path))).toEqual([
            'CLAUDE.md', 'one.md', 'shared.md', 'two.md',
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it('deduplicates the same imported file reached through a symbolic link', () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        const shared = path.join(cwd, 'shared.md');
        const alias = path.join(cwd, 'alias.md');
        writeFile(root, '@shared.md\n@alias.md\n');
        writeFile(shared, 'shared\n');
        try {
            fs.symlinkSync(shared, alias, 'file');
        } catch {
            return; // Some Windows environments do not grant symlink permission.
        }

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files.filter((file) => file.content === 'shared\n')).toHaveLength(1);
    });

    it('detects cycles without duplicating files', () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, '@docs/a.md\n');
        writeFile(path.join(cwd, 'docs', 'a.md'), '@../CLAUDE.md\n');

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files).toHaveLength(2);
        expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'cycle')).toBe(true);
    });

    it('rejects project imports that escape the workspace', () => {
        const parent = createWorkspace();
        const cwd = path.join(parent, 'workspace');
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, '@../outside.md\n');
        writeFile(path.join(parent, 'outside.md'), 'outside secret\n');

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files).toHaveLength(1);
        expect(result.files[0].content).not.toContain('outside secret');
        expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'outside-root')).toBe(true);
    });

    it('caps recursive imports at four hops', () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, '@level-1.md\n');
        for (let level = 1; level <= CLAUDE_IMPORT_DEPTH_LIMIT + 1; level++) {
            const next = level <= CLAUDE_IMPORT_DEPTH_LIMIT ? `@level-${level + 1}.md\n` : 'end\n';
            writeFile(path.join(cwd, `level-${level}.md`), next);
        }

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files.at(-1)?.depth).toBe(CLAUDE_IMPORT_DEPTH_LIMIT);
        expect(result.files.some((file) => file.path.endsWith(`level-${CLAUDE_IMPORT_DEPTH_LIMIT + 1}.md`))).toBe(false);
        expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'depth-limit')).toBe(true);
    });

    it('ignores imports in code and comments and strips non-code HTML comments from delivered content', () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, [
            '@real.md',
            '`@inline.md`',
            '```md',
            '@fenced.md',
            '<!-- keep this human-only @comment.md -->',
            '```',
            '<!-- remove this human-only @comment.md -->',
        ].join('\n'));
        writeFile(path.join(cwd, 'real.md'), 'REAL_IMPORT\n');
        writeFile(path.join(cwd, 'inline.md'), 'INLINE_IMPORT\n');
        writeFile(path.join(cwd, 'fenced.md'), 'FENCED_IMPORT\n');
        writeFile(path.join(cwd, 'comment.md'), 'COMMENT_IMPORT\n');

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files.map((file) => path.basename(file.path))).toEqual(['CLAUDE.md', 'real.md']);
        expect(result.files[0].content).toContain('<!-- keep this human-only @comment.md -->');
        expect(result.files[0].content).not.toContain('remove this human-only');
    });

    it('resolves relative imports only from the containing file', () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, '@nested/source.md\n');
        writeFile(path.join(cwd, 'nested', 'source.md'), '@target.md\n');
        writeFile(path.join(cwd, 'nested', 'target.md'), 'SOURCE_RELATIVE\n');
        writeFile(path.join(cwd, 'target.md'), 'WORKSPACE_RELATIVE_WRONG\n');

        const result = expandInstructionFiles([root], { cwd });

        expect(result.files.at(-1)?.content).toBe('SOURCE_RELATIVE\n');
    });

    it('invalidates a cached graph when any imported dependency changes', async () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        const imported = path.join(cwd, 'imported.md');
        writeFile(root, '@imported.md\n');
        writeFile(imported, 'before\n');
        const first = expandInstructionFiles([root], { cwd });

        await new Promise((resolve) => setTimeout(resolve, 10));
        writeFile(imported, 'after with a different size\n');
        const second = expandInstructionFiles([root], { cwd });

        expect(first.files.at(-1)?.content).toBe('before\n');
        expect(second.files.at(-1)?.content).toBe('after with a different size\n');
    });
});
