import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isClaudeMdShim } from '../../../../pi/claude-compat/shim';

const temporaryDirectories: string[] = [];

function createWorkspace(prefix = 'pi-claude-shim-'): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('isClaudeMdShim', () => {
    it('treats a single-line @AGENTS.md redirect as a shim', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '@AGENTS.md\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(true);
    });

    it('accepts a shim with leading/trailing whitespace', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '\n\n   @AGENTS.md   \n\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(true);
    });

    it('accepts a shim with an explicit relative prefix', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '@./AGENTS.md\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(true);
    });

    it('rejects a CLAUDE.md that contains prose alongside the import', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '# Overrides\n\n@AGENTS.md\n\nDo not run rm -rf.\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(false);
    });

    it('rejects a CLAUDE.md whose imports target a different file', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        writeFile(path.join(cwd, 'RULES.md'), '# Extra\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '@RULES.md\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(false);
    });

    it('rejects a CLAUDE.md when AGENTS.md does not exist at the workspace root', () => {
        const cwd = createWorkspace();
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '@AGENTS.md\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(false);
    });

    it('rejects an empty CLAUDE.md', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '\n\n   \n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(false);
    });

    it('ignores @-tokens that appear inside fenced code blocks', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '```\n@AGENTS.md\n```\n');

        expect(isClaudeMdShim(claudeMd, cwd)).toBe(false);
    });

    it('returns false when the file does not exist', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        expect(isClaudeMdShim(path.join(cwd, 'missing.md'), cwd)).toBe(false);
    });
});
