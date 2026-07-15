import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    clearClaudeRuleCache,
    indexClaudeRules,
    extractRuleToolTargets,
    matchingClaudeRules,
    ruleMatchesPath,
} from '../../../../pi/claude-compat/rules';

const temporaryDirectories: string[] = [];

function createWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-rules-'));
    temporaryDirectories.push(directory);
    return directory;
}

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function indexRules(cwd: string) {
    return indexClaudeRules(cwd, { userClaudeDirectory: path.join(cwd, '.test-user-claude') });
}

afterEach(() => {
    clearClaudeRuleCache();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Claude rules', () => {
    it('parses project-wide and path-scoped rules recursively', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'global.md'), 'Always preserve compatibility.\n');
        writeFile(path.join(cwd, '.claude', 'rules', 'code', 'typescript.md'), [
            '---',
            'paths:',
            '  - "src/**/*.ts"',
            '  - "tests/file?.ts"',
            '---',
            'Use strict TypeScript.',
        ].join('\n'));

        const result = indexRules(cwd);

        expect(result.diagnostics).toEqual([]);
        expect(result.rules.map((rule) => rule.relativePath)).toEqual([
            '.claude/rules/code/typescript.md',
            '.claude/rules/global.md',
        ]);
        expect(result.rules[0].patterns).toEqual(['src/**/*.ts', 'tests/file?.ts']);
        expect(result.rules[0].projectWide).toBe(false);
        expect(result.rules[0].content).toBe('Use strict TypeScript.');
        expect(result.rules[1].projectWide).toBe(true);
    });

    it('matches exact paths and *, **, and ? wildcards', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'paths.md'), [
            '---',
            'paths: ["src/**/*.ts", "docs/file?.md", "exact/config.json"]',
            '---',
            'Scoped.',
        ].join('\n'));
        const rule = indexRules(cwd).rules[0];

        expect(ruleMatchesPath(rule, 'src/features/auth.ts', cwd)).toBe(true);
        expect(ruleMatchesPath(rule, 'docs/file1.md', cwd)).toBe(true);
        expect(ruleMatchesPath(rule, 'exact/config.json', cwd)).toBe(true);
        expect(ruleMatchesPath(rule, 'docs/file10.md', cwd)).toBe(false);
        expect(ruleMatchesPath(rule, 'src', cwd, true)).toBe(true);
        expect(ruleMatchesPath(rule, 'outside/file.ts', cwd)).toBe(false);
        expect(matchingClaudeRules([rule], extractRuleToolTargets('grep', {}), cwd)).toEqual([rule]);
        expect(matchingClaudeRules([rule], extractRuleToolTargets('ls', {}), cwd)).toEqual([]);
    });

    it('loads user rules before project rules and supports brace and bracket globs', () => {
        const cwd = createWorkspace();
        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        writeFile(path.join(userClaudeDirectory, 'rules', 'user.md'), 'USER_RULE\n');
        writeFile(path.join(cwd, '.claude', 'rules', 'project.md'), [
            '---',
            'paths: ["src/**/*.{ts,tsx}", "tests/file[0-9].ts", "broken[/path", "docs/**"]',
            '---',
            'PROJECT_RULE',
        ].join('\n'));

        const result = indexRules(cwd);

        expect(result.rules.map((rule) => rule.sourceScope)).toEqual(['user', 'project']);
        expect(ruleMatchesPath(result.rules[1], 'src/view.tsx', cwd)).toBe(true);
        expect(ruleMatchesPath(result.rules[1], 'tests/file7.ts', cwd)).toBe(true);
        expect(ruleMatchesPath(result.rules[1], 'docs/guide.md', cwd)).toBe(true);
        expect(result.rules[1].patterns).not.toContain('broken[/path');
        expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'invalid-pattern')).toBe(true);
    });

    it('does not turn malformed scoped frontmatter into a project-wide rule', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'invalid.md'), [
            '---',
            'paths:',
            '  nested: invalid',
            '---',
            'Must not become global.',
        ].join('\n'));

        const result = indexRules(cwd);

        expect(result.rules[0].projectWide).toBe(false);
        expect(result.rules[0].patterns).toEqual([]);
        expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'invalid-paths')).toBe(true);
        expect(matchingClaudeRules(result.rules, [{ path: 'src/file.ts', directoryScope: false }], cwd)).toEqual([]);
    });

    it('refreshes a rule fingerprint and content when the file changes', () => {
        const cwd = createWorkspace();
        const file = path.join(cwd, '.claude', 'rules', 'global.md');
        writeFile(file, 'before\n');
        const before = indexRules(cwd).rules[0];
        writeFile(file, 'after with a different size\n');
        const after = indexRules(cwd).rules[0];

        expect(after.content).toBe('after with a different size');
        expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it('follows symlinked rule directories and protects against directory cycles', () => {
        const cwd = createWorkspace();
        const externalDirectory = path.join(cwd, 'shared-rules');
        const rulesDirectory = path.join(cwd, '.claude', 'rules');
        writeFile(path.join(externalDirectory, 'shared.md'), 'Shared directory rule.\n');
        fs.mkdirSync(rulesDirectory, { recursive: true });
        try {
            fs.symlinkSync(
                externalDirectory,
                path.join(rulesDirectory, 'shared'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            fs.symlinkSync(
                rulesDirectory,
                path.join(externalDirectory, 'cycle'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        } catch {
            return;
        }

        const rules = indexRules(cwd).rules;
        expect(rules).toHaveLength(1);
        expect(rules[0].relativePath).toBe('.claude/rules/shared/shared.md');
    });

    it('loads rule files reached through symlinks and retains the project-facing path', () => {
        const cwd = createWorkspace();
        const outside = path.join(cwd, 'outside.md');
        const alias = path.join(cwd, '.claude', 'rules', 'alias.md');
        writeFile(outside, 'Outside rule.\n');
        fs.mkdirSync(path.dirname(alias), { recursive: true });
        try {
            fs.symlinkSync(outside, alias, 'file');
        } catch {
            return;
        }

        const rules = indexRules(cwd).rules;
        expect(rules).toHaveLength(1);
        expect(rules[0].relativePath).toBe('.claude/rules/alias.md');
        expect(rules[0].content).toBe('Outside rule.');
    });
});
