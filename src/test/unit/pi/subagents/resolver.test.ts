import { describe, expect, it } from 'vitest';
import { AgentResolutionError, resolveAgentSpec } from '../../../../pi/subagents/resolver';
import type { AgentDefinition, SubagentResolutionPolicy } from '../../../../pi/subagents/types';

const definitions: AgentDefinition[] = [{
    name: 'research',
    description: 'Research a problem',
    instructions: 'Collect evidence.',
    model: { provider: 'deepseek', id: 'reasoner' },
    thinkingLevel: 'high',
    tools: ['read', 'grep', 'bash'],
    disallowedTools: ['bash'],
    maxTurns: 80,
    timeoutMinutes: 30,
    source: 'project',
}];

const lookup = {
    get(name: string) {
        return definitions.find((definition) => definition.name.toLowerCase() === name.toLowerCase());
    },
};

function policy(overrides: Partial<SubagentResolutionPolicy> = {}): SubagentResolutionPolicy {
    return {
        availableModels: [
            { provider: 'openai', id: 'parent', name: 'Parent' },
            { provider: 'deepseek', id: 'reasoner', name: 'Reasoner' },
            { provider: 'anthropic', id: 'reviewer', name: 'Reviewer' },
        ],
        parentModel: { provider: 'openai', id: 'parent' },
        parentThinkingLevel: 'medium',
        allowedModels: [],
        registeredTools: ['read', 'grep', 'bash', 'subagent'],
        activeTools: ['read', 'grep', 'bash', 'subagent'],
        childSafeTools: ['read', 'grep', 'bash', 'subagent'],
        defaultMaxTurns: 30,
        maxTurns: 40,
        defaultTimeoutMinutes: 10,
        maxTimeoutMinutes: 20,
        ...overrides,
    };
}

describe('subagent specification resolution', () => {
    it('uses generous built-in execution defaults when the host does not provide them', () => {
        const resolved = resolveAgentSpec({ get: () => undefined }, {
            task: 'Investigate thoroughly.',
        }, policy({
            defaultMaxTurns: undefined,
            maxTurns: 100,
            defaultTimeoutMinutes: undefined,
            maxTimeoutMinutes: 120,
        }));

        expect(resolved.maxTurns).toBe(60);
        expect(resolved.timeoutMinutes).toBe(30);
    });

    it('combines named and ad-hoc instructions with invocation model precedence', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Investigate auth.',
            agent: 'research',
            instructions: 'Focus on concurrency.',
            model: 'anthropic/reviewer',
            tools: ['read', 'bash'],
        }, policy());

        expect(resolved.model).toMatchObject({ provider: 'anthropic', id: 'reviewer' });
        expect(resolved.modelSource).toBe('invocation');
        expect(resolved.instructions).toBe('Collect evidence.\n\nFocus on concurrency.');
        expect(resolved.tools).toEqual(['read']);
        expect(resolved.maxTurns).toBe(40);
        expect(resolved.timeoutMinutes).toBe(20);
        expect(resolved.diagnostics.filter((diagnostic) => diagnostic.code === 'limit-clamped')).toHaveLength(2);
    });

    it('gives a forced per-agent setting precedence over invocation and definition', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Investigate.',
            agent: 'research',
            model: 'anthropic/reviewer',
        }, policy({ forcedModelsByAgent: { RESEARCH: 'openai/parent' } }));

        expect(resolved.model).toMatchObject({ provider: 'openai', id: 'parent' });
        expect(resolved.modelSource).toBe('forced-setting');
    });

    it('never falls back for an explicit unavailable or disallowed model', () => {
        expect(() => resolveAgentSpec(lookup, {
            task: 'Investigate.',
            model: 'missing/model',
        }, policy())).toThrowError(expect.objectContaining({ code: 'model-unavailable' }));

        expect(() => resolveAgentSpec(lookup, {
            task: 'Investigate.',
            model: 'anthropic/reviewer',
        }, policy({ allowedModels: ['openai/parent'] }))).toThrowError(expect.objectContaining({ code: 'model-disallowed' }));
    });

    it('can skip an unavailable non-explicit default model and inherit the parent', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Summarize.',
        }, policy({ defaultModel: 'missing/default' }));

        expect(resolved.modelSource).toBe('parent');
        expect(resolved.model).toMatchObject({ provider: 'openai', id: 'parent' });
        expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: 'default-model-skipped' }));
    });

    it('treats definition inherit as an explicit parent-model choice ahead of defaults', () => {
        const inherited: AgentDefinition = {
            name: 'inherit', description: 'Inherit', model: 'inherit', source: 'user',
        };
        const resolved = resolveAgentSpec({ get: () => inherited }, {
            task: 'Use parent.',
            agent: 'inherit',
        }, policy({ defaultModel: 'anthropic/reviewer' }));

        expect(resolved.modelSource).toBe('parent');
        expect(resolved.model).toMatchObject({ provider: 'openai', id: 'parent' });
    });

    it('allows policy layers only to narrow the registered active child-safe tool set', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Investigate.',
            agent: 'research',
            tools: ['read', 'grep'],
        }, policy({
            activeTools: ['read', 'bash', 'subagent'],
            childSafeTools: ['read', 'grep', 'subagent'],
        }));

        expect(resolved.tools).toEqual(['read']);
        expect(resolved.toolTrace.childSafe).not.toContain('subagent');
        expect(resolved.diagnostics).toContainEqual(expect.objectContaining({
            code: 'tool-unavailable',
            message: expect.stringContaining('grep'),
        }));
    });

    it('fails on unknown tool names and disabled invocation model overrides', () => {
        expect(() => resolveAgentSpec(lookup, {
            task: 'Investigate.',
            tools: ['invented'],
        }, policy())).toThrowError(expect.objectContaining({ code: 'unknown-tool' }));

        for (const model of ['anthropic/reviewer', 'inherit']) {
            expect(() => resolveAgentSpec(lookup, {
                task: 'Investigate.',
                model,
            }, policy({ allowInvocationModelOverride: false }))).toThrowError(expect.objectContaining({ code: 'model-override-disabled' }));
        }
    });

    it('resolves anonymous ad-hoc runs without a built-in profile', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Summarize.',
            instructions: 'Be concise.',
            tools: [],
        }, policy());

        expect(resolved).toMatchObject({
            name: 'ad-hoc',
            source: 'invocation',
            instructions: 'Be concise.',
            tools: [],
            contextMode: 'fresh',
            isolation: 'shared-workspace',
        });
    });

    it('uses invocation name for ad-hoc display when no definition matches', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Summarize.',
            name: 'summarizer',
        }, policy());

        expect(resolved.name).toBe('summarizer');
        expect(resolved.source).toBe('invocation');
    });

    it('lets a named definition override the transient invocation name', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Investigate.',
            agent: 'research',
            name: 'researcher-tmp',
        }, policy());

        expect(resolved.name).toBe('research');
        expect(resolved.source).toBe('project');
    });

    it('defaults to ad-hoc when neither definition nor transient name is provided', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Summarize.',
        }, policy());

        expect(resolved.name).toBe('ad-hoc');
    });

    it('defaults to ad-hoc when transient name is empty or whitespace', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Summarize.',
            name: '   ',
        }, policy());

        expect(resolved.name).toBe('ad-hoc');
    });

    it('treats invocation model: inherit as an explicit parent choice ahead of defaults', () => {
        const resolved = resolveAgentSpec(lookup, {
            task: 'Summarize.',
            model: 'inherit',
        }, policy({ defaultModel: 'anthropic/reviewer' }));

        expect(resolved.modelSource).toBe('parent');
        expect(resolved.model).toMatchObject({ provider: 'openai', id: 'parent' });
    });

    it('fails with no fallback when invocation model: inherit targets an unavailable parent', () => {
        expect(() => resolveAgentSpec(lookup, {
            task: 'Summarize.',
            model: 'inherit',
        }, policy({
            availableModels: [
                { provider: 'deepseek', id: 'reasoner', name: 'Reasoner' },
            ],
            parentModel: { provider: 'openai', id: 'parent' },
        }))).toThrowError(expect.objectContaining({ code: 'model-unavailable' }));
    });

    it('reports unknown named definitions clearly', () => {
        expect(() => resolveAgentSpec(lookup, {
            task: 'Investigate.',
            agent: 'missing',
        }, policy())).toThrowError(new AgentResolutionError('unknown-agent', 'Unknown subagent definition: missing'));
    });
});
