import type { AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentDefinition, ModelRef, SubagentInvocation, SubagentRunStatus } from './types';
import type { SubagentExecutionResult } from './runtime';

export const SUBAGENT_TOOL_NAME = 'subagent';

const ModelSchema = Type.Union([
    Type.String({ description: 'Exact child model in canonical provider/id format, or "inherit" to use the parent model.' }),
    Type.Object({
        provider: Type.String(),
        id: Type.String(),
    }),
]);

export const SubagentParamsSchema = Type.Object({
    action: Type.Optional(Type.Union([
        Type.Literal('spawn'), Type.Literal('resume'), Type.Literal('send'),
        Type.Literal('stop'), Type.Literal('inspect'), Type.Literal('dismiss'),
        Type.Literal('review'), Type.Literal('apply'), Type.Literal('cleanup'),
    ], { description: 'Lifecycle action. Defaults to spawn.' })),
    task: Type.Optional(Type.String({ description: 'A complete task for spawn, or a follow-up task for resume.' })),
    agentId: Type.Optional(Type.String({ description: 'Persistent child id required by lifecycle actions.' })),
    message: Type.Optional(Type.String({ description: 'Additional guidance for send.' })),
    agent: Type.Optional(Type.String({ description: 'Name of a reusable agent definition from user or trusted project agent files.' })),
    name: Type.Optional(Type.String({ description: 'Transient display name for an ad-hoc child without a persistent definition.' })),
    instructions: Type.Optional(Type.String({ description: 'Ad-hoc specialized instructions, appended after named-agent instructions when both are provided.' })),
    model: Type.Optional(ModelSchema),
    thinkingLevel: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String(), { description: 'Optional narrowing allowlist of child-safe tools.' })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    background: Type.Optional(Type.Boolean({ description: 'Return a persistent agentId immediately and notify the parent session when the child settles.' })),
    isolation: Type.Optional(Type.Union([
        Type.Literal('shared-workspace'), Type.Literal('worktree'),
    ], { description: 'Write isolation. Background write agents require worktree.' })),
});

export interface SubagentToolParams {
    action?: 'spawn' | 'resume' | 'send' | 'stop' | 'inspect' | 'dismiss' | 'review' | 'apply' | 'cleanup';
    task?: string;
    agentId?: string;
    message?: string;
    agent?: string;
    /** Transient display name for an ad-hoc child. Named definitions override this. */
    name?: string;
    instructions?: string;
    /** Exact provider/id, {provider,id}, or "inherit" to use the parent model. */
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
            'Use `agent` for a reusable file definition or omit it and provide `name` plus ad-hoc `instructions` for a temporary role.',
            'Choose matching named agents from their descriptions automatically; users may also request a specific named agent.',
            'Use `model: "inherit"` to select the parent model explicitly instead of the configured child default.',
            'Spawn and resume wait for the child and return only its bounded final result.',
            'Persistent agent IDs support inspect, send, stop, resume, dismiss, review, apply, and cleanup lifecycle actions.',
            'Use `review` to return the isolated worktree patch from a completed child.',
            'The parent orchestrator owns review, apply, and cleanup decisions; these lifecycle actions never ask the user to manage child worktrees.',
            catalog,
        ].filter(Boolean).join('\n'),
        promptSnippet: 'Delegate a task to an isolated child agent, optionally on another provider/model',
        promptGuidelines: [
            'When `subagent` is active, the user has already opted into autonomous delegation. Do not ask permission before spawning a useful child.',
            'Before non-trivial work, identify independent, bounded slices that can be delegated without transferring architecture or final ownership.',
            'Use a loaded named agent when its catalog description matches the slice. If none fits, omit `agent` and synthesize a temporary role with a concise `name` and focused `instructions`.',
            'Pass one child per tool call. Emit sibling `subagent` calls in the same response for independent slices so they run concurrently; keep dependent work sequential.',
            'Keep fan-out to the minimum useful number, normally two or three children, and do not delegate work whose coordination cost exceeds doing it directly.',
            'Give each child a self-contained outcome, relevant paths, invariants, acceptance criteria, expected report, and a narrow child-safe tool allowlist when practical; the child does not see the parent conversation.',
            'Use exact `provider/id` model references, or `model: "inherit"` for an explicit parent-model clone. An unavailable explicit model fails and never silently falls back.',
            'Use worktree isolation for parallel or background writers. Do not send overlapping write tasks to siblings unless the parent is prepared to resolve their conflicts.',
            'Use lifecycle actions only with an agentId returned by an earlier call; stale IDs fail explicitly.',
            'Call `review` to retrieve and inspect the child\'s isolated raw diff before requesting `apply`.',
            'Call `apply` only when the reviewed patch is ready, then run parent-owned verification and call `cleanup`; discard rejected work with `cleanup`.',
            'The parent owns synthesis, conflict resolution, review, apply, verification, cleanup, and the final user-facing report.',
        ],
        parameters: SubagentParamsSchema,
        executionMode: 'parallel',
        async execute(_toolCallId, rawParams, signal, onUpdate) {
            const params = rawParams as unknown as SubagentToolParams;
            const action = params.action ?? 'spawn';
            let latest: SubagentToolDetails = {
                agentId: params.agentId,
                name: params.agent?.trim() || params.name?.trim() || (params.agentId ? `subagent ${params.agentId}` : 'ad-hoc'),
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
                ...(params.name ? { name: params.name } : {}),
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
