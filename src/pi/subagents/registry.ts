import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseModelRef } from './model-ref';
import type {
    AgentDefinition,
    AgentDefinitionDiagnostic,
    AgentDefinitionSource,
    AgentRegistrySnapshot,
} from './types';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_FIELDS = new Set([
    'name',
    'description',
    'model',
    'thinkingLevel',
    'thinking-level',
    'tools',
    'disallowedTools',
    'disallowed-tools',
    'skills',
    'mcpServers',
    'mcp-servers',
    'maxTurns',
    'max-turns',
    'timeoutMinutes',
    'timeout-minutes',
    'background',
    'contextMode',
    'context-mode',
    'isolation',
]);

const SOURCE_PRIORITY: Record<AgentDefinitionSource, number> = {
    runtime: 0,
    project: 10,
    'claude-compat': 20,
    user: 30,
    package: 40,
};

function definitionPriority(definition: AgentDefinition): number {
    if (definition.source === 'claude-compat' && definition.scope === 'user') return 35;
    return SOURCE_PRIORITY[definition.source];
}

async function resolveProjectAgentsDirectory(cwd: string): Promise<string> {
    const canonical = path.join(cwd, '.agents', 'agents');
    if (await isDirectory(canonical)) return canonical;
    return path.join(cwd, '.pi', 'agents');
}

async function resolveUserAgentsDirectory(): Promise<string> {
    const canonical = path.join(os.homedir(), '.agents', 'agents');
    if (await isDirectory(canonical)) return canonical;
    return path.join(os.homedir(), '.pi', 'agent', 'agents');
}

export interface AgentRegistryOptions {
    cwd: string;
    workspaceTrusted: boolean;
    userAgentsDirectory?: string;
    projectAgentsDirectory?: string;
    runtimeDefinitions?: readonly AgentDefinition[];
    packageDefinitions?: readonly AgentDefinition[];
    claudeDefinitions?: readonly AgentDefinition[];
    additionalDiagnostics?: readonly AgentDefinitionDiagnostic[];
}

interface ParsedAgentFile {
    definition?: AgentDefinition;
    diagnostics: AgentDefinitionDiagnostic[];
}

interface Candidate {
    definition: AgentDefinition;
    order: number;
}

export class AgentRegistry {
    private readonly options: AgentRegistryOptions;
    private definitions = new Map<string, AgentDefinition>();
    private diagnostics: AgentDefinitionDiagnostic[] = [];

    constructor(options: AgentRegistryOptions) {
        this.options = options;
    }

    async reload(): Promise<AgentRegistrySnapshot> {
        const diagnostics: AgentDefinitionDiagnostic[] = (this.options.additionalDiagnostics ?? [])
            .map((entry) => ({ ...entry }));
        const candidates: Candidate[] = [];
        let order = 0;

        const addProgrammatic = (definition: AgentDefinition, expectedSource: AgentDefinitionSource): void => {
            const normalized = validateProgrammaticDefinition(definition, expectedSource);
            if ('diagnostic' in normalized) diagnostics.push(normalized.diagnostic);
            else candidates.push({ definition: normalized.definition, order: order++ });
        };

        for (const definition of this.options.packageDefinitions ?? []) addProgrammatic(definition, 'package');
        for (const definition of this.options.claudeDefinitions ?? []) addProgrammatic(definition, 'claude-compat');

        const userDirectory = this.options.userAgentsDirectory ?? await resolveUserAgentsDirectory();
        for (const filePath of await discoverMarkdownFiles(userDirectory, 'user', diagnostics)) {
            const parsed = await parseAgentFile(filePath, 'user');
            diagnostics.push(...parsed.diagnostics);
            if (parsed.definition) candidates.push({ definition: parsed.definition, order: order++ });
        }

        const projectDirectory = this.options.projectAgentsDirectory ?? await resolveProjectAgentsDirectory(this.options.cwd);
        if (this.options.workspaceTrusted) {
            for (const filePath of await discoverMarkdownFiles(projectDirectory, 'project', diagnostics)) {
                const parsed = await parseAgentFile(filePath, 'project');
                diagnostics.push(...parsed.diagnostics);
                if (parsed.definition) candidates.push({ definition: parsed.definition, order: order++ });
            }
        } else if (await isDirectory(projectDirectory)) {
            diagnostics.push({
                code: 'untrusted-project',
                severity: 'warning',
                source: 'project',
                filePath: projectDirectory,
                message: `Project agent definitions were not loaded because the workspace is not trusted: ${projectDirectory}`,
            });
        }

        for (const definition of this.options.runtimeDefinitions ?? []) addProgrammatic(definition, 'runtime');

        const selected = selectDefinitions(candidates, diagnostics);
        this.definitions = new Map(selected.map((definition) => [normalizeAgentName(definition.name), definition]));
        this.diagnostics = diagnostics;
        return this.snapshot();
    }

    get(name: string): AgentDefinition | undefined {
        const definition = this.definitions.get(normalizeAgentName(name));
        return definition ? cloneDefinition(definition) : undefined;
    }

    list(): AgentDefinition[] {
        return [...this.definitions.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(cloneDefinition);
    }

    snapshot(): AgentRegistrySnapshot {
        return {
            definitions: this.list().map(cloneDefinition),
            diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        };
    }
}

export async function parseAgentFile(
    filePath: string,
    source: Extract<AgentDefinitionSource, 'project' | 'user' | 'package' | 'claude-compat'>,
): Promise<ParsedAgentFile> {
    let text: string;
    try {
        text = (await fs.promises.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    } catch (error) {
        return {
            diagnostics: [diagnostic('read-error', filePath, source, (error as Error).message)],
        };
    }

    const match = text.match(FRONTMATTER_PATTERN);
    if (!match) {
        return {
            diagnostics: [diagnostic(
                'frontmatter-error',
                filePath,
                source,
                'Agent files must begin with YAML frontmatter delimited by --- lines.',
            )],
        };
    }

    let metadata: Record<string, unknown>;
    try {
        const parsed = parseYaml(match[1]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Frontmatter must be a YAML mapping.');
        }
        metadata = parsed as Record<string, unknown>;
    } catch (error) {
        return {
            diagnostics: [diagnostic('frontmatter-error', filePath, source, (error as Error).message)],
        };
    }

    const issues: string[] = [];
    const unknownFields = Object.keys(metadata).filter((key) => !ALLOWED_FIELDS.has(key));
    if (unknownFields.length > 0) issues.push(`Unknown frontmatter fields: ${unknownFields.sort().join(', ')}.`);
    for (const [camelCase, kebabCase] of [
        ['thinkingLevel', 'thinking-level'],
        ['disallowedTools', 'disallowed-tools'],
        ['mcpServers', 'mcp-servers'],
        ['maxTurns', 'max-turns'],
        ['timeoutMinutes', 'timeout-minutes'],
        ['contextMode', 'context-mode'],
    ] as const) {
        if (Object.prototype.hasOwnProperty.call(metadata, camelCase) && Object.prototype.hasOwnProperty.call(metadata, kebabCase)) {
            issues.push(`Use either ${camelCase} or ${kebabCase}, not both.`);
        }
    }

    const name = requiredString(metadata.name, 'name', issues);
    const description = requiredString(metadata.description, 'description', issues);
    if (name && !AGENT_NAME_PATTERN.test(name)) {
        issues.push('name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.');
    }
    if (description && description.length > 1536) issues.push('description must not exceed 1536 characters.');

    const model = parseOptionalModel(metadata.model, issues);
    const thinkingLevel = optionalString(firstDefined(metadata, 'thinkingLevel', 'thinking-level'), 'thinkingLevel', issues);
    const tools = optionalStringList(metadata.tools, 'tools', issues);
    const disallowedTools = optionalStringList(firstDefined(metadata, 'disallowedTools', 'disallowed-tools'), 'disallowedTools', issues);
    const skills = optionalStringList(metadata.skills, 'skills', issues);
    const mcpServers = optionalStringList(firstDefined(metadata, 'mcpServers', 'mcp-servers'), 'mcpServers', issues);
    const maxTurns = optionalInteger(firstDefined(metadata, 'maxTurns', 'max-turns'), 'maxTurns', 1, 1000, issues);
    const timeoutMinutes = optionalInteger(firstDefined(metadata, 'timeoutMinutes', 'timeout-minutes'), 'timeoutMinutes', 1, 1440, issues);
    const background = optionalBoolean(metadata.background, 'background', issues);
    const contextMode = optionalEnum(firstDefined(metadata, 'contextMode', 'context-mode'), 'contextMode', ['fresh', 'fork'] as const, issues);
    const isolation = optionalEnum(metadata.isolation, 'isolation', ['shared-workspace', 'worktree'] as const, issues);

    if (issues.length > 0 || !name || !description) {
        return {
            diagnostics: [diagnostic('invalid-definition', filePath, source, issues.join(' '), name)],
        };
    }

    const instructions = text.slice(match[0].length).trim();
    return {
        definition: {
            name,
            description,
            ...(instructions ? { instructions } : {}),
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            ...(tools !== undefined ? { tools } : {}),
            ...(disallowedTools !== undefined ? { disallowedTools } : {}),
            ...(skills !== undefined ? { skills } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
            ...(background !== undefined ? { background } : {}),
            ...(contextMode ? { contextMode } : {}),
            ...(isolation ? { isolation } : {}),
            source,
            filePath: path.resolve(filePath),
        },
        diagnostics: [],
    };
}

export function normalizeAgentName(name: string): string {
    return name.trim().toLocaleLowerCase('en-US');
}

function validateProgrammaticDefinition(
    definition: AgentDefinition,
    expectedSource: AgentDefinitionSource,
): { definition: AgentDefinition } | { diagnostic: AgentDefinitionDiagnostic } {
    const name = typeof definition.name === 'string' ? definition.name.trim() : '';
    const description = typeof definition.description === 'string' ? definition.description.trim() : '';
    const issues: string[] = [];
    if (!AGENT_NAME_PATTERN.test(name)) issues.push('invalid name');
    if (!description) issues.push('description is required');
    if (definition.source !== expectedSource) issues.push(`source must be ${expectedSource}`);
    if (issues.length > 0) {
        return {
            diagnostic: {
                code: 'invalid-definition',
                severity: 'error',
                source: expectedSource,
                agentName: name || undefined,
                filePath: definition.filePath,
                message: `Invalid ${expectedSource} agent definition: ${issues.join(', ')}.`,
            },
        };
    }
    return { definition: cloneDefinition({ ...definition, name, description }) };
}

function selectDefinitions(
    candidates: Candidate[],
    diagnostics: AgentDefinitionDiagnostic[],
): AgentDefinition[] {
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
        const key = normalizeAgentName(candidate.definition.name);
        const group = groups.get(key) ?? [];
        group.push(candidate);
        groups.set(key, group);
    }

    const selected: AgentDefinition[] = [];
    for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        group.sort((left, right) => {
            const priority = definitionPriority(left.definition) - definitionPriority(right.definition);
            if (priority !== 0) return priority;
            const byPath = (left.definition.filePath ?? '').localeCompare(right.definition.filePath ?? '');
            return byPath !== 0 ? byPath : left.order - right.order;
        });

        const winningPriority = definitionPriority(group[0].definition);
        const winners = group.filter((candidate) => definitionPriority(candidate.definition) === winningPriority);
        if (winners.length > 1) {
            for (const winner of winners) {
                diagnostics.push({
                    code: 'duplicate-name',
                    severity: 'error',
                    source: winner.definition.source,
                    filePath: winner.definition.filePath,
                    agentName: winner.definition.name,
                    message: `Duplicate agent name "${winner.definition.name}" at ${winner.definition.source} scope; no definition named "${key}" was selected.`,
                });
            }
            continue;
        }

        const winner = winners[0].definition;
        selected.push(winner);
        for (const shadowed of group.slice(1)) {
            diagnostics.push({
                code: 'shadowed-definition',
                severity: 'info',
                source: shadowed.definition.source,
                filePath: shadowed.definition.filePath,
                agentName: shadowed.definition.name,
                message: `Agent "${shadowed.definition.name}" from ${shadowed.definition.source} scope is shadowed by ${winner.source} scope.`,
            });
        }
    }
    return selected;
}

async function discoverMarkdownFiles(
    rootDirectory: string,
    source: AgentDefinitionSource,
    diagnostics: AgentDefinitionDiagnostic[],
): Promise<string[]> {
    if (!await isDirectory(rootDirectory)) return [];
    const root = path.resolve(rootDirectory);
    let canonicalRoot: string;
    try {
        canonicalRoot = await fs.promises.realpath(root);
    } catch (error) {
        diagnostics.push(diagnostic('read-error', root, source, (error as Error).message));
        return [];
    }

    const files: string[] = [];
    const visited = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
        let canonicalDirectory: string;
        try {
            canonicalDirectory = await fs.promises.realpath(directory);
            if (!isSameOrDescendant(canonicalRoot, canonicalDirectory) || visited.has(canonicalDirectory)) return;
            visited.add(canonicalDirectory);
        } catch (error) {
            diagnostics.push(diagnostic('read-error', directory, source, (error as Error).message));
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(directory, { withFileTypes: true });
        } catch (error) {
            diagnostics.push(diagnostic('read-error', directory, source, (error as Error).message));
            return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const candidate = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                diagnostics.push({
                    code: 'unsafe-path',
                    severity: 'warning',
                    source,
                    filePath: candidate,
                    message: `Skipped symbolic link while discovering agent definitions: ${candidate}`,
                });
                continue;
            }
            if (entry.isDirectory()) await visit(candidate);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(candidate);
        }
    };
    await visit(root);
    return files.sort((left, right) => left.localeCompare(right));
}

async function isDirectory(candidate: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(candidate)).isDirectory();
    } catch {
        return false;
    }
}

function isSameOrDescendant(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function diagnostic(
    code: AgentDefinitionDiagnostic['code'],
    filePath: string,
    source: AgentDefinitionSource,
    message: string,
    agentName?: string,
): AgentDefinitionDiagnostic {
    return { code, severity: 'error', filePath, source, message, agentName };
}

function firstDefined(metadata: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)) return metadata[key];
    }
    return undefined;
}

function requiredString(value: unknown, label: string, issues: string[]): string | undefined {
    const result = optionalString(value, label, issues);
    if (result === undefined) issues.push(`${label} is required.`);
    return result;
}

function optionalString(value: unknown, label: string, issues: string[]): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
        issues.push(`${label} must be a non-empty string.`);
        return undefined;
    }
    return value.trim();
}

function optionalStringList(value: unknown, label: string, issues: string[]): string[] | undefined {
    if (value === undefined) return undefined;
    const raw = typeof value === 'string' ? value.split(/[\s,]+/) : value;
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !item.trim())) {
        issues.push(`${label} must be a string or an array of non-empty strings.`);
        return undefined;
    }
    return [...new Set(raw.map((item) => (item as string).trim()))];
}

function optionalInteger(
    value: unknown,
    label: string,
    minimum: number,
    maximum: number,
    issues: string[],
): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        issues.push(`${label} must be an integer between ${minimum} and ${maximum}.`);
        return undefined;
    }
    return value as number;
}

function optionalBoolean(value: unknown, label: string, issues: string[]): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        issues.push(`${label} must be a boolean.`);
        return undefined;
    }
    return value;
}

function optionalEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    issues: string[],
): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        issues.push(`${label} must be one of: ${allowed.join(', ')}.`);
        return undefined;
    }
    return value as T;
}

function parseOptionalModel(value: unknown, issues: string[]): AgentDefinition['model'] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === 'inherit') return 'inherit';
    if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))) {
        issues.push('model must be "inherit", provider/id, or a { provider, id } mapping.');
        return undefined;
    }
    try {
        return parseModelRef(value as string | { provider: string; id: string });
    } catch (error) {
        issues.push((error as Error).message);
        return undefined;
    }
}

function cloneDefinition(definition: AgentDefinition): AgentDefinition {
    return {
        ...definition,
        ...(definition.model && definition.model !== 'inherit' ? { model: { ...definition.model } } : {}),
        ...(definition.tools ? { tools: [...definition.tools] } : {}),
        ...(definition.disallowedTools ? { disallowedTools: [...definition.disallowedTools] } : {}),
        ...(definition.skills ? { skills: [...definition.skills] } : {}),
        ...(definition.mcpServers ? { mcpServers: [...definition.mcpServers] } : {}),
    };
}
