import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRootClaudeFiles, buildPathInstructions } from '../../../../pi/claude-compat/context';
import { indexClaudeRules } from '../../../../pi/claude-compat/rules';
import { isClaudePathExcluded, loadClaudeMdExcludes } from '../../../../pi/claude-compat/settings';

const temporaryDirectories: string[] = [];
function createWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-settings-'));
    temporaryDirectories.push(directory);
    return directory;
}
function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Claude memory exclusions', () => {
    it('loads ancestor instructions general-to-specific while preserving project dot/local order', () => {
        const parent = createWorkspace();
        const cwd = path.join(parent, 'workspace');
        const user = path.join(parent, '.test-user');
        writeFile(path.join(parent, 'CLAUDE.md'), 'ancestor');
        writeFile(path.join(parent, 'CLAUDE.local.md'), 'ancestor local');
        writeFile(path.join(cwd, 'CLAUDE.md'), 'project');
        writeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'project dot');
        writeFile(path.join(cwd, 'CLAUDE.local.md'), 'project local');

        expect(getRootClaudeFiles(cwd, { userClaudeDirectory: user })).toEqual([
            path.join(parent, 'CLAUDE.md'),
            path.join(parent, 'CLAUDE.local.md'),
            path.join(cwd, 'CLAUDE.md'),
            path.join(cwd, '.claude', 'CLAUDE.md'),
            path.join(cwd, 'CLAUDE.local.md'),
        ]);
    });

    it('merges user, project, and local claudeMdExcludes and applies absolute glob matching', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        writeFile(path.join(user, 'settings.json'), JSON.stringify({ claudeMdExcludes: [path.join(cwd, 'CLAUDE.md')] }));
        writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ claudeMdExcludes: [path.join(cwd, 'src', '**')] }));
        writeFile(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ claudeMdExcludes: [path.join(cwd, '.claude', 'rules', '**')] }));

        const excludes = loadClaudeMdExcludes(cwd, user);

        expect(excludes.patterns).toHaveLength(3);
        expect(isClaudePathExcluded(path.join(cwd, 'CLAUDE.md'), excludes)).toBe(true);
        expect(isClaudePathExcluded(path.join(cwd, 'src', 'CLAUDE.md'), excludes)).toBe(true);
    });

    it('excludes root, nested, and rule resources from compatibility loading', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        writeFile(path.join(cwd, 'CLAUDE.md'), 'excluded root');
        writeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'included root');
        writeFile(path.join(cwd, 'src', 'CLAUDE.md'), 'excluded nested');
        writeFile(path.join(cwd, 'src', 'file.ts'), '');
        writeFile(path.join(cwd, '.claude', 'rules', 'excluded.md'), 'excluded rule');
        writeFile(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({
            claudeMdExcludes: [
                path.join(cwd, 'CLAUDE.md'),
                path.join(cwd, 'src', '**'),
                path.join(cwd, '.claude', 'rules', '**'),
            ],
        }));
        const options = { userClaudeDirectory: user };

        expect(getRootClaudeFiles(cwd, options)).toEqual([path.join(cwd, '.claude', 'CLAUDE.md')]);
        expect(buildPathInstructions(cwd, ['src/file.ts'], new Set(), options).files).toEqual([]);
        expect(indexClaudeRules(cwd, options).rules).toEqual([]);
    });
});
