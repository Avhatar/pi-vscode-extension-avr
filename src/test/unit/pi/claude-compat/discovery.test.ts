import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { isExcludedClaudeDiscoveryPath } from '../../../../pi/claude-compat/discovery';

describe('Claude nested discovery exclusions', () => {
    const cwd = path.resolve('workspace');

    it.each([
        'ExampleGame/Library/PackageCache/package/.claude/skills/changelog/SKILL.md',
        'ExampleGame/Temp/generated/CLAUDE.md',
        'Tools/server/obj/Debug/CLAUDE.md',
        'Tools/server/bin/Debug/.claude/skills/build/SKILL.md',
        'app/node_modules/package/CLAUDE.md',
        'app/dist/CLAUDE.md',
        'app/.git/worktrees/task/CLAUDE.md',
    ])('excludes generated or dependency path %s', (candidate) => {
        expect(isExcludedClaudeDiscoveryPath(cwd, path.join(cwd, candidate))).toBe(true);
    });

    it.each([
        '.project-state/task/CLAUDE.md',
        '.project-state/task/.claude/skills/research/SKILL.md',
        'ExampleGame/Assets/Code/CLAUDE.md',
        'Tools/mcp-servers/CLAUDE.md',
    ])('retains intentional project infrastructure %s', (candidate) => {
        expect(isExcludedClaudeDiscoveryPath(cwd, path.join(cwd, candidate))).toBe(false);
    });
});
