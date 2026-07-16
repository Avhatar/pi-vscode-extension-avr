import { describe, expect, it, vi } from 'vitest';
import { registerSubagentTool } from '../../../../pi/subagents/tool';

describe('parent subagent tool', () => {
    it('registers one parallel tool with delegation guidelines and named catalog', () => {
        const registerTool = vi.fn();
        registerSubagentTool({ registerTool } as any, {
            definitions: [{
                name: 'reviewer',
                description: 'Review evidence',
                model: { provider: 'deepseek', id: 'reasoner' },
                source: 'project',
            }],
            execute: vi.fn(),
        });

        expect(registerTool).toHaveBeenCalledTimes(1);
        const tool = registerTool.mock.calls[0][0];
        expect(tool.name).toBe('subagent');
        expect(tool.executionMode).toBe('parallel');
        expect(tool.description).toContain('reviewer');
        expect(tool.description).toContain('deepseek/reasoner');
        expect(tool.promptGuidelines.join('\n')).toContain('provider/id');
    });

    it('returns a persistent id immediately for a background spawn', async () => {
        let tool: any;
        registerSubagentTool({ registerTool(value: any) { tool = value; } } as any, {
            definitions: [],
            execute: vi.fn(async () => ({
                agentId: 'background-1',
                model: { provider: 'deepseek', id: 'reasoner' },
                background: true as const,
            })),
        });
        const result = await tool.execute('background-call', {
            task: 'Review in background.', background: true,
        }, undefined, undefined, {});
        expect(result.content[0].text).toContain('background-1');
        expect(result.details).toMatchObject({ agentId: 'background-1', status: 'queued' });
    });

    it('routes persistent lifecycle actions by agent id without requiring a spawn task', async () => {
        let tool: any;
        const control = vi.fn(async () => ({
            text: 'Persistent transcript.',
            details: { agentId: 'child-1', name: 'reviewer', status: 'completed' as const },
        }));
        registerSubagentTool({ registerTool(value: any) { tool = value; } } as any, {
            definitions: [],
            execute: vi.fn(),
            control,
        });
        const result = await tool.execute('control-1', {
            action: 'inspect', agentId: 'child-1',
        }, undefined, undefined, {});
        expect(control).toHaveBeenCalledWith(
            'inspect',
            expect.objectContaining({ action: 'inspect', agentId: 'child-1' }),
            undefined,
            expect.any(Function),
        );
        expect(result.content).toEqual([{ type: 'text', text: 'Persistent transcript.' }]);
    });

    it('forwards action: review by agentId through services.control', async () => {
        let tool: any;
        const control = vi.fn(async () => ({
            text: '[review patch] auth.ts: +12 / -3',
            details: { agentId: 'child-1', name: 'reviewer', status: 'completed' as const },
        }));
        registerSubagentTool({ registerTool(value: any) { tool = value; } } as any, {
            definitions: [{
                name: 'reviewer',
                description: 'Review evidence',
                model: { provider: 'deepseek', id: 'reasoner' },
                source: 'project',
            }],
            execute: vi.fn(),
            control,
        });
        const result = await tool.execute('review-1', {
            action: 'review', agentId: 'child-1',
        }, undefined, undefined, {});
        expect(control).toHaveBeenCalledWith(
            'review',
            expect.objectContaining({ action: 'review', agentId: 'child-1' }),
            undefined,
            expect.any(Function),
        );
        expect(result.content).toEqual([{ type: 'text', text: '[review patch] auth.ts: +12 / -3' }]);
        expect(result.details).toMatchObject({ agentId: 'child-1', status: 'completed' });
    });

    it('forwards named and ad-hoc parameters and returns the bounded child result', async () => {
        let tool: any;
        const execute = vi.fn(async (_invocation, _signal, progress) => {
            progress({ agentId: 'child-1', name: 'reviewer', status: 'running' });
            return {
                agentId: 'child-1',
                result: 'Review complete.',
                model: { provider: 'deepseek', id: 'reasoner' },
                turnCount: 2,
                truncated: false,
            };
        });
        registerSubagentTool({ registerTool(value: any) { tool = value; } } as any, {
            definitions: [],
            execute,
        });
        const updates: unknown[] = [];

        const result = await tool.execute('call-1', {
            task: 'Review auth.',
            agent: 'reviewer',
            instructions: 'Focus on races.',
            model: { provider: 'deepseek', id: 'reasoner' },
            tools: ['read'],
            maxTurns: 5,
            timeoutMinutes: 2,
        }, undefined, (update: unknown) => updates.push(update), {});

        expect(execute).toHaveBeenCalledWith(expect.objectContaining({
            task: 'Review auth.',
            agent: 'reviewer',
            instructions: 'Focus on races.',
            model: { provider: 'deepseek', id: 'reasoner' },
            tools: ['read'],
            maxTurns: 5,
            timeoutMinutes: 2,
        }), undefined, expect.any(Function));
        expect(result.content).toEqual([{ type: 'text', text: 'Review complete.' }]);
        expect(result.details).toMatchObject({ status: 'completed', model: { provider: 'deepseek', id: 'reasoner' } });
        expect(updates.length).toBeGreaterThanOrEqual(2);
    });
});
