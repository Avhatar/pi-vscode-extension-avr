import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    indexClaudeResources,
    matchingNestedClaudeSkills,
    renderClaudeInvocableResource,
    renderClaudeSkillCatalog,
    renderNestedClaudeSkillCatalog,
} from '../../../../pi/claude-compat/resources';

const temporaryDirectories: string[] = [];
function createWorkspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-resources-'));
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

describe('Claude skill and command resources', () => {
    it('applies user-before-project and skill-before-command precedence', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        writeFile(path.join(user, 'skills', 'review', 'SKILL.md'), '---\ndescription: User review skill\n---\nUSER_SKILL');
        writeFile(path.join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: Project review skill\n---\nPROJECT_SKILL');
        writeFile(path.join(cwd, '.claude', 'commands', 'review.md'), 'COMMAND_REVIEW');
        writeFile(path.join(cwd, '.claude', 'commands', 'frontend', 'component.md'), 'Create a component.');

        const index = indexClaudeResources(cwd, { userClaudeDirectory: user });

        expect(index.skills).toHaveLength(1);
        expect(index.skills[0].body).toBe('USER_SKILL');
        expect(index.commands.map((command) => command.name)).toEqual(['frontend:component']);
        expect(index.diagnostics.filter((diagnostic) => diagnostic.kind === 'collision')).toHaveLength(2);
    });

    it('adapts optional Claude metadata without granting runtime-specific capabilities', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        writeFile(path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), [
            '---',
            'name: Deploy display name',
            'description: Use when: deploying safely',
            'when_to_use: Use for releases.',
            'arguments: [target, branch]',
            'argument-hint: "<target> [branch]"',
            'user-invocable: false',
            'allowed-tools: [Bash, Read]',
            'model: opus',
            'context: fork',
            '---',
            '# Deploy safely',
        ].join('\n'));

        const index = indexClaudeResources(cwd, { userClaudeDirectory: user });
        const skill = index.skills[0];

        expect(skill.name).toBe('deploy');
        expect(skill.displayName).toBe('Deploy display name');
        expect(skill.description).toContain('Use when: deploying safely');
        expect(skill.description).toContain('Use for releases.');
        expect(skill.userInvocable).toBe(false);
        expect(skill.arguments).toEqual(['target', 'branch']);
        expect(index.diagnostics.some((diagnostic) =>
            diagnostic.kind === 'unsupported-runtime-field' && diagnostic.message.includes('allowed-tools'),
        )).toBe(true);
        expect(index.diagnostics.some((diagnostic) => diagnostic.kind === 'frontmatter-error')).toBe(true);
        expect(renderClaudeSkillCatalog(index, cwd)).toContain('deploy: Use when: deploying safely Use for releases.');
    });

    it('renders Claude skill substitutions behind the Pi compatibility boundary', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        writeFile(path.join(cwd, '.claude', 'skills', 'migrate', 'SKILL.md'), [
            '---',
            'description: Migrate a component',
            'arguments: [component, source]',
            'allowed-tools: Bash',
            '---',
            'Migrate $component from $source to $2. First=$0 indexed=$ARGUMENTS[1] all=$ARGUMENTS.',
            'Skill=${CLAUDE_SKILL_DIR} Project=${CLAUDE_PROJECT_DIR} Session=${CLAUDE_SESSION_ID} Effort=${CLAUDE_EFFORT}.',
            '!`git status`',
        ].join('\n'));
        const resource = indexClaudeResources(cwd, { userClaudeDirectory: user }).skills[0];

        const rendered = renderClaudeInvocableResource(resource, 'SearchBar React Vue', cwd, 'session-42', 'high');

        expect(rendered).toContain('Remain the current Pi agent');
        expect(rendered).toContain('Migrate SearchBar from React to Vue. First=SearchBar indexed=React all=SearchBar React Vue.');
        expect(rendered).toContain(`Skill=${resource.baseDir.replace(/\\/g, '/')}`);
        expect(rendered).toContain(`Project=${cwd.replace(/\\/g, '/')}`);
        expect(rendered).toContain('Session=session-42 Effort=high');
        expect(rendered).toContain('do not alter the current Pi identity, permissions, model, or tool contract');
        expect(rendered).toContain('dynamic-shell-execution');
    });

    it('renders legacy commands with one-based positional arguments and nested names', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        writeFile(path.join(cwd, '.claude', 'commands', 'issue', 'fix.md'), [
            '---',
            'description: Fix an issue',
            'argument-hint: "<number>"',
            '---',
            'Fix $1 with all input: $ARGUMENTS. Missing=$2.',
        ].join('\n'));
        const command = indexClaudeResources(cwd, { userClaudeDirectory: user }).commands[0];

        expect(command.name).toBe('issue:fix');
        expect(renderClaudeInvocableResource(command, '123', cwd)).toContain('Fix 123 with all input: 123. Missing=.');
    });

    it('qualifies nested skills and activates them only for paths in their directory scope', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        const rootSkill = path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md');
        const nestedSkill = path.join(cwd, 'apps', 'web', '.claude', 'skills', 'deploy', 'SKILL.md');
        const generatedSkill = path.join(cwd, 'ExampleGame', 'Library', 'PackageCache', 'package', '.claude', 'skills', 'changelog', 'SKILL.md');
        writeFile(rootSkill, '---\ndescription: Deploy root\n---\nROOT');
        writeFile(nestedSkill, '---\ndescription: Deploy web\n---\nWEB');
        writeFile(generatedSkill, '---\ndescription: Generated changelog\n---\nIGNORE');

        const index = indexClaudeResources(cwd, {
            userClaudeDirectory: user,
            projectSkillFiles: [nestedSkill, generatedSkill],
        });

        expect(index.skills.map((skill) => skill.name)).toEqual(['deploy', 'apps/web:deploy']);
        expect(index.diagnostics.some((diagnostic) => diagnostic.path === generatedSkill)).toBe(true);
        expect(renderClaudeSkillCatalog(index, cwd)).toContain('deploy: Deploy root');
        expect(renderClaudeSkillCatalog(index, cwd)).not.toContain('apps/web:deploy');
        expect(matchingNestedClaudeSkills(index, ['apps/web/src/file.ts'], cwd).map((skill) => skill.name))
            .toEqual(['apps/web:deploy']);
        expect(matchingNestedClaudeSkills(index, ['apps/api/file.ts'], cwd)).toEqual([]);
        expect(renderNestedClaudeSkillCatalog(index.skills.slice(1), cwd)).toContain('apps/web:deploy');
    });

    it('deduplicates symlink aliases by canonical skill target', () => {
        const cwd = createWorkspace();
        const user = path.join(cwd, '.test-user');
        const shared = path.join(cwd, 'shared-skill');
        writeFile(path.join(shared, 'SKILL.md'), '---\ndescription: Shared\n---\nSHARED');
        const skills = path.join(cwd, '.claude', 'skills');
        fs.mkdirSync(skills, { recursive: true });
        try {
            fs.symlinkSync(shared, path.join(skills, 'first'), process.platform === 'win32' ? 'junction' : 'dir');
            fs.symlinkSync(shared, path.join(skills, 'second'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            return;
        }

        expect(indexClaudeResources(cwd, { userClaudeDirectory: user }).skills).toHaveLength(1);
    });
});
