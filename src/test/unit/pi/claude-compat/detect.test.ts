import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectClaudeInfrastructure } from '../../../../pi/claude-compat/detect';

const temporaryDirectories: string[] = [];

function createWorkspace(prefix = 'pi-claude-detect-'): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function writeFile(filePath: string, content = '# Test\n'): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('detectClaudeInfrastructure', () => {
    it('stays inactive for an empty workspace', async () => {
        const cwd = createWorkspace();

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [],
        });

        expect(result.active).toBe(false);
        expect(result.activationReasons).toEqual([]);
    });

    it('does not treat an empty .claude directory as infrastructure', async () => {
        const cwd = createWorkspace();
        fs.mkdirSync(path.join(cwd, '.claude'));

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [],
        });

        expect(result.active).toBe(false);
    });

    it('activates for a root CLAUDE.md without running the broad search', async () => {
        const cwd = createWorkspace();
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd);
        let nestedSearches = 0;

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => {
                nestedSearches++;
                return [];
            },
        });

        expect(result.active).toBe(true);
        expect(result.activationReasons).toContain('root-context');
        expect(result.rootContextFiles).toEqual([claudeMd]);
        expect(nestedSearches).toBe(0);
    });

    it('activates for a root CLAUDE.local.md marker', async () => {
        const cwd = createWorkspace();
        const local = path.join(cwd, 'CLAUDE.local.md');
        writeFile(local);

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
        });

        expect(result.active).toBe(true);
        expect(result.activationReasons).toContain('root-local-context');
        expect(result.rootContextFiles).toContain(local);
    });

    it('can collect nested files for an explicit diagnostic scan after root activation', async () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        const nested = path.join(cwd, 'src', 'CLAUDE.md');
        writeFile(root);
        writeFile(nested);

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            collectNestedClaudeFiles: true,
            findNestedClaudeFiles: async () => [root, nested],
        });

        expect(result.rootContextFiles).toEqual([root]);
        expect(result.nestedContextFiles).toEqual([nested]);
        expect(result.activationReasons).toContain('nested-context');
    });

    it('activates for a nested CLAUDE.md when no root marker exists', async () => {
        const cwd = createWorkspace();
        const nested = path.join(cwd, 'src', 'feature', 'CLAUDE.md');
        writeFile(nested);

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [nested],
        });

        expect(result.active).toBe(true);
        expect(result.activationReasons).toEqual(['nested-context']);
        expect(result.nestedContextFiles).toEqual([nested]);
    });

    it('activates for a nested project skill without root Claude markers', async () => {
        const cwd = createWorkspace();
        const nestedSkill = path.join(cwd, 'apps', 'web', '.claude', 'skills', 'deploy', 'SKILL.md');
        writeFile(nestedSkill, '---\ndescription: Deploy web\n---\nDeploy.\n');

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [],
            findNestedClaudeSkillFiles: async () => [nestedSkill],
        });

        expect(result.active).toBe(true);
        expect(result.activationReasons).toContain('nested-skills');
        expect(result.nestedSkillFiles).toEqual([nestedSkill]);
    });

    it('rejects generated cache resources while retaining intentional ignored workspace context', async () => {
        const cwd = createWorkspace();
        const packageContext = path.join(cwd, 'ExampleGame', 'Library', 'PackageCache', 'package', 'CLAUDE.md');
        const packageSkill = path.join(cwd, 'ExampleGame', 'Library', 'PackageCache', 'package', '.claude', 'skills', 'changelog', 'SKILL.md');
        const workspaceContext = path.join(cwd, '.project-state', 'task', 'CLAUDE.md');
        writeFile(packageContext);
        writeFile(packageSkill, '---\ndescription: Generated package skill\n---\nIgnore.\n');
        writeFile(workspaceContext);

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            collectNestedClaudeFiles: true,
            collectNestedClaudeSkillFiles: true,
            findNestedClaudeFiles: async () => [packageContext, workspaceContext],
            findNestedClaudeSkillFiles: async () => [packageSkill],
        });

        expect(result.nestedContextFiles).toEqual([workspaceContext]);
        expect(result.nestedSkillFiles).toEqual([]);
        expect(result.activationReasons).toContain('nested-context');
        expect(result.activationReasons).not.toContain('nested-skills');
    });

    it('rejects nested-search results outside the workspace', async () => {
        const cwd = createWorkspace();
        const outside = path.join(createWorkspace('pi-claude-outside-'), 'CLAUDE.md');
        writeFile(outside);

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [outside],
        });

        expect(result.active).toBe(false);
        expect(result.nestedContextFiles).toEqual([]);
    });

    it('detects only non-empty Claude resource categories', async () => {
        const cwd = createWorkspace();
        fs.mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true });
        writeFile(path.join(cwd, '.claude', 'skills', 'review', 'SKILL.md'));
        writeFile(path.join(cwd, '.claude', 'rules', 'typescript.md'));

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
        });

        expect(result.activationReasons).toContain('project-skills');
        expect(result.activationReasons).toContain('project-rules');
        expect(result.activationReasons).not.toContain('project-commands');
        expect(result.skillDirectories).toEqual([path.join(cwd, '.claude', 'skills')]);
        expect(result.ruleDirectories).toEqual([path.join(cwd, '.claude', 'rules')]);
    });

    it('treats a CLAUDE.md that only redirects to AGENTS.md as a shim and stays inactive', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '@AGENTS.md\n');

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [],
        });

        expect(result.active).toBe(false);
        expect(result.activationReasons).toEqual([]);
        expect(result.rootContextFiles).toEqual([]);
        expect(result.shimContextFiles).toEqual([claudeMd]);
    });

    it('forces activation for a shim CLAUDE.md when collapseShimContext is false', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const claudeMd = path.join(cwd, 'CLAUDE.md');
        writeFile(claudeMd, '@AGENTS.md\n');

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            collapseShimContext: false,
            findNestedClaudeFiles: async () => [],
        });

        expect(result.active).toBe(true);
        expect(result.activationReasons).toContain('root-context');
        expect(result.rootContextFiles).toEqual([claudeMd]);
        expect(result.shimContextFiles).toEqual([]);
    });

    it('keeps a real CLAUDE.md active while separately filtering a sibling shim in .claude/', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'AGENTS.md'), '# Project rules\n');
        const rootClaude = path.join(cwd, 'CLAUDE.md');
        writeFile(rootClaude, '# Overrides\n\nExtra guidance beyond AGENTS.md.\n');
        const shimClaude = path.join(cwd, '.claude', 'CLAUDE.md');
        writeFile(shimClaude, '@../AGENTS.md\n');

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: path.join(cwd, 'missing-plugins.json'),
            findNestedClaudeFiles: async () => [],
        });

        expect(result.active).toBe(true);
        expect(result.rootContextFiles).toEqual([rootClaude]);
        expect(result.shimContextFiles).toEqual([shimClaude]);
    });

    it('activates only for project-scoped plugins that contain the workspace', async () => {
        const cwd = createWorkspace();
        const otherProject = createWorkspace('pi-claude-other-project-');
        const pluginsPath = path.join(createWorkspace('pi-claude-plugin-state-'), 'installed_plugins.json');
        writeFile(pluginsPath, JSON.stringify({
            plugins: {
                'matching@marketplace': [{
                    scope: 'project',
                    projectPath: cwd,
                    installPath: path.join(cwd, '.plugin-cache', 'matching'),
                }],
                'other@marketplace': [{
                    scope: 'project',
                    projectPath: otherProject,
                    installPath: path.join(otherProject, '.plugin-cache', 'other'),
                }],
                'global@marketplace': [{
                    scope: 'user',
                    installPath: path.join(otherProject, '.plugin-cache', 'global'),
                }],
            },
        }));

        const result = await detectClaudeInfrastructure(cwd, {
            installedPluginsPath: pluginsPath,
            findNestedClaudeFiles: async () => [],
        });

        expect(result.activationReasons).toContain('project-plugin');
        expect(result.pluginInstalls.map((plugin) => plugin.key)).toEqual(['matching@marketplace']);
    });
});
