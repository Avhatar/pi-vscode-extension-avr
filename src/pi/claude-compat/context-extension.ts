import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolCallEvent,
    ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { wrapClaudeCompatibilityContent } from './boundary';
import {
    buildPathInstructions,
    buildRootInstructions,
    getUserClaudeDirectory,
    renderExpansion,
    type ClaudeContextOptions,
    type RenderedInstructions,
} from './context';
import type { ImportDiagnostic } from './imports';
import { normalizePathForCompare } from './path-scope';
import {
    CLAUDE_RULE_APPLIED_ENTRY,
    extractRuleToolTargets,
    indexClaudeRules,
    matchingClaudeRules,
    renderClaudeRules,
    ruleMatchesPath,
    type ClaudeRule,
    type ClaudeRuleDiagnostic,
} from './rules';
import {
    matchingNestedClaudeSkills,
    renderClaudeInvocableResource,
    renderClaudeSkillCatalog,
    renderNestedClaudeSkillCatalog,
    type ClaudeInvocableResource,
    type ClaudeResourceIndex,
} from './resources';
import { loadClaudeMdExcludes } from './settings';
import {
    extractClaudeToolReferences,
    formatClaudeToolCompatibility,
    resolveClaudeToolReferences,
} from './tool-compat';
import {
    CLAUDE_CONTEXT_DELIVERED_ENTRY,
    CLAUDE_INSTRUCTION_APPLIED_ENTRY,
    CLAUDE_NESTED_SKILL_APPLIED_ENTRY,
    filterUnappliedInstructions,
    filterUnappliedNestedSkills,
    getCurrentAssistantTurnId,
    getEntriesSinceLastCompaction,
    getRuleApplicationState,
    wasClaudeContextDelivered,
} from './session-state';

const MAX_TEXT_SCAN = 1_000_000;
const MAX_PATH_CANDIDATES = 500;

function collectPiContextPaths(
    cwd: string,
    contextFiles: Array<{ path: string; content?: string }> | undefined,
): string[] {
    const paths = new Set<string>();
    for (const file of contextFiles ?? []) {
        if (typeof file?.path === 'string' && file.path.length > 0) {
            paths.add(path.resolve(cwd, file.path));
        }
    }
    return Array.from(paths);
}

function getTextToScan(event: ToolResultEvent): string {
    let text = '';
    try {
        text += JSON.stringify(event.input ?? {}) + '\n';
    } catch {
        // Ignore circular tool input.
    }

    if (Array.isArray(event.content)) {
        for (const block of event.content) {
            if (block?.type === 'text' && typeof block.text === 'string') text += `${block.text}\n`;
        }
    } else if (typeof event.content === 'string') {
        text += `${event.content}\n`;
    }
    return text.slice(0, MAX_TEXT_SCAN);
}

function collectExplicitToolPaths(toolName: string | undefined, input: any): string[] {
    const paths = new Set<string>();
    const add = (value: unknown) => {
        if (typeof value === 'string' && value.length > 0) paths.add(value);
    };

    if (['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(toolName ?? '')) {
        add(input?.path);
        add(input?.file);
        add(input?.directory);
    }
    if (toolName === 'tool_batch') {
        for (const call of Array.isArray(input?.calls) ? input.calls : []) {
            const nestedTool = call?.tool ?? call?.name;
            if (!['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(nestedTool)) continue;
            const args = call?.args ?? call?.arguments ?? call;
            add(args?.path);
            add(args?.file);
            add(args?.directory);
        }
    }
    return Array.from(paths);
}

function extractPotentialPaths(text: string): string[] {
    const paths = new Set<string>();
    for (const token of text.split(/[\s'"\[\]{}()<>:;,|*]+/)) {
        if (!token || token.length < 3) continue;
        if (token.includes('/') || token.includes('\\') || /\.[a-zA-Z0-9]{2,8}$/.test(token)) {
            paths.add(token);
            if (paths.size >= MAX_PATH_CANDIDATES) break;
        }
    }
    return Array.from(paths);
}

function diagnosticLine(diagnostic: ImportDiagnostic, cwd: string): string {
    const source = path.relative(cwd, diagnostic.source).replace(/\\/g, '/') || diagnostic.source;
    const reference = diagnostic.reference ? ` @${diagnostic.reference}` : '';
    const target = diagnostic.target ? ` -> ${diagnostic.target.replace(/\\/g, '/')}` : '';
    return `- ${diagnostic.kind}: ${source}${reference}${target}`;
}

function formatFiles(section: string, instructions: RenderedInstructions, cwd: string): string[] {
    const lines = [`## ${section}`];
    if (instructions.files.length === 0) {
        lines.push('- none');
    } else {
        for (const file of instructions.files) {
            const relative = path.relative(cwd, file.path).replace(/\\/g, '/');
            const label = relative.startsWith('..') ? file.path.replace(/\\/g, '/') : relative;
            const imported = file.importedBy
                ? ` (imported by ${path.relative(cwd, file.importedBy).replace(/\\/g, '/')})`
                : '';
            lines.push(`- ${label}${imported}`);
        }
    }
    if (instructions.diagnostics.length > 0) {
        lines.push('');
        lines.push('### Import diagnostics');
        for (const diagnostic of instructions.diagnostics) lines.push(diagnosticLine(diagnostic, cwd));
    }
    return lines;
}

function formatRuleDiagnostics(diagnostics: ClaudeRuleDiagnostic[], cwd: string): string[] {
    if (diagnostics.length === 0) return [];
    return [
        '',
        '### Rule diagnostics',
        ...diagnostics.map((diagnostic) => {
            const relative = path.relative(cwd, diagnostic.path).replace(/\\/g, '/');
            return `- ${diagnostic.kind}: ${relative}: ${diagnostic.message}`;
        }),
    ];
}

function formatRules(
    rules: ClaudeRule[],
    entries: any[],
    currentTurnId: string,
    cwd: string,
): string[] {
    if (rules.length === 0) return ['- none'];
    return rules.map((rule) => {
        const scope = rule.projectWide ? 'project-wide' : rule.patterns.join(', ');
        const state = rule.projectWide ? 'bounded context message' : getRuleApplicationState(rule, entries, currentTurnId);
        return `- [${state}] ${rule.relativePath} (${scope})`;
    });
}

function formatStatusReport(
    args: string,
    ctx: ExtensionCommandContext,
    options: ClaudeContextExtensionOptions,
): string {
    const root = buildRootInstructions(ctx.cwd, [], options);
    const target = args.trim();
    const pathInstructions = target ? buildPathInstructions(ctx.cwd, [target], new Set(), options) : undefined;
    const branch = ctx.sessionManager.getBranch();
    const entries = getEntriesSinceLastCompaction(branch);
    const currentTurnId = getCurrentAssistantTurnId(entries, ctx.sessionManager.getLeafId?.() ?? undefined);
    const userClaudeDirectory = getUserClaudeDirectory(options);
    const ruleIndex = indexClaudeRules(ctx.cwd, { userClaudeDirectory });
    const excludes = loadClaudeMdExcludes(ctx.cwd, userClaudeDirectory);
    const applicableRules = target
        ? ruleIndex.rules.filter((rule) => ruleMatchesPath(rule, target, ctx.cwd, false))
        : ruleIndex.rules;
    const lines = [
        '# Claude Compatibility Status',
        '',
        `- cwd: ${ctx.cwd.replace(/\\/g, '/')}`,
        '- mode: provider-independent resource adaptation, not Claude identity/runtime emulation',
        '- identity/runtime: the selected Pi agent, model, system instructions, permissions, and tool contract remain authoritative',
        '- delivery: instruction contents are injected as compatibility-bounded context messages; no read tool call is required',
        `- entries since last compaction: ${entries.length}`,
        '',
        ...formatFiles('Root instructions', root, ctx.cwd),
    ];

    lines.push('', '## claudeMdExcludes');
    if (excludes.patterns.length === 0) lines.push('- none');
    else lines.push(...excludes.patterns.map((pattern) => `- ${pattern}`));

    lines.push('', '## Claude rules', ...formatRules(applicableRules, entries, currentTurnId, ctx.cwd));
    lines.push(...formatRuleDiagnostics(ruleIndex.diagnostics, ctx.cwd));

    const resources = options.resources;
    lines.push('', '## Adapted Claude skills');
    if (!resources || resources.skills.length === 0) lines.push('- none');
    else for (const skill of resources.skills) {
        const invocation = skill.userInvocable ? `/${skill.name}` : 'model-only';
        const visibility = skill.disableModelInvocation ? 'manual-only' : 'model-visible';
        const scope = skill.appliesToDirectory
            ? `directory=${path.relative(ctx.cwd, skill.appliesToDirectory).replace(/\\/g, '/')}`
            : skill.scope;
        lines.push(`- ${skill.name} [${scope}, ${visibility}, ${invocation}, tool refs=${skill.toolReferences.length}]`);
    }
    lines.push('', '## Adapted legacy Claude commands');
    if (!resources || resources.commands.length === 0) lines.push('- none');
    else for (const command of resources.commands) lines.push(`- /${command.name} [${command.scope}]`);
    if (resources && resources.diagnostics.length > 0) {
        lines.push('', '### Skill/command diagnostics');
        for (const diagnostic of resources.diagnostics) {
            lines.push(`- ${diagnostic.kind}: ${diagnostic.path.replace(/\\/g, '/')}: ${diagnostic.message}`);
        }
    }
    if (resources) {
        let activeTools: string[] = [];
        try {
            const selected = ctx.getSystemPromptOptions?.().selectedTools;
            if (Array.isArray(selected)) activeTools = selected.filter((tool): tool is string => typeof tool === 'string');
        } catch { /* status remains useful without runtime tool metadata */ }
        const references = [...resources.skills, ...resources.commands].flatMap((resource) => resource.toolReferences);
        const resolutions = resolveClaudeToolReferences(references, activeTools);
        const unresolved = resolutions.filter((resolution) =>
            resolution.status === 'unavailable' || resolution.status === 'deferred-agent' || resolution.status === 'runtime-only',
        );
        lines.push('', '## Tool-reference compatibility');
        lines.push(`- references: ${resolutions.length}`);
        lines.push(`- mapped/native/proxy: ${resolutions.length - unresolved.length}`);
        lines.push(`- deferred/runtime-only/unavailable: ${unresolved.length}`);
        for (const resolution of unresolved) lines.push(`- ${resolution.reference} [${resolution.status}]: ${resolution.message}`);
    }

    if (target && pathInstructions) {
        lines.push('', `# For path: ${target.replace(/\\/g, '/')}`, '', ...formatFiles('Path-scoped instructions', pathInstructions, ctx.cwd));
    } else {
        lines.push('', 'Tip: run `/claude-compat path/to/file` to inspect path-specific instructions and rules.');
    }
    return lines.join('\n');
}

export interface ClaudeContextExtensionOptions extends ClaudeContextOptions {
    contextEnabled?: boolean;
    rulesEnabled?: boolean;
    resources?: ClaudeResourceIndex;
}

const PI_BUILTIN_COMMANDS = new Set([
    'settings', 'model', 'scoped-models', 'export', 'import', 'share', 'copy', 'name', 'session',
    'changelog', 'hotkeys', 'fork', 'clone', 'tree', 'trust', 'login', 'logout', 'new', 'compact',
    'resume', 'reload', 'quit',
]);

function registerClaudeInvocables(
    pi: ExtensionAPI,
    resources: ClaudeResourceIndex | undefined,
): void {
    if (!resources) return;
    const occupied = new Set(PI_BUILTIN_COMMANDS);
    try {
        for (const command of pi.getCommands?.() ?? []) occupied.add(command.name.toLowerCase());
    } catch {
        // Startup may not have finalized prompt/skill resources yet; built-in
        // names are still protected and extension collisions receive Pi suffixes.
    }
    const invocables: ClaudeInvocableResource[] = [
        ...resources.skills.filter((skill) => skill.userInvocable),
        ...resources.commands,
    ];
    for (const resource of invocables) {
        const preferred = resource.name;
        const name = occupied.has(preferred.toLowerCase()) ? `claude:${preferred}` : preferred;
        occupied.add(name.toLowerCase());
        const hint = resource.argumentHint ? `${resource.argumentHint} — ` : '';
        pi.registerCommand(name, {
            description: `${hint}${resource.description}`,
            handler: async (args, ctx) => {
                const sessionId = ctx.sessionManager.getSessionId?.();
                const effort = pi.getThinkingLevel?.();
                const activeTools = pi.getActiveTools?.() ?? [];
                const content = renderClaudeInvocableResource(resource, args, ctx.cwd, sessionId, effort, activeTools);
                if (ctx.isIdle()) pi.sendUserMessage(content);
                else pi.sendUserMessage(content, { deliverAs: 'followUp' });
            },
        });
    }
}

export function createClaudeContextExtension(
    options: ClaudeContextExtensionOptions = {},
): (pi: ExtensionAPI) => void {
    return (pi) => {
        const contextEnabled = options.contextEnabled ?? true;
        const rulesEnabled = options.rulesEnabled ?? true;
        const hasVisibleSkills = options.resources?.skills.some((skill) =>
            !skill.disableModelInvocation && !skill.appliesToDirectory,
        ) === true;
        const showStatus = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
            pi.sendMessage(
                {
                    customType: 'claude-md-injector-status',
                    content: formatStatusReport(args, ctx, options),
                    display: true,
                },
                { triggerTurn: false },
            );
        };

        pi.registerCommand('claude-compat', {
            description: 'Show Claude infrastructure compatibility status for this session',
            handler: showStatus,
        });
        pi.registerCommand('claude-md-injector', {
            description: 'Alias for /claude-compat',
            handler: showStatus,
        });
        registerClaudeInvocables(pi, options.resources);

        if (contextEnabled || rulesEnabled || hasVisibleSkills) pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
            const branch = ctx.sessionManager.getBranch();
            const preloaded = contextEnabled
                ? collectPiContextPaths(ctx.cwd, event.systemPromptOptions?.contextFiles)
                : [];
            const instructions = contextEnabled
                ? buildRootInstructions(ctx.cwd, preloaded, options)
                : { content: '' };
            const projectWideRules = rulesEnabled
                ? indexClaudeRules(ctx.cwd, { userClaudeDirectory: getUserClaudeDirectory(options) }).rules
                    .filter((rule) => rule.projectWide && rule.content.length > 0)
                : [];
            const renderedRules = renderClaudeRules(projectWideRules, ctx.cwd);
            const renderedSkillCatalog = options.resources
                ? renderClaudeSkillCatalog(options.resources, ctx.cwd)
                : '';
            const additions = [instructions.content, renderedRules, renderedSkillCatalog].filter(Boolean);
            if (additions.length === 0) return;

            const content = wrapClaudeCompatibilityContent(additions.join('\n\n'));
            const fingerprint = crypto.createHash('sha256').update(content).digest('hex');
            if (wasClaudeContextDelivered(branch, fingerprint)) return;
            pi.appendEntry(CLAUDE_CONTEXT_DELIVERED_ENTRY, { fingerprint });
            return {
                message: {
                    customType: 'claude-compat-context',
                    content,
                    display: false,
                },
            };
        });

        const hasNestedSkills = options.resources?.skills.some((skill) => Boolean(skill.appliesToDirectory)) === true;
        if (rulesEnabled || hasNestedSkills) pi.on('tool_call', async (event: ToolCallEvent, ctx: ExtensionContext) => {
            const targets = extractRuleToolTargets(event.toolName, event.input);
            if (targets.length === 0) return;

            const branch = ctx.sessionManager.getBranch();
            const nestedSkills = options.resources
                ? filterUnappliedNestedSkills(
                    matchingNestedClaudeSkills(options.resources, targets.map((target) => target.path), ctx.cwd),
                    branch,
                )
                : [];
            if (nestedSkills.length > 0) {
                pi.sendMessage(
                    {
                        customType: 'claude-compat-nested-skills',
                        content: wrapClaudeCompatibilityContent(renderNestedClaudeSkillCatalog(nestedSkills, ctx.cwd)),
                        display: true,
                    },
                    { deliverAs: 'steer', triggerTurn: false },
                );
                for (const skill of nestedSkills) {
                    pi.appendEntry(CLAUDE_NESTED_SKILL_APPLIED_ENTRY, { path: skill.canonicalPath });
                }
            }

            const ruleIndex = rulesEnabled
                ? indexClaudeRules(ctx.cwd, { userClaudeDirectory: getUserClaudeDirectory(options) })
                : { rules: [] };
            const matching = matchingClaudeRules(
                ruleIndex.rules.filter((rule) => !rule.projectWide && rule.content.length > 0),
                targets,
                ctx.cwd,
            );
            const currentTurnId = getCurrentAssistantTurnId(branch, ctx.sessionManager.getLeafId?.() ?? event.toolCallId);
            const states = matching.map((rule) => ({
                rule,
                state: getRuleApplicationState(rule, branch, currentTurnId),
            }));
            const requiresRuleBlock = states.some(({ state }) => state !== 'applied');
            const newlyQueued = states.filter(({ state }) => state === 'unseen').map(({ rule }) => rule);
            if (newlyQueued.length > 0) {
                pi.sendMessage(
                    {
                        customType: 'claude-compat-rules',
                        content: wrapClaudeCompatibilityContent(
                            renderClaudeRules(newlyQueued, ctx.cwd, 'Claude rules required before retrying the blocked tool call'),
                        ),
                        display: true,
                    },
                    { deliverAs: 'steer', triggerTurn: false },
                );
                for (const rule of newlyQueued) {
                    pi.appendEntry(CLAUDE_RULE_APPLIED_ENTRY, {
                        path: rule.canonicalPath,
                        fingerprint: rule.fingerprint,
                        sourceTurnId: currentTurnId,
                    });
                }
            }

            if (nestedSkills.length === 0 && !requiresRuleBlock) return;
            return {
                block: true,
                reason: 'Directory-scoped Claude resources were added to context. Retry this tool call after reviewing them.',
            };
        });

        if (contextEnabled || rulesEnabled || options.resources) pi.on('tool_result', async (event: ToolResultEvent, ctx: ExtensionContext) => {
            const scannedText = getTextToScan(event);
            const toolReferences = extractClaudeToolReferences(scannedText);
            const toolCompatibility = formatClaudeToolCompatibility(
                toolReferences,
                pi.getActiveTools?.() ?? [],
            );
            const targets = new Set<string>(collectExplicitToolPaths(event.toolName, event.input));
            for (const candidate of extractPotentialPaths(scannedText)) targets.add(candidate);
            if (targets.size === 0 && !toolCompatibility) return;
            const sortedTargets = Array.from(targets).sort();
            const branch = ctx.sessionManager.getBranch();

            const rootExpansion = contextEnabled
                ? buildRootInstructions(ctx.cwd, [], options)
                : { files: [] };
            const rootFiles = new Set(rootExpansion.files.map((file) => normalizePathForCompare(file.canonicalPath)));
            const scoped = contextEnabled
                ? buildPathInstructions(ctx.cwd, sortedTargets, rootFiles, options)
                : { files: [], diagnostics: [] };
            const unappliedInstructions = filterUnappliedInstructions(scoped.files, branch);
            const renderedInstructions = renderExpansion(
                { files: unappliedInstructions, diagnostics: scoped.diagnostics },
                ctx.cwd,
            );

            const fallbackNestedSkills = options.resources
                ? filterUnappliedNestedSkills(
                    matchingNestedClaudeSkills(options.resources, sortedTargets, ctx.cwd),
                    branch,
                )
                : [];
            const renderedNestedSkills = renderNestedClaudeSkillCatalog(fallbackNestedSkills, ctx.cwd);

            const currentTurnId = getCurrentAssistantTurnId(branch, ctx.sessionManager.getLeafId?.() ?? event.toolCallId);
            const fallbackRules = matchingClaudeRules(
                rulesEnabled
                    ? indexClaudeRules(ctx.cwd, { userClaudeDirectory: getUserClaudeDirectory(options) }).rules
                        .filter((rule) => !rule.projectWide && rule.content.length > 0)
                    : [],
                sortedTargets.map((target) => ({ path: target, directoryScope: false })),
                ctx.cwd,
            ).filter((rule) => getRuleApplicationState(rule, branch, currentTurnId) === 'unseen');
            const renderedRules = renderClaudeRules(
                fallbackRules,
                ctx.cwd,
                'Claude path rules discovered from tool output',
            );

            if (!renderedInstructions.content && !renderedRules && !renderedNestedSkills && !toolCompatibility) return;

            for (const file of unappliedInstructions) {
                pi.appendEntry(CLAUDE_INSTRUCTION_APPLIED_ENTRY, {
                    path: file.canonicalPath,
                    fingerprint: file.fingerprint,
                });
            }
            for (const skill of fallbackNestedSkills) {
                pi.appendEntry(CLAUDE_NESTED_SKILL_APPLIED_ENTRY, { path: skill.canonicalPath });
            }
            for (const rule of fallbackRules) {
                pi.appendEntry(CLAUDE_RULE_APPLIED_ENTRY, {
                    path: rule.canonicalPath,
                    fingerprint: rule.fingerprint,
                    sourceTurnId: currentTurnId,
                });
            }

            const additions = wrapClaudeCompatibilityContent(
                [renderedInstructions.content, renderedRules, renderedNestedSkills, toolCompatibility].filter(Boolean).join('\n\n'),
            );
            const content = [...event.content];
            content.push({
                type: 'text' as const,
                text: `\n\n---\n[Claude compatibility: adapted project resources]\n\n${additions}`,
            });
            return { content };
        });
    };
}
