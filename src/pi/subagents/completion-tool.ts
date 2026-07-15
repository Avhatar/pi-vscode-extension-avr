import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SubagentCompletion } from './runtime';

const parameters = Type.Object({
    result: Type.String({ description: 'The complete result to return to the parent orchestrator.' }),
    summary: Type.Optional(Type.String({ description: 'Optional one-line summary.' })),
    artifacts: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ description: 'Workspace-relative or absolute artifact path.' }),
        description: Type.Optional(Type.String()),
    }), { maxItems: 100 })),
});

export function createCompleteSubagentTool(options: {
    onComplete(completion: SubagentCompletion): void;
}): ToolDefinition<typeof parameters, SubagentCompletion> {
    return {
        name: 'complete_subagent',
        label: 'Complete Subagent',
        description: 'Finish the delegated task and return its final structured result to the parent orchestrator. Call this once, by itself, when the task is complete.',
        promptSnippet: 'Complete the delegated task with a structured result',
        promptGuidelines: [
            'Call `complete_subagent` exactly once when the delegated task is complete.',
            'Call it by itself, with no sibling tool calls in the same response.',
            'Put the complete parent-facing answer in `result`; do not return only a status update.',
        ],
        parameters,
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
            const completion: SubagentCompletion = {
                result: params.result,
                ...(params.summary ? { summary: params.summary } : {}),
                ...(params.artifacts ? { artifacts: params.artifacts.map((artifact) => ({ ...artifact })) } : {}),
            };
            options.onComplete(completion);
            return {
                content: [{ type: 'text', text: 'Result accepted. The delegated run is complete.' }],
                details: completion,
                terminate: true,
            };
        },
    };
}
