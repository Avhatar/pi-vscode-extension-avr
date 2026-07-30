import { describe, expect, it } from 'vitest';
import { createCompleteSubagentTool } from '../../../../pi/subagents/completion-tool';
import { SubagentCoordinator } from '../../../../pi/subagents/coordinator';
import { PiChildSessionFactory } from '../../../../pi/subagents/pi-child-session';
import type { ResolvedAgentSpec } from '../../../../pi/subagents/types';

describe('subagent coordinator and child runtime boundaries', () => {
    it('bounds concurrency and removes aborted queued work', async () => {
        const coordinator = new SubagentCoordinator(1);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const order: string[] = [];
        const first = coordinator.schedule(undefined, async () => {
            order.push('first-start');
            await firstGate;
            order.push('first-end');
        });
        const abort = new AbortController();
        const second = coordinator.schedule(abort.signal, async () => {
            order.push('second-start');
        });
        await Promise.resolve();
        expect(coordinator.active).toBe(1);
        expect(coordinator.queued).toBe(1);

        abort.abort();
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        expect(coordinator.queued).toBe(0);
        releaseFirst();
        await first;
        expect(order).toEqual(['first-start', 'first-end']);
        expect(coordinator.active).toBe(0);
        coordinator.dispose();
    });

    it('aborts active work when the coordinator is disposed', async () => {
        const coordinator = new SubagentCoordinator(1);
        const operation = coordinator.schedule(undefined, async (signal) => {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            if (signal.aborted) {
                const error = new Error('cancelled');
                error.name = 'AbortError';
                throw error;
            }
        });
        await Promise.resolve();
        coordinator.dispose();
        await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
        expect(coordinator.active).toBe(0);
    });

    it('returns a terminating structured complete_subagent result', async () => {
        let captured: unknown;
        const tool = createCompleteSubagentTool({ onComplete: (completion) => { captured = completion; } });

        const result = await tool.execute('complete-1', {
            result: 'Done',
            summary: 'Summary',
            artifacts: [{ path: 'report.md' }],
        }, undefined, undefined, {} as any);

        expect(result.terminate).toBe(true);
        expect(captured).toEqual({ result: 'Done', summary: 'Summary', artifacts: [{ path: 'report.md' }] });
    });

    it('rejects unsupported child tools and unavailable models before creating an SDK session', async () => {
        const unavailableRuntime = {
            getModel: () => undefined,
            hasConfiguredAuth: () => false,
        } as any;
        const factory = new PiChildSessionFactory({
            cwd: process.cwd(),
            workspaceTrusted: true,
            modelRuntime: unavailableRuntime,
        });

        await expect(factory.create({ ...spec(), tools: ['bash'] }, {
            agentId: 'unsafe', signal: new AbortController().signal,
        })).rejects.toThrow('Unsupported child tools');
        await expect(factory.create(spec(), {
            agentId: 'missing', signal: new AbortController().signal,
        })).rejects.toThrow('no fallback');
    });
});

function spec(): ResolvedAgentSpec {
    return {
        name: 'runtime-test',
        source: 'invocation',
        task: 'Test.',
        model: { provider: 'deepseek', id: 'reasoner' },
        modelSource: 'invocation',
        tools: ['read'],
        toolTrace: {
            registered: ['read'], active: ['read'], childSafe: ['read'], denied: [], effective: ['read'],
        },
        maxTurns: 4,
        timeoutMinutes: 1,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };
}
