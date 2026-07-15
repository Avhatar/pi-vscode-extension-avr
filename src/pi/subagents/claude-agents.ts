import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { wrapClaudeCompatibilityContent } from '../claude-compat/boundary';
import { resolveClaudeToolReference } from '../claude-compat/tool-compat';
import { parseModelRef } from './model-ref';
import type { AgentDefinition, AgentDefinitionDiagnostic } from './types';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

export interface ClaudeAgentIndexOptions {
    cwd: string;
    workspaceTrusted: boolean;
    availableChildTools: readonly string[];
    userClaudeDirectory?: string;
    projectAgentDirectories?: readonly string[];
}

export interface ClaudeAgentIndex {
    definitions: AgentDefinition[];
    diagnostics: AgentDefinitionDiagnostic[];
}

export async function indexClaudeAgents(options: ClaudeAgentIndexOptions): Promise<ClaudeAgentIndex> {
    const definitions: AgentDefinition[] = [];
    const diagnostics: AgentDefinitionDiagnostic[] = [];
    const sources: Array<{ directory: string; scope: 'user' | 'project' }> = [{
        directory: path.join(options.userClaudeDirectory ?? path.join(os.homedir(), '.claude'), 'agents'),
        scope: 'user',
    }];
    const projectDirectories = options.projectAgentDirectories ?? [path.join(options.cwd, '.claude', 'agents')];
    if (options.workspaceTrusted) {
        sources.push(...projectDirectories.map((directory) => ({ directory, scope: 'project' as const })));
    } else {
        for (const directory of projectDirectories) {
            if (await isDirectory(directory)) diagnostics.push({
                code: 'untrusted-project', severity: 'warning', source: 'claude-compat', filePath: directory,
                message: `Claude-compatible project agents were not loaded because the workspace is not trusted: ${directory}`,
            });
        }
    }

    const seenFiles = new Set<string>();
    for (const source of sources) {
        for (const filePath of await discoverMarkdown(source.directory, diagnostics)) {
            const key = normalizePath(filePath);
            if (seenFiles.has(key)) continue;
            seenFiles.add(key);
            const parsed = await parseClaudeAgentFile(filePath, source.scope, options.availableChildTools);
            diagnostics.push(...parsed.diagnostics);
            if (parsed.definition) definitions.push(parsed.definition);
        }
    }
    return { definitions, diagnostics };
}

export async function parseClaudeAgentFile(
    filePath: string,
    scope: 'user' | 'project',
    availableChildTools: readonly string[],
): Promise<{ definition?: AgentDefinition; diagnostics: AgentDefinitionDiagnostic[] }> {
    let text: string;
    try { text = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''); }
    catch (error) { return { diagnostics: [diag('read-error', filePath, (error as Error).message)] }; }
    const match = text.match(FRONTMATTER);
    if (!match) return { diagnostics: [diag('frontmatter-error', filePath, 'Claude agent files must begin with YAML frontmatter.')] };
    let metadata: Record<string, unknown>;
    try {
        const parsed = parseYaml(match[1]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Frontmatter must be a YAML mapping.');
        metadata = parsed as Record<string, unknown>;
    } catch (error) { return { diagnostics: [diag('frontmatter-error', filePath, (error as Error).message)] }; }

    const name = stringValue(metadata.name);
    const description = stringValue(metadata.description);
    if (!name || !NAME_PATTERN.test(name) || !description) {
        return { diagnostics: [diag('invalid-definition', filePath, 'Claude agent requires a valid name and non-empty description.', name)] };
    }
    const diagnostics: AgentDefinitionDiagnostic[] = [];
    const allowed = Object.prototype.hasOwnProperty.call(metadata, 'tools') || Object.prototype.hasOwnProperty.call(metadata, 'allowed-tools')
        ? mapTools(listValue(metadata.tools ?? metadata['allowed-tools']), availableChildTools, filePath, diagnostics)
        : undefined;
    const denied = Object.prototype.hasOwnProperty.call(metadata, 'disallowedTools') || Object.prototype.hasOwnProperty.call(metadata, 'disallowed-tools')
        ? mapTools(listValue(metadata.disallowedTools ?? metadata['disallowed-tools']), availableChildTools, filePath, diagnostics)
        : undefined;
    const model = mapClaudeModel(metadata.model, filePath, diagnostics);
    const ignoredFields = ['permissionMode', 'permission-mode', 'hooks', 'memory', 'skills', 'mcpServers', 'mcp-servers']
        .filter((field) => Object.prototype.hasOwnProperty.call(metadata, field));
    if (ignoredFields.length > 0) diagnostics.push(diag(
        'compatibility-normalized', filePath,
        `Claude runtime fields (${ignoredFields.join(', ')}) do not alter Pi identity, permissions, memory, hooks, or runtime.`,
        name, 'info',
    ));
    const body = text.slice(match[0].length).trim();
    const adaptation = [
        `# Adapted Claude agent: ${name}`,
        '',
        `Source: ${path.resolve(filePath).replace(/\\/g, '/')}`,
        'This definition specializes an isolated Pi child session. It does not replace Pi identity, provider policy, permissions, runtime, or tool contracts.',
        '',
        body,
    ].join('\n');
    return {
        definition: {
            name, description,
            instructions: wrapClaudeCompatibilityContent(adaptation),
            model,
            ...(allowed !== undefined ? { tools: allowed } : {}),
            ...(denied !== undefined ? { disallowedTools: denied } : {}),
            source: 'claude-compat', scope, filePath: path.resolve(filePath),
        },
        diagnostics,
    };
}

function mapClaudeModel(
    value: unknown,
    filePath: string,
    diagnostics: AgentDefinitionDiagnostic[],
): AgentDefinition['model'] {
    const raw = stringValue(value);
    if (!raw || raw.toLowerCase() === 'inherit') return 'inherit';
    if (CLAUDE_MODEL_ALIASES.has(raw.toLowerCase())) {
        diagnostics.push(diag(
            'compatibility-normalized', filePath,
            `Claude model alias "${raw}" was normalized to inherit; compatibility never forces an Anthropic provider.`,
            undefined, 'info',
        ));
        return 'inherit';
    }
    try { return parseModelRef(raw, 'Claude-compatible agent model'); }
    catch {
        diagnostics.push(diag(
            'compatibility-normalized', filePath,
            `Unsupported Claude model value "${raw}" was normalized to inherit; no provider fallback was forced.`,
            undefined, 'warning',
        ));
        return 'inherit';
    }
}

function mapTools(
    references: string[],
    availableChildTools: readonly string[],
    filePath: string,
    diagnostics: AgentDefinitionDiagnostic[],
): string[] {
    const mapped: string[] = [];
    for (const reference of references) {
        const resolution = resolveClaudeToolReference(reference, availableChildTools);
        if (resolution.target && (resolution.status === 'native' || resolution.status === 'mapped' || resolution.status === 'proxy')) {
            if (!mapped.includes(resolution.target)) mapped.push(resolution.target);
        } else {
            diagnostics.push(diag(
                'unsupported-capability', filePath,
                `Claude tool "${reference}" was not granted to the child: ${resolution.message}`,
                undefined, 'warning',
            ));
        }
    }
    return mapped;
}

async function discoverMarkdown(root: string, diagnostics: AgentDefinitionDiagnostic[]): Promise<string[]> {
    if (!await isDirectory(root)) return [];
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        let entries: import('node:fs').Dirent[];
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { diagnostics.push(diag('read-error', directory, (error as Error).message)); return; }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const candidate = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                diagnostics.push(diag('unsafe-path', candidate, 'Skipped symbolic link while discovering Claude-compatible agents.', undefined, 'warning'));
            } else if (entry.isDirectory()) await visit(candidate);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(candidate);
        }
    };
    await visit(path.resolve(root));
    return files;
}

function listValue(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
    return values.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
async function isDirectory(candidate: string): Promise<boolean> { try { return (await fs.stat(candidate)).isDirectory(); } catch { return false; } }
function normalizePath(value: string): string { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function diag(
    code: AgentDefinitionDiagnostic['code'], filePath: string, message: string,
    agentName?: string, severity: AgentDefinitionDiagnostic['severity'] = 'error',
): AgentDefinitionDiagnostic {
    return { code, severity, source: 'claude-compat', filePath, message, ...(agentName ? { agentName } : {}) };
}
