import { formatModelRef, parseModelRef } from './model-ref';
import { normalizeAgentName } from './registry';
import type {
    AgentDefinition,
    AvailableModel,
    ModelRef,
    ModelResolutionSource,
    ResolvedAgentSpec,
    ResolutionDiagnostic,
    SubagentInvocation,
    SubagentResolutionPolicy,
    ToolResolutionTrace,
} from './types';

export type AgentLookup = Pick<{ get(name: string): AgentDefinition | undefined }, 'get'>;

export class AgentResolutionError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'AgentResolutionError';
    }
}

interface ModelCandidate {
    model: ModelRef;
    source: ModelResolutionSource;
    explicit: boolean;
}

export function resolveAgentSpec(
    registry: AgentLookup,
    invocation: SubagentInvocation,
    policy: SubagentResolutionPolicy,
): ResolvedAgentSpec {
    const task = requiredText(invocation.task, 'task');
    const requestedAgentName = invocation.agent?.trim();
    const definition = requestedAgentName ? registry.get(requestedAgentName) : undefined;
    if (requestedAgentName && !definition) {
        throw new AgentResolutionError('unknown-agent', `Unknown subagent definition: ${requestedAgentName}`);
    }

    const invocationInstructions = invocation.instructions?.trim();
    const instructions = [definition?.instructions, invocationInstructions].filter(Boolean).join('\n\n') || undefined;
    const diagnostics: ResolutionDiagnostic[] = [];
    const { model, source: modelSource } = resolveModel(definition, invocation, policy, diagnostics);
    const { tools, trace } = resolveTools(definition, invocation, policy, diagnostics);

    const maxTurns = resolveBoundedInteger(
        'maxTurns',
        invocation.maxTurns ?? definition?.maxTurns ?? policy.defaultMaxTurns ?? 30,
        policy.maxTurns ?? 100,
        diagnostics,
    );
    const timeoutMinutes = resolveBoundedInteger(
        'timeoutMinutes',
        invocation.timeoutMinutes ?? definition?.timeoutMinutes ?? policy.defaultTimeoutMinutes ?? 10,
        policy.maxTimeoutMinutes ?? 120,
        diagnostics,
    );

    const thinkingLevel = resolveThinkingLevel(definition, invocation, policy);
    const contextMode = invocation.contextMode ?? definition?.contextMode ?? policy.defaultContextMode ?? 'fresh';
    if (contextMode === 'fork') {
        throw new AgentResolutionError(
            'context-mode-unsupported',
            'Forked parent context is not enabled for subagents; use fresh context to avoid leaking parent conversation data.',
        );
    }
    return {
        name: definition?.name ?? 'ad-hoc',
        ...(definition?.description ? { description: definition.description } : {}),
        source: definition?.source ?? 'invocation',
        ...(definition?.filePath ? { filePath: definition.filePath } : {}),
        task,
        ...(instructions ? { instructions } : {}),
        model,
        modelSource,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        tools,
        toolTrace: trace,
        maxTurns,
        timeoutMinutes,
        background: invocation.background ?? definition?.background ?? false,
        contextMode,
        isolation: invocation.isolation ?? definition?.isolation ?? policy.defaultIsolation ?? 'shared-workspace',
        diagnostics,
    };
}

function resolveModel(
    definition: AgentDefinition | undefined,
    invocation: SubagentInvocation,
    policy: SubagentResolutionPolicy,
    diagnostics: ResolutionDiagnostic[],
): { model: AvailableModel; source: ModelResolutionSource } {
    const available = new Map(policy.availableModels.map((model) => [formatModelRef(model), model]));
    const allowed = policy.allowedModels === undefined || policy.allowedModels.length === 0
        ? undefined
        : new Set(policy.allowedModels.map((value, index) => formatModelRef(parseModelRef(value, `allowedModels[${index}]`))));

    const candidates: ModelCandidate[] = [];
    if (definition) {
        const forced = lookupForcedModel(policy.forcedModelsByAgent, definition.name);
        if (forced) candidates.push({ model: parseModelRef(forced, `forced model for ${definition.name}`), source: 'forced-setting', explicit: true });
    }

    if (invocation.model) {
        if (policy.allowInvocationModelOverride === false) {
            throw new AgentResolutionError(
                'model-override-disabled',
                'This subagent invocation cannot override the model because invocation model overrides are disabled.',
            );
        }
        candidates.push({ model: parseModelRef(invocation.model, 'invocation model'), source: 'invocation', explicit: true });
    }

    if (definition?.model === 'inherit') {
        candidates.push({ model: parseModelRef(policy.parentModel, 'parent model'), source: 'parent', explicit: true });
    } else if (definition?.model) {
        candidates.push({ model: parseModelRef(definition.model, `model for agent ${definition.name}`), source: 'definition', explicit: true });
    }

    if (policy.defaultModel) {
        candidates.push({ model: parseModelRef(policy.defaultModel, 'default subagent model'), source: 'default-setting', explicit: false });
    }
    candidates.push({ model: parseModelRef(policy.parentModel, 'parent model'), source: 'parent', explicit: false });

    for (const candidate of candidates) {
        const key = formatModelRef(candidate.model);
        if (allowed && !allowed.has(key)) {
            if (candidate.explicit) {
                throw new AgentResolutionError('model-disallowed', `Subagent model ${key} is not allowed by settings.`);
            }
            diagnostics.push({
                code: 'default-model-skipped',
                message: `Skipped ${candidate.source} model ${key} because it is not allowed by settings.`,
            });
            continue;
        }
        const resolved = available.get(key);
        if (!resolved) {
            if (candidate.explicit) {
                throw new AgentResolutionError(
                    'model-unavailable',
                    `Subagent model ${key} is unavailable or authentication is not configured; no fallback was applied.`,
                );
            }
            diagnostics.push({
                code: 'default-model-skipped',
                message: `Skipped ${candidate.source} model ${key} because it is unavailable.`,
            });
            continue;
        }
        return { model: { ...resolved }, source: candidate.source };
    }

    throw new AgentResolutionError('no-model', 'No allowed and available model could be resolved for this subagent.');
}

function resolveTools(
    definition: AgentDefinition | undefined,
    invocation: SubagentInvocation,
    policy: SubagentResolutionPolicy,
    diagnostics: ResolutionDiagnostic[],
): { tools: string[]; trace: ToolResolutionTrace } {
    const registered = unique(policy.registeredTools);
    const registeredSet = new Set(registered);
    const active = unique(policy.activeTools).filter((tool) => registeredSet.has(tool));
    const activeSet = new Set(active);
    const hardDenied = new Set(['subagent', ...(policy.nonChildSafeTools ?? [])]);
    const childSafe = unique(policy.childSafeTools).filter((tool) => registeredSet.has(tool) && !hardDenied.has(tool));
    const childSafeSet = new Set(childSafe);

    const definitionAllowlist = definition?.tools === undefined ? undefined : unique(definition.tools);
    const invocationAllowlist = invocation.tools === undefined ? undefined : unique(invocation.tools);
    const definitionDenylist = unique(definition?.disallowedTools ?? []);
    const invocationDenylist = unique(invocation.disallowedTools ?? []);
    const globalDenylist = unique(policy.globallyDisallowedTools ?? []);

    validateKnownTools(registeredSet, definitionAllowlist, `Agent ${definition?.name ?? 'definition'} tools`);
    validateKnownTools(registeredSet, invocationAllowlist, 'Invocation tools');
    validateKnownTools(registeredSet, definitionDenylist, `Agent ${definition?.name ?? 'definition'} disallowedTools`);
    validateKnownTools(registeredSet, invocationDenylist, 'Invocation disallowedTools');
    validateKnownTools(registeredSet, globalDenylist, 'Global disallowed tools');

    let effective = registered.filter((tool) => activeSet.has(tool) && childSafeSet.has(tool));
    const unavailableRequested = unique([
        ...(definitionAllowlist ?? []),
        ...(invocationAllowlist ?? []),
    ]).filter((tool) => !activeSet.has(tool) || !childSafeSet.has(tool));
    for (const tool of unavailableRequested) {
        diagnostics.push({
            code: 'tool-unavailable',
            message: `Requested tool "${tool}" is registered but unavailable to this child and was removed.`,
        });
    }

    if (definitionAllowlist !== undefined) {
        const allowed = new Set(definitionAllowlist);
        effective = effective.filter((tool) => allowed.has(tool));
    }
    if (invocationAllowlist !== undefined) {
        const allowed = new Set(invocationAllowlist);
        effective = effective.filter((tool) => allowed.has(tool));
    }

    const denied = unique([
        ...globalDenylist,
        ...definitionDenylist,
        ...invocationDenylist,
        ...hardDenied,
    ]);
    const deniedSet = new Set(denied);
    effective = effective.filter((tool) => !deniedSet.has(tool));

    return {
        tools: effective,
        trace: {
            registered,
            active,
            childSafe,
            ...(definitionAllowlist !== undefined ? { definitionAllowlist } : {}),
            ...(invocationAllowlist !== undefined ? { invocationAllowlist } : {}),
            denied,
            effective: [...effective],
        },
    };
}

function resolveThinkingLevel(
    definition: AgentDefinition | undefined,
    invocation: SubagentInvocation,
    policy: SubagentResolutionPolicy,
): string | undefined {
    const requested = invocation.thinkingLevel ?? definition?.thinkingLevel ?? policy.defaultThinkingLevel;
    if (!requested || requested === 'inherit') return policy.parentThinkingLevel;
    return requested;
}

function resolveBoundedInteger(
    label: string,
    requested: number,
    maximum: number,
    diagnostics: ResolutionDiagnostic[],
): number {
    if (!Number.isInteger(requested) || requested < 1) {
        throw new AgentResolutionError('invalid-limit', `${label} must be a positive integer.`);
    }
    if (!Number.isInteger(maximum) || maximum < 1) {
        throw new AgentResolutionError('invalid-policy', `${label} policy maximum must be a positive integer.`);
    }
    if (requested <= maximum) return requested;
    diagnostics.push({
        code: 'limit-clamped',
        message: `${label} was clamped from ${requested} to the host maximum ${maximum}.`,
    });
    return maximum;
}

function lookupForcedModel(
    forcedModels: SubagentResolutionPolicy['forcedModelsByAgent'],
    agentName: string,
): ModelRef | string | undefined {
    if (!forcedModels) return undefined;
    const normalized = normalizeAgentName(agentName);
    const entry = Object.entries(forcedModels).find(([name]) => normalizeAgentName(name) === normalized);
    return entry?.[1];
}

function validateKnownTools(registered: Set<string>, names: readonly string[] | undefined, label: string): void {
    if (names === undefined) return;
    const unknown = names.filter((name) => !registered.has(name));
    if (unknown.length > 0) {
        throw new AgentResolutionError(
            'unknown-tool',
            `${label} contains unknown tool names: ${unknown.join(', ')}.`,
        );
    }
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function requiredText(value: string, label: string): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) throw new AgentResolutionError('invalid-invocation', `${label} must be a non-empty string.`);
    return trimmed;
}
