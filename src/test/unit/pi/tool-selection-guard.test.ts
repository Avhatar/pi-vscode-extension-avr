import { describe, expect, it, vi } from 'vitest';
import { createToolSelectionGuard } from '../../../pi/tool-selection-guard';

function createHarness(registered: string[], active: string[]) {
    let activeTools = [...active];
    let toolCallHandler: ((event: any, context: any) => any) | undefined;
    const onBlocked = vi.fn();
    const pi = {
        on(name: string, handler: (event: any, context: any) => any) {
            if (name === 'tool_call') toolCallHandler = handler;
        },
        getAllTools() {
            return registered.map((name) => ({ name }));
        },
        getActiveTools() {
            return [...activeTools];
        },
    };

    createToolSelectionGuard(onBlocked)(pi as any);

    return {
        onBlocked,
        setActiveTools(next: string[]) {
            activeTools = [...next];
        },
        call(event: any) {
            if (!toolCallHandler) throw new Error('tool_call handler was not registered');
            return toolCallHandler(event, {});
        },
    };
}

describe('tool selection guard', () => {
    it('blocks a disabled direct tool invoked through the MCP gateway', () => {
        const harness = createHarness(
            ['mcp', 'unity_run_tests', 'unity_scene_open'],
            ['mcp', 'unity_scene_open'],
        );

        const result = harness.call({
            type: 'tool_call',
            toolName: 'mcp',
            toolCallId: 'call-1',
            input: { tool: 'unity_run_tests', args: '{}' },
        });

        expect(result).toEqual({
            block: true,
            reason: 'Tool "unity_run_tests" is disabled for this chat and cannot be called through the MCP gateway. Enable it in the Tools panel to use it.',
        });
        expect(harness.onBlocked).toHaveBeenCalledWith('mcp', 'unity_run_tests');
    });

    it('uses the MCP adapter hyphen/underscore normalization when checking aliases', () => {
        const harness = createHarness(['mcp', 'unity_run-tests'], ['mcp']);

        const result = harness.call({
            type: 'tool_call',
            toolName: 'mcp',
            toolCallId: 'call-2',
            input: { tool: 'unity_run_tests' },
        });

        expect(result?.block).toBe(true);
    });

    it('allows an MCP target while its direct tool is active', () => {
        const harness = createHarness(
            ['mcp', 'unity_run_tests'],
            ['mcp', 'unity_run_tests'],
        );

        expect(harness.call({
            type: 'tool_call',
            toolName: 'mcp',
            toolCallId: 'call-3',
            input: { tool: 'unity_run_tests' },
        })).toBeUndefined();
        expect(harness.onBlocked).not.toHaveBeenCalled();
    });

    it('reads the current active set for every call', () => {
        const harness = createHarness(
            ['mcp', 'unity_run_tests'],
            ['mcp', 'unity_run_tests'],
        );

        harness.setActiveTools(['mcp']);

        expect(harness.call({
            type: 'tool_call',
            toolName: 'mcp',
            toolCallId: 'call-4',
            input: { tool: 'unity_run_tests' },
        })?.block).toBe(true);
    });

    it('does not block MCP discovery or proxy-only tools', () => {
        const harness = createHarness(['mcp', 'unity_run_tests'], ['mcp']);

        expect(harness.call({
            type: 'tool_call',
            toolName: 'mcp',
            toolCallId: 'call-5',
            input: { search: 'unity tests' },
        })).toBeUndefined();
        expect(harness.call({
            type: 'tool_call',
            toolName: 'mcp',
            toolCallId: 'call-6',
            input: { tool: 'proxy_only_operation' },
        })).toBeUndefined();
    });

    it('ignores non-MCP tool calls', () => {
        const harness = createHarness(['mcp', 'unity_run_tests'], ['mcp']);

        expect(harness.call({
            type: 'tool_call',
            toolName: 'read',
            toolCallId: 'call-7',
            input: { path: 'README.md' },
        })).toBeUndefined();
    });
});
