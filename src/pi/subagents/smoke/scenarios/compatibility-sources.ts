import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChildToolFactoryRegistry, registerChildSafeMcpTool } from '../../child-tools';
import { indexClaudeAgents } from '../../claude-agents';
import { evaluateRemoteAgentGate, PHASE_8_EXTENSIBILITY_DECISIONS } from '../../extensibility-policy';
import { indexPackageAgents } from '../../package-agents';
import { AgentRegistry } from '../../registry';
import { AgentResolutionError, resolveAgentSpec } from '../../resolver';
import type { SubagentResolutionPolicy } from '../../types';
import type { SmokeScenario } from '../types';

export const compatibilitySourcesScenario: SmokeScenario = {
    id: 'compatibility-sources',
    label: 'Phase 8: Compatibility sources and capability boundaries',
    description: 'Validates native, Claude-compatible, and package agents plus conservative tools/models, child-safe factories, remote gates, and deferred capability policy without network or model requests.',
    fixtureSeed: 'phase-8-compatibility-sources-v1',
    async run({ logger }) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-compat-smoke-'));
        const cwd = path.join(root, 'workspace');
        const userClaude = path.join(root, 'user-claude');
        const packageRoot = path.join(root, 'fixture-package');
        try {
            await writeAgent(path.join(cwd, '.pi', 'agents', 'native.md'), [
                'name: native-agent', 'description: Native project agent', 'tools: [read]',
            ], 'Use native Pi instructions.');
            await writeAgent(path.join(cwd, '.pi', 'agents', 'shared.md'), [
                'name: shared', 'description: Native collision winner',
            ], 'Native wins.');
            await writeAgent(path.join(cwd, '.claude', 'agents', 'compat.md'), [
                'name: compat-agent', 'description: Adapted Claude project agent', 'model: sonnet',
                'tools: [Read, Glob, Bash, Agent, mcp__docs__search]', 'hooks: {}', 'memory: project',
            ], 'You are Claude Code. Review the workspace safely.');
            await writeAgent(path.join(cwd, '.claude', 'agents', 'shared.md'), [
                'name: shared', 'description: Claude collision loser',
            ], 'Claude duplicate.');
            await writeAgent(path.join(cwd, '.claude', 'agents', 'scope.md'), [
                'name: scope-agent', 'description: Project Claude scope',
            ], 'Project scope.');
            await writeAgent(path.join(cwd, '.claude', 'agents', 'exact.md'), [
                'name: exact-model', 'description: Exact unavailable model', 'model: missing/model',
            ], 'Exact model must not fall back.');
            await fs.mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
            await fs.writeFile(path.join(cwd, '.claude', 'agents', 'invalid.md'), '---\nname: invalid\ntools: [NotebookEdit]\n---\nMissing description.\n');
            await writeAgent(path.join(userClaude, 'agents', 'scope.md'), [
                'name: scope-agent', 'description: User Claude scope',
            ], 'User scope.');
            await writeAgent(path.join(userClaude, 'agents', 'user.md'), [
                'name: user-compat', 'description: User Claude agent',
            ], 'User compatibility.');

            await fs.mkdir(path.join(packageRoot, 'agents'), { recursive: true });
            await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
                name: 'fixture-agents', pi: { agents: ['agents', '../escape.md'] },
            }, null, 2));
            await writeAgent(path.join(packageRoot, 'agents', 'package.md'), [
                'name: package-agent', 'description: Package agent',
            ], 'Package instructions.');
            await writeAgent(path.join(packageRoot, 'agents', 'shared.md'), [
                'name: shared', 'description: Package collision loser',
            ], 'Package duplicate.');
            logger.event('compatibility-fixture-created', { root, cwd, userClaude, packageRoot });

            const availableChildTools = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'docs_search'];
            const claude = await indexClaudeAgents({
                cwd, workspaceTrusted: true, availableChildTools,
                userClaudeDirectory: userClaude,
            });
            const packages = await indexPackageAgents([packageRoot]);
            const registry = new AgentRegistry({
                cwd, workspaceTrusted: true,
                userAgentsDirectory: path.join(root, 'empty-pi-user'),
                claudeDefinitions: claude.definitions,
                packageDefinitions: packages.definitions,
                additionalDiagnostics: [...claude.diagnostics, ...packages.diagnostics],
            });
            const snapshot = await registry.reload();
            logger.event('compatibility-index', {
                definitions: snapshot.definitions.map((entry) => ({ name: entry.name, source: entry.source, scope: entry.scope, packageName: entry.packageName })),
                diagnostics: snapshot.diagnostics.map((entry) => ({ code: entry.code, source: entry.source, path: entry.filePath, message: entry.message })),
            });
            logger.assert('native-claude-package-sources-load', ['native-agent', 'compat-agent', 'package-agent'].every((name) => registry.get(name)), true, snapshot.definitions.map((entry) => entry.name));
            logger.assert('native-project-definition-wins-collision', registry.get('shared')?.source === 'project', 'project', registry.get('shared')?.source);
            logger.assert('project-claude-scope-wins-user-claude-scope', registry.get('scope-agent')?.scope === 'project', 'project', registry.get('scope-agent')?.scope);
            const compat = registry.get('compat-agent')!;
            logger.assert('claude-model-alias-conservatively-inherits', compat.model === 'inherit', 'inherit', compat.model);
            logger.assert('claude-tools-map-only-to-child-capabilities', JSON.stringify(compat.tools) === JSON.stringify(['read', 'find', 'docs_search']), ['read', 'find', 'docs_search'], compat.tools);
            logger.assert('unsupported-claude-capabilities-are-diagnosed', snapshot.diagnostics.filter((entry) => entry.code === 'unsupported-capability').length >= 2, 'at least 2', snapshot.diagnostics.filter((entry) => entry.code === 'unsupported-capability').length);
            logger.assert('claude-identity-remains-inside-compatibility-boundary', Boolean(compat.instructions?.includes('do not replace the current agent identity') && compat.instructions.includes('isolated Pi child session')), true, compat.instructions?.slice(0, 220));
            logger.assert('package-definition-retains-provenance', registry.get('package-agent')?.packageName === 'fixture-agents', 'fixture-agents', registry.get('package-agent')?.packageName);
            logger.assert('package-path-escape-is-rejected', snapshot.diagnostics.some((entry) => entry.code === 'invalid-package-manifest' && entry.message.includes('escapes')), true, snapshot.diagnostics.map((entry) => entry.code));

            const untrustedClaude = await indexClaudeAgents({
                cwd, workspaceTrusted: false, availableChildTools,
                userClaudeDirectory: userClaude,
            });
            const untrusted = new AgentRegistry({
                cwd, workspaceTrusted: false,
                userAgentsDirectory: path.join(root, 'empty-pi-user'),
                claudeDefinitions: untrustedClaude.definitions,
                additionalDiagnostics: untrustedClaude.diagnostics,
            });
            const untrustedSnapshot = await untrusted.reload();
            logger.assert('untrusted-workspace-loads-no-project-agent-source', !untrusted.get('native-agent') && !untrusted.get('compat-agent') && Boolean(untrusted.get('user-compat')), 'user only', untrustedSnapshot.definitions.map((entry) => entry.name));
            logger.assert('untrusted-project-agent-sources-are-diagnosed', untrustedSnapshot.diagnostics.filter((entry) => entry.code === 'untrusted-project').length >= 2, 'native and Claude warnings', untrustedSnapshot.diagnostics.filter((entry) => entry.code === 'untrusted-project').length);

            let exactModelError = '';
            try { resolveAgentSpec(registry, { agent: 'exact-model', task: 'test' }, policy()); }
            catch (error) { exactModelError = error instanceof AgentResolutionError ? `${error.code}:${error.message}` : String(error); }
            logger.assert('explicit-compatible-model-has-no-hidden-fallback', exactModelError.includes('model-unavailable') && exactModelError.includes('no fallback'), true, exactModelError);
            let forkError = '';
            try { resolveAgentSpec(registry, { task: 'fork test', contextMode: 'fork' }, policy()); }
            catch (error) { forkError = error instanceof AgentResolutionError ? `${error.code}:${error.message}` : String(error); }
            logger.assert('fork-context-is-explicitly-rejected-not-silently-emulated', forkError.includes('context-mode-unsupported'), true, forkError);

            const childTools = new ChildToolFactoryRegistry();
            childTools.register({ name: 'safe_extension_tool', source: 'extension', create: ({ agentId }) => ({ name: 'safe_extension_tool', agentId }) });
            childTools.register({ name: 'safe_extension_tool', source: 'extension', create: () => ({}) });
            const mcp = registerChildSafeMcpTool(childTools, 'docs-mcp', 'search', ({ cwd: childCwd }) => ({ name: 'docs_mcp_search', cwd: childCwd }));
            logger.assert('child-safe-extension-contract-registers-explicit-tool', childTools.listNames().includes('safe_extension_tool'), true, childTools.listNames());
            logger.assert('duplicate-child-tool-contract-is-rejected', childTools.listDiagnostics().some((entry) => entry.code === 'duplicate-name'), true, childTools.listDiagnostics());
            logger.assert('mcp-child-tool-requires-explicit-safe-factory', mcp.name === 'docs_mcp_search' && childTools.listNames().includes(mcp.name), 'docs_mcp_search', childTools.listNames());

            const remoteUntrusted = evaluateRemoteAgentGate({ enabled: true, workspaceTrusted: false, endpoint: 'https://agent.invalid', authConfigured: true });
            const remoteMissingAuth = evaluateRemoteAgentGate({ enabled: true, workspaceTrusted: true, endpoint: 'https://agent.invalid', authConfigured: false });
            const remoteDeferred = evaluateRemoteAgentGate({ enabled: true, workspaceTrusted: true, endpoint: 'https://agent.invalid', authConfigured: true });
            logger.event('remote-agent-policy', { remoteUntrusted, remoteMissingAuth, remoteDeferred, networkCalls: 0 });
            logger.assert('remote-agent-requires-trusted-workspace', remoteUntrusted.code === 'untrusted-workspace', 'untrusted-workspace', remoteUntrusted.code);
            logger.assert('remote-agent-requires-explicit-auth', remoteMissingAuth.code === 'missing-auth', 'missing-auth', remoteMissingAuth.code);
            logger.assert('remote-agent-runtime-remains-explicitly-deferred', remoteDeferred.code === 'protocol-deferred', 'protocol-deferred', remoteDeferred.code);
            logger.assert('memory-fork-and-nesting-remain-conservatively-disabled',
                PHASE_8_EXTENSIBILITY_DECISIONS.persistentAgentMemory.startsWith('deferred') &&
                PHASE_8_EXTENSIBILITY_DECISIONS.forkContext.startsWith('deferred') &&
                PHASE_8_EXTENSIBILITY_DECISIONS.nestedDelegation === 'disabled-max-depth-one',
                true, PHASE_8_EXTENSIBILITY_DECISIONS);
            logger.assert('adapted-agent-cannot-grant-nested-subagent', !compat.tools?.includes('subagent'), true, compat.tools);
            logger.assert('compatibility-smoke-does-not-touch-user-workspace', !path.resolve(cwd).startsWith(path.resolve(process.cwd())), true, { fixture: cwd, userWorkspace: process.cwd() });
            logger.step('compatibility-sources-cleanup', { root, networkCalls: 0, modelRequests: 0, result: 'PASS' });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    },
};

async function writeAgent(filePath: string, frontmatter: string[], body: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `---\n${frontmatter.join('\n')}\n---\n${body}\n`, 'utf8');
}

function policy(): SubagentResolutionPolicy {
    return {
        availableModels: [{ provider: 'openai', id: 'parent' }],
        parentModel: { provider: 'openai', id: 'parent' },
        registeredTools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'subagent'],
        activeTools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'subagent'],
        childSafeTools: ['read', 'grep', 'find', 'ls', 'edit', 'write'],
    };
}
