import { formatModelRef } from '../../model-ref';
import { AgentRegistry } from '../../registry';
import { AgentResolutionError, resolveAgentSpec } from '../../resolver';
import type { AgentDefinition, SubagentResolutionPolicy } from '../../types';
import { createRegistrySmokeFixture } from '../fixtures';
import type { SmokeScenario } from '../types';

export const registryResolutionScenario: SmokeScenario = {
    id: 'registry-resolution',
    label: 'Phase 1: Registry and resolution',
    description: 'Simulates native discovery, trust, precedence, model routing, tool policy, and diagnostics.',
    fixtureSeed: 'phase-1-registry-v1',
    async run({ logger }) {
        const fixture = await createRegistrySmokeFixture();
        logger.step('fixture-created', { root: fixture.root });
        try {
            const trusted = new AgentRegistry({
                cwd: fixture.cwd,
                workspaceTrusted: true,
                userAgentsDirectory: fixture.userAgentsDirectory,
                projectAgentsDirectory: fixture.projectAgentsDirectory,
            });
            const trustedSnapshot = await trusted.reload();
            logger.event('registry-reloaded', {
                trust: true,
                definitions: trustedSnapshot.definitions.map((definition) => `${definition.name}:${definition.source}`),
                diagnostics: trustedSnapshot.diagnostics.map((diagnostic) => diagnostic.code),
            });
            logger.assert('trusted-project-precedence', trusted.get('reviewer')?.source === 'project', 'project', trusted.get('reviewer')?.source);
            logger.assert('recursive-user-discovery', trusted.get('research')?.source === 'user', 'user', trusted.get('research')?.source);
            logger.assert('same-scope-duplicate-rejected', trusted.get('duplicate') === undefined, undefined, trusted.get('duplicate')?.source);
            logger.assert(
                'duplicate-diagnostic-visible',
                trustedSnapshot.diagnostics.filter((diagnostic) => diagnostic.code === 'duplicate-name').length === 2,
                2,
                trustedSnapshot.diagnostics.filter((diagnostic) => diagnostic.code === 'duplicate-name').length,
            );
            logger.assert(
                'malformed-definition-rejected',
                trusted.get('malformed') === undefined && trustedSnapshot.diagnostics.some((diagnostic) =>
                    diagnostic.code === 'invalid-definition' && diagnostic.agentName === 'malformed'),
                true,
                trusted.get('malformed') !== undefined,
            );

            const untrusted = new AgentRegistry({
                cwd: fixture.cwd,
                workspaceTrusted: false,
                userAgentsDirectory: fixture.userAgentsDirectory,
                projectAgentsDirectory: fixture.projectAgentsDirectory,
            });
            const untrustedSnapshot = await untrusted.reload();
            logger.event('registry-reloaded', {
                trust: false,
                definitions: untrustedSnapshot.definitions.map((definition) => `${definition.name}:${definition.source}`),
                diagnostics: untrustedSnapshot.diagnostics.map((diagnostic) => diagnostic.code),
            });
            logger.assert('untrusted-project-not-loaded', untrusted.get('reviewer')?.source === 'user', 'user', untrusted.get('reviewer')?.source);
            logger.assert(
                'untrusted-project-diagnostic-visible',
                untrustedSnapshot.diagnostics.some((diagnostic) => diagnostic.code === 'untrusted-project'),
                true,
                false,
            );

            const runtimeDefinition: AgentDefinition = {
                name: 'reviewer',
                description: 'Runtime reviewer',
                instructions: 'Use the runtime definition.',
                model: { provider: 'openai', id: 'gpt-parent' },
                tools: ['read'],
                source: 'runtime',
            };
            const runtime = new AgentRegistry({
                cwd: fixture.cwd,
                workspaceTrusted: true,
                userAgentsDirectory: fixture.userAgentsDirectory,
                projectAgentsDirectory: fixture.projectAgentsDirectory,
                runtimeDefinitions: [runtimeDefinition],
            });
            await runtime.reload();
            logger.assert('runtime-precedence', runtime.get('REVIEWER')?.source === 'runtime', 'runtime', runtime.get('REVIEWER')?.source);

            const policy = createPolicy();
            logger.step('resolution-input', {
                agent: 'research',
                invocationModel: 'anthropic/claude-review',
                definitionModel: 'deepseek/deepseek-reasoner',
                defaultModel: policy.defaultModel ?? '(none)',
                parentModel: formatModelRef(policy.parentModel),
                invocationTools: ['read', 'bash'],
                definitionTools: trusted.get('research')?.tools,
                globallyDisallowedTools: policy.globallyDisallowedTools,
            });
            const resolved = resolveAgentSpec(trusted, {
                task: 'Investigate the authentication flow.',
                agent: 'research',
                instructions: 'Focus on race conditions.',
                model: 'anthropic/claude-review',
                tools: ['read', 'bash'],
            }, policy);
            logger.event('spec-resolved', {
                agent: resolved.name,
                source: resolved.source,
                model: formatModelRef(resolved.model),
                modelSource: resolved.modelSource,
                maxTurns: resolved.maxTurns,
                diagnostics: resolved.diagnostics.map((diagnostic) => diagnostic.code),
            });
            logger.event('tool-policy-resolved', {
                registered: resolved.toolTrace.registered,
                active: resolved.toolTrace.active,
                childSafe: resolved.toolTrace.childSafe,
                definitionAllowlist: resolved.toolTrace.definitionAllowlist,
                invocationAllowlist: resolved.toolTrace.invocationAllowlist,
                denied: resolved.toolTrace.denied,
                effective: resolved.toolTrace.effective,
            });
            logger.assert('invocation-model-precedence', resolved.modelSource === 'invocation', 'invocation', resolved.modelSource);
            logger.assert('cross-provider-model-resolved', formatModelRef(resolved.model) === 'anthropic/claude-review', 'anthropic/claude-review', formatModelRef(resolved.model));
            logger.assert('tool-intersection-and-deny', sameValues(resolved.tools, ['read']), ['read'], resolved.tools);
            logger.assert('host-turn-limit-clamped', resolved.maxTurns === 40, 40, resolved.maxTurns);
            const instructionsCombined = resolved.instructions?.includes('Collect evidence') === true && resolved.instructions.includes('race conditions');
            logger.assert('named-and-adhoc-instructions-combined', instructionsCombined, true, instructionsCombined);

            const forced = resolveAgentSpec(trusted, {
                task: 'Review the API.',
                agent: 'reviewer',
                model: 'deepseek/deepseek-reasoner',
            }, {
                ...policy,
                forcedModelsByAgent: { reviewer: 'openai/gpt-parent' },
            });
            logger.event('forced-model-resolved', {
                model: formatModelRef(forced.model),
                modelSource: forced.modelSource,
            });
            logger.assert('settings-forced-model-precedence', forced.modelSource === 'forced-setting' && formatModelRef(forced.model) === 'openai/gpt-parent', 'openai/gpt-parent', formatModelRef(forced.model));

            const adHoc = resolveAgentSpec(trusted, {
                task: 'Summarize the findings.',
                instructions: 'Be concise.',
                model: 'deepseek/deepseek-reasoner',
                tools: [],
            }, policy);
            logger.assert('adhoc-definition-resolves', adHoc.source === 'invocation' && adHoc.tools.length === 0, true, { source: adHoc.source, tools: adHoc.tools });

            let unavailableError: AgentResolutionError | undefined;
            try {
                resolveAgentSpec(trusted, {
                    task: 'Use a missing model.',
                    model: 'missing/model',
                }, policy);
            } catch (error) {
                if (error instanceof AgentResolutionError) unavailableError = error;
            }
            logger.event('explicit-model-failure', { code: unavailableError?.code, message: unavailableError?.message });
            logger.assert('explicit-model-never-falls-back', unavailableError?.code === 'model-unavailable', 'model-unavailable', unavailableError?.code);

            let toolError: AgentResolutionError | undefined;
            try {
                resolveAgentSpec(trusted, {
                    task: 'Use an unknown tool.',
                    tools: ['invented_tool'],
                }, policy);
            } catch (error) {
                if (error instanceof AgentResolutionError) toolError = error;
            }
            logger.event('unknown-tool-failure', { code: toolError?.code, message: toolError?.message });
            logger.assert('unknown-tool-fails-before-execution', toolError?.code === 'unknown-tool', 'unknown-tool', toolError?.code);
        } finally {
            await fixture.cleanup();
            logger.step('fixture-cleanup', { result: 'PASS' });
        }
    },
};

function createPolicy(): SubagentResolutionPolicy {
    return {
        availableModels: [
            { provider: 'openai', id: 'gpt-parent', name: 'GPT Parent' },
            { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
            { provider: 'anthropic', id: 'claude-review', name: 'Claude Review' },
        ],
        parentModel: { provider: 'openai', id: 'gpt-parent' },
        allowedModels: [
            'openai/gpt-parent',
            'deepseek/deepseek-reasoner',
            'anthropic/claude-review',
            'missing/model',
        ],
        registeredTools: ['read', 'grep', 'bash', 'subagent'],
        activeTools: ['read', 'grep', 'bash', 'subagent'],
        childSafeTools: ['read', 'grep', 'bash', 'subagent'],
        globallyDisallowedTools: ['bash'],
        defaultMaxTurns: 30,
        maxTurns: 40,
        defaultTimeoutMinutes: 10,
        maxTimeoutMinutes: 20,
    };
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
