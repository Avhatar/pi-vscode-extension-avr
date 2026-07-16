import { describe, expect, it, vi } from 'vitest';
import { ChildToolFactoryRegistry } from '../../../../pi/subagents/child-tools';
import type { ChildSafeToolFactory, ChildToolFactoryContext } from '../../../../pi/subagents/child-tools';
import type { ResolvedAgentSpec } from '../../../../pi/subagents/types';

function createTestContext(overrides: Partial<ChildToolFactoryContext> = {}): ChildToolFactoryContext {
    const spec: ResolvedAgentSpec = {
        name: 'test-agent',
        source: 'project',
        task: 'Test task',
        model: { provider: 'test', id: 'test-model', name: 'Test Model' },
        modelSource: 'definition',
        tools: ['read'],
        toolTrace: {
            registered: ['read'],
            active: ['read'],
            childSafe: ['read'],
            denied: [],
            effective: ['read'],
        },
        maxTurns: 5,
        timeoutMinutes: 10,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };

    return {
        agentId: 'child-1',
        cwd: '/tmp/test-workspace',
        signal: new AbortController().signal,
        spec,
        ...overrides,
    };
}

describe('ChildToolFactoryRegistry.createTools', () => {
    it('invokes a known factory exactly once per unique name, returns only its tool, and silently skips unknowns', async () => {
        const registry = new ChildToolFactoryRegistry();
        const createdTool = { name: 'custom_tool', execute: vi.fn() };

        const factory: ChildSafeToolFactory = {
            name: 'custom_tool',
            source: 'extension',
            create: vi.fn(async (_ctx: ChildToolFactoryContext) => createdTool),
        };

        registry.register(factory);
        const context = createTestContext();

        const result = await registry.createTools(
            ['custom_tool', 'unknown_tool', 'custom_tool'], // repeated known + one unknown
            context,
        );

        expect(factory.create).toHaveBeenCalledTimes(1);
        expect(factory.create).toHaveBeenCalledWith(context);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(createdTool);
    });
});
