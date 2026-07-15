import type { AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentDefinition, ModelRef, SubagentInvocation, SubagentRunStatus } from './types';
import type { SubagentExecutionResult } from './runtime';

export const SUBAGENT_TOOL_NAME = 'subagent';

const ModelSchema = Type.Union([
    Type.String({ description: 'Exact child model in canonical provider/id format.' }),
    Type.Object({
        provider: Type.String(),
        id: Type.String(),
    }),
]);

export const SubagentParamsSchema = Type.Object({
    action: Type.Optional(Type.Union([
        Type.Literal('spawn'), Type.Literal('resume'), Type.Literal('send'),
        Type.Literal('stop'), Type.Literal('inspect'), Type.Literal('dismiss'),
    ], { description: 'Lifecycle action. Defaults to spawn.' })),
    task: Type.Optional(Type.String({ description: 'A complete task for spawn, or a follow-up task for resume.' })),
    agentId: Type.Optional(Type.String({ description: 'Persistent child id required by lifecycle actions.' })),
    message: Type.Optional(Type.String({ description: 'Additional guidance for send.' })),
    agent: Type.Optional(Type.String({ description: 'Name of a reusable agent definition from user or trusted project agent files.' })),
    instructions: Type.Optional(Type.String({ description: 'Ad-hoc specialized instructions, appended after named-agent instructions when both are provided.' })),
    model: Type.Optional(ModelSchema),
    thinkingLevel: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String(), { description: 'Optional narrowing allowlist of read-only child tools.' })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    background: Type.Optional(Type.Boolean({ description: 'Return a persistent agentId immediately and notify the parent session when the child settles.' })),
    isolation: Type.Optional(Type.Union([
        Type.Literal('shared-workspace'), Type.Literal('worktree'),
    ], { description: 'Write isolation. Background write agents require worktree.' })),
});

export interface SubagentToolParams {
    action?: 'spawn' | 'resume' | 'send' | 'stop' | 'inspect' | 'dismiss';
    task?: string;
    agentId?: string;
    message?: string;
    agent?: string;
    instructions?: string;
    model?: string | ModelRef;
    thinkingLevel?: string;
    tools?: string[];
    maxTurns?: number;
    timeoutMinutes?: number;
    background?: boolean;
    isolation?: 'shared-workspace' | 'worktree';
}

export interface SubagentToolDetails {
    agentId?: string;
    name: string;
    status: SubagentRunStatus;
    model?: ModelRef;
    turnCount?: number;
    truncated?: boolean;
}

export interface SubagentControlResult {
    text: string;
    details: SubagentToolDetails;
}

export interface SubagentToolServices {
    definitions: readonly AgentDefinition[];
    execute(
        invocation: SubagentInvocation,
        signal: AbortSignal | undefined,
        onProgress: (details: SubagentToolDetails) => void,
    ): Promise<SubagentExecutionResult>;
    control?(
        action: Exclude<NonNullable<SubagentToolParams['action']>, 'spawn'>,
        params: SubagentToolParams,
        signal: AbortSignal | undefined,
        onProgress: (details: SubagentToolDetails) => void,
    ): Promise<SubagentControlResult>;
}

export function registerSubagentTool(api: ExtensionAPI, services: SubagentToolServices): void {
    const catalog = renderAgentCatalog(services.definitions);
    api.registerTool({
        name: SUBAGENT_TOOL_NAME,
        label: 'Subagent',
        description: [
            'Delegate one self-contained task to an isolated child agent.',
            'Children use fresh context, may select an exact cross-provider model, and receive only policy-approved tools.',
            'Use `agent` for a reusable file definition or provide ad-hoc `instructions`.',
            'Spawn and resume wait for the child and return only its bounded final result.',
            'Persistent agent IDs support inspect, send, stop, resume, and dismiss lifecycle actions.',
            catalog,
        ].filter(Boolean).join('\n'),
        promptSnippet: 'Delegate a task to an isolated read-only child agent, optionally on another provider/model',
        promptGuidelines: [
            'Use `subagent` when an independent investigation, review, or specialized analysis can be delegated with a self-contained task.',
            'Pass one child per tool call. To run independent children concurrently, emit multiple sibling `subagent` calls in one response.',
            'State the expected output and relevant paths in `task`; the child does not see the parent conversation.',
            'Use exact `provider/id` model references. An unavailable explicit model fails and never silently falls back.',
            'Use lifecycle actions only with an agentId returned by an earlier call; stale IDs fail explicitly.',
            'Do not delegate trivial work when the coordination cost exceeds the benefit.',
        ],
        parameters: SubagentParamsSchema,
        executionMode: 'parallel',
        async execute(_toolCallId, rawParams, signal, onUpdate) {
            const params = rawParams as unknown as SubagentToolParams;
            const action = params.action ?? 'spawn';
            let latest: SubagentToolDetails = {
                agentId: params.agentId,
                name: params.agent?.trim() || (params.agentId ? `subagent ${params.agentId}` : 'ad-hoc'),
                status: 'queued',
            };
            const publish = (details: SubagentToolDetails): void => {
                latest = details;
                publishUpdate(onUpdate, details);
            };
            publish(latest);
            if (action !== 'spawn') {
                if (!params.agentId?.trim()) throw new Error(`Subagent action ${action} requires agentId.`);
                if (!services.control) throw new Error('Subagent lifecycle controls are unavailable.');
                const controlled = await services.control(action, params, signal, publish);
                return {
                    content: [{ type: 'text', text: controlled.text }],
                    details: controlled.details,
                };
            }
            if (!params.task?.trim()) throw new Error('Subagent spawn requires a non-empty task.');
            const result = await services.execute({
                task: params.task,
                ...(params.agent ? { agent: params.agent } : {}),
                ...(params.instructions ? { instructions: params.instructions } : {}),
                ...(params.model ? { model: params.model } : {}),
                ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
                ...(params.tools ? { tools: params.tools } : {}),
                ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
                ...(params.timeoutMinutes !== undefined ? { timeoutMinutes: params.timeoutMinutes } : {}),
                ...(params.background !== undefined ? { background: params.background } : {}),
                ...(params.isolation ? { isolation: params.isolation } : {}),
            }, signal, publish);
            if (result.background) {
                const details: SubagentToolDetails = {
                    agentId: result.agentId,
                    name: latest.name,
                    status: 'queued',
                    model: { provider: result.model.provider, id: result.model.id },
                    turnCount: 0,
                };
                return {
                    content: [{
                        type: 'text',
                        text: `Background subagent started with agentId ${result.agentId} on ${result.model.provider}/${result.model.id}.`,
                    }],
                    details,
                };
            }
            const details: SubagentToolDetails = {
                agentId: result.agentId,
                name: latest.name,
                status: 'completed',
                model: { provider: result.model.provider, id: result.model.id },
                turnCount: result.turnCount,
                truncated: result.truncated,
            };
            return {
                content: [{ type: 'text', text: result.result }],
                details,
            };
        },
    });
}

function publishUpdate(
    onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
    details: SubagentToolDetails,
): void {
    onUpdate?.({
        content: [{
            type: 'text',
            text: `Subagent ${details.name}: ${details.status}` +
                (details.model ? ` (${details.model.provider}/${details.model.id})` : ''),
        }],
        details,
    });
}

function renderAgentCatalog(definitions: readonly AgentDefinition[]): string {
    if (definitions.length === 0) return 'No named definitions are currently loaded; use ad-hoc instructions or an anonymous child.';
    const lines = definitions.slice(0, 100).map((definition) => {
        const model = definition.model && definition.model !== 'inherit'
            ? ` [${definition.model.provider}/${definition.model.id}]`
            : definition.model === 'inherit' ? ' [inherit parent model]' : '';
        const provenance = definition.packageName
            ? ` [package:${definition.packageName}]`
            : definition.source === 'claude-compat' ? ` [claude-${definition.scope ?? 'compat'}]` : '';
        return `- ${definition.name}${model}${provenance}: ${definition.description}`;
    });
    if (definitions.length > lines.length) lines.push(`- … ${definitions.length - lines.length} additional definitions omitted`);
    return `Available named agents:\n${lines.join('\n')}`;
}
