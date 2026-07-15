import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRegistry, parseAgentFile } from '../../../../pi/subagents/registry';
import type { AgentDefinition } from '../../../../pi/subagents/types';

const temporaryDirectories: string[] = [];

function createFixture(): { root: string; cwd: string; user: string; project: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-registry-'));
    temporaryDirectories.push(root);
    return {
        root,
        cwd: path.join(root, 'workspace'),
        user: path.join(root, 'home', '.pi', 'agent', 'agents'),
        project: path.join(root, 'workspace', '.pi', 'agents'),
    };
}

function writeAgent(filePath: string, frontmatter: string[], body = 'Follow the delegated task.'): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, ['---', ...frontmatter, '---', body, ''].join('\n'), 'utf8');
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('native subagent definition registry', () => {
    it('parses strict native frontmatter aliases and instructions', async () => {
        const fixture = createFixture();
        const filePath = path.join(fixture.user, 'review.md');
        writeAgent(filePath, [
            'name: review',
            'description: Review changes',
            'model: deepseek/deepseek-reasoner',
            'thinking-level: high',
            'tools: read, grep',
            'disallowed-tools: [bash]',
            'max-turns: 12',
            'timeout-minutes: 8',
            'context-mode: fresh',
            'mcp-servers: [docs]',
        ], 'Review carefully.');

        const parsed = await parseAgentFile(filePath, 'user');

        expect(parsed.diagnostics).toEqual([]);
        expect(parsed.definition).toMatchObject({
            name: 'review',
            description: 'Review changes',
            model: { provider: 'deepseek', id: 'deepseek-reasoner' },
            thinkingLevel: 'high',
            tools: ['read', 'grep'],
            disallowedTools: ['bash'],
            maxTurns: 12,
            timeoutMinutes: 8,
            contextMode: 'fresh',
            mcpServers: ['docs'],
            instructions: 'Review carefully.',
            source: 'user',
        });
    });

    it('rejects missing frontmatter, unknown fields, and invalid values', async () => {
        const fixture = createFixture();
        const missing = path.join(fixture.user, 'missing.md');
        const invalid = path.join(fixture.user, 'invalid.md');
        fs.mkdirSync(path.dirname(missing), { recursive: true });
        fs.writeFileSync(missing, 'No frontmatter', 'utf8');
        writeAgent(invalid, [
            'name: invalid name',
            'description: Invalid',
            'model: missing-provider-separator',
            'maxTurns: 0',
            'unknown: true',
        ]);

        expect((await parseAgentFile(missing, 'user')).diagnostics[0].code).toBe('frontmatter-error');
        const parsedInvalid = await parseAgentFile(invalid, 'user');
        expect(parsedInvalid.definition).toBeUndefined();
        expect(parsedInvalid.diagnostics[0].code).toBe('invalid-definition');
        expect(parsedInvalid.diagnostics[0].message).toContain('Unknown frontmatter fields');
    });

    it('applies runtime, project, user, and package precedence deterministically', async () => {
        const fixture = createFixture();
        writeAgent(path.join(fixture.user, 'review.md'), ['name: review', 'description: User review']);
        writeAgent(path.join(fixture.project, 'review.md'), ['name: review', 'description: Project review']);
        const packageDefinition: AgentDefinition = {
            name: 'review', description: 'Package review', source: 'package',
        };
        const runtimeDefinition: AgentDefinition = {
            name: 'review', description: 'Runtime review', source: 'runtime',
        };
        const registry = new AgentRegistry({
            cwd: fixture.cwd,
            workspaceTrusted: true,
            userAgentsDirectory: fixture.user,
            projectAgentsDirectory: fixture.project,
            packageDefinitions: [packageDefinition],
            runtimeDefinitions: [runtimeDefinition],
        });

        const snapshot = await registry.reload();

        expect(registry.get('REVIEW')).toMatchObject({ source: 'runtime', description: 'Runtime review' });
        expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === 'shadowed-definition')).toHaveLength(3);
    });

    it('does not read project agents when the workspace is untrusted', async () => {
        const fixture = createFixture();
        writeAgent(path.join(fixture.user, 'review.md'), ['name: review', 'description: User review']);
        writeAgent(path.join(fixture.project, 'review.md'), ['name: review', 'description: Project review']);
        const registry = new AgentRegistry({
            cwd: fixture.cwd,
            workspaceTrusted: false,
            userAgentsDirectory: fixture.user,
            projectAgentsDirectory: fixture.project,
        });

        const snapshot = await registry.reload();

        expect(registry.get('review')?.source).toBe('user');
        expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'untrusted-project' }));
    });

    it('rejects duplicate names within the winning scope instead of using filesystem order', async () => {
        const fixture = createFixture();
        writeAgent(path.join(fixture.project, 'a.md'), ['name: duplicate', 'description: A']);
        writeAgent(path.join(fixture.project, 'nested', 'b.md'), ['name: DUPLICATE', 'description: B']);
        writeAgent(path.join(fixture.user, 'fallback.md'), ['name: duplicate', 'description: User fallback']);
        const registry = new AgentRegistry({
            cwd: fixture.cwd,
            workspaceTrusted: true,
            userAgentsDirectory: fixture.user,
            projectAgentsDirectory: fixture.project,
        });

        const snapshot = await registry.reload();

        expect(registry.get('duplicate')).toBeUndefined();
        expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === 'duplicate-name')).toHaveLength(2);
    });
});
