import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { wrapClaudeCompatibilityContent } from './boundary';
import { isExcludedClaudeDiscoveryPath } from './discovery';
import { canonicalPath, isSameOrDescendant, normalizePathForCompare } from './path-scope';
import {
    extractClaudeToolReferences,
    formatClaudeToolCompatibility,
} from './tool-compat';

export type ClaudeResourceScope = 'user' | 'project';

interface ClaudeResourceBase {
    kind: 'skill' | 'command';
    name: string;
    description: string;
    argumentHint?: string;
    path: string;
    canonicalPath: string;
    baseDir: string;
    scope: ClaudeResourceScope;
    body: string;
    ignoredRuntimeFields: string[];
    toolReferences: string[];
}

export interface ClaudeSkillResource extends ClaudeResourceBase {
    kind: 'skill';
    displayName: string;
    disableModelInvocation: boolean;
    userInvocable: boolean;
    arguments: string[];
    baseName: string;
    appliesToDirectory?: string;
}

export interface ClaudeCommandResource extends ClaudeResourceBase {
    kind: 'command';
}

export type ClaudeInvocableResource = ClaudeSkillResource | ClaudeCommandResource;

export interface ClaudeResourceDiagnostic {
    kind: 'read-error' | 'frontmatter-error' | 'collision' | 'invalid-resource' | 'unsupported-runtime-field';
    path: string;
    message: string;
}

export interface ClaudeResourceIndex {
    skills: ClaudeSkillResource[];
    commands: ClaudeCommandResource[];
    diagnostics: ClaudeResourceDiagnostic[];
}

export interface ClaudeResourceOptions {
    userClaudeDirectory?: string;
    projectSkillDirectories?: string[];
    projectSkillFiles?: string[];
    projectCommandDirectories?: string[];
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const RUNTIME_FIELDS = [
    'allowed-tools',
    'disallowed-tools',
    'model',
    'effort',
    'context',
    'agent',
    'hooks',
    'paths',
    'shell',
] as const;

interface ParsedMarkdown {
    metadata: Record<string, unknown>;
    body: string;
    diagnostics: ClaudeResourceDiagnostic[];
}

interface DiscoveredFile {
    path: string;
    scope: ClaudeResourceScope;
    root: string;
    qualifier?: string;
    appliesToDirectory?: string;
}

function parseLooseFrontmatter(source: string): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) continue;
        const [, key, raw] = match;
        if (raw === 'true') metadata[key] = true;
        else if (raw === 'false') metadata[key] = false;
        else if (/^\[.*\]$/.test(raw) || /^['"].*['"]$/.test(raw)) {
            try { metadata[key] = parseYaml(raw); } catch { metadata[key] = raw; }
        } else metadata[key] = raw;
    }
    return metadata;
}

function parseMarkdown(filePath: string): ParsedMarkdown {
    let source: string;
    try {
        source = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    } catch (error) {
        return {
            metadata: {},
            body: '',
            diagnostics: [{ kind: 'read-error', path: filePath, message: (error as Error).message }],
        };
    }
    const match = source.match(FRONTMATTER_PATTERN);
    if (!match) return { metadata: {}, body: source, diagnostics: [] };
    try {
        const parsed = parseYaml(match[1]);
        const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        return { metadata, body: source.slice(match[0].length), diagnostics: [] };
    } catch (error) {
        return {
            metadata: parseLooseFrontmatter(match[1]),
            body: source.slice(match[0].length),
            diagnostics: [{
                kind: 'frontmatter-error',
                path: filePath,
                message: `${(error as Error).message} Recovered supported top-level fields with the compatibility parser.`,
            }],
        };
    }
}

function firstParagraph(body: string): string {
    const paragraph = body
        .split(/\r?\n\s*\r?\n/)
        .map((value) => value.trim())
        .find(Boolean) ?? '';
    return paragraph.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').slice(0, 1536);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
    if (typeof value === 'string') return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
    return [];
}

function runtimeFields(metadata: Record<string, unknown>): string[] {
    return RUNTIME_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(metadata, field));
}

function runtimeDiagnostics(filePath: string, fields: string[]): ClaudeResourceDiagnostic[] {
    return fields.length === 0 ? [] : [{
        kind: 'unsupported-runtime-field',
        path: filePath,
        message: `${fields.join(', ')} remain subject to the current Pi runtime/tool contract and are not granted or emulated.`,
    }];
}

function discoverSkillFiles(directory: string, scope: ClaudeResourceScope): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];
    const visited = new Set<string>();
    const visit = (current: string): void => {
        let canonical: string;
        try {
            canonical = canonicalPath(current);
            const key = normalizePathForCompare(canonical);
            if (visited.has(key) || !fs.statSync(current).isDirectory()) return;
            visited.add(key);
        } catch {
            return;
        }
        const skillFile = path.join(current, 'SKILL.md');
        try {
            if (fs.statSync(skillFile).isFile()) {
                files.push({ path: skillFile, scope, root: directory });
                return;
            }
        } catch {
            // Continue recursively when this directory is not itself a skill.
        }
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const candidate = path.join(current, entry.name);
            try { if (fs.statSync(candidate).isDirectory()) visit(candidate); } catch { /* broken link */ }
        }
    };
    visit(directory);
    return files;
}

function discoverCommandFiles(directory: string, scope: ClaudeResourceScope): DiscoveredFile[] {
    const files: DiscoveredFile[] = [];
    const visited = new Set<string>();
    const visit = (current: string): void => {
        try {
            const key = normalizePathForCompare(canonicalPath(current));
            if (visited.has(key) || !fs.statSync(current).isDirectory()) return;
            visited.add(key);
        } catch { return; }
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const candidate = path.join(current, entry.name);
            try {
                const stats = fs.statSync(candidate);
                if (stats.isDirectory()) visit(candidate);
                else if (stats.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                    files.push({ path: candidate, scope, root: directory });
                }
            } catch { /* broken link */ }
        }
    };
    visit(directory);
    return files;
}

function projectDirectories(cwd: string, leaf: string): string[] {
    return [path.join(cwd, '.claude', leaf)];
}

function nestedSkillFile(cwd: string, filePath: string): DiscoveredFile | undefined {
    const resolved = path.resolve(filePath);
    const relative = path.relative(cwd, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    if (isExcludedClaudeDiscoveryPath(cwd, resolved)) return undefined;
    const segments = relative.split(path.sep);
    const marker = segments.findIndex((segment, index) =>
        segment === '.claude' && segments[index + 1] === 'skills',
    );
    if (marker <= 0 || segments.at(-1) !== 'SKILL.md' || marker + 3 >= segments.length) return undefined;
    const scopeSegments = segments.slice(0, marker);
    const appliesToDirectory = path.join(cwd, ...scopeSegments);
    return {
        path: resolved,
        scope: 'project',
        root: path.join(appliesToDirectory, '.claude', 'skills'),
        qualifier: scopeSegments.join('/'),
        appliesToDirectory,
    };
}

function parseSkill(file: DiscoveredFile): { resource?: ClaudeSkillResource; diagnostics: ClaudeResourceDiagnostic[] } {
    const parsed = parseMarkdown(file.path);
    if (parsed.diagnostics.some((diagnostic) => diagnostic.kind === 'read-error')) return { diagnostics: parsed.diagnostics };
    const directoryName = path.basename(path.dirname(file.path));
    const invocationName = file.qualifier ? `${file.qualifier}:${directoryName}` : directoryName;
    const descriptionBase = stringValue(parsed.metadata.description) ?? firstParagraph(parsed.body);
    const whenToUse = stringValue(parsed.metadata.when_to_use);
    const description = [descriptionBase, whenToUse].filter(Boolean).join(' ').slice(0, 1536);
    const diagnostics = [...parsed.diagnostics];
    if (!description) diagnostics.push({ kind: 'invalid-resource', path: file.path, message: 'Skill has no description or readable first paragraph.' });
    const ignoredRuntimeFields = runtimeFields(parsed.metadata);
    if (/(?:^|\s)!`|^```!/m.test(parsed.body)) ignoredRuntimeFields.push('dynamic-shell-execution');
    diagnostics.push(...runtimeDiagnostics(file.path, ignoredRuntimeFields));
    return {
        resource: {
            kind: 'skill',
            name: invocationName,
            displayName: stringValue(parsed.metadata.name) ?? directoryName,
            description: description || directoryName,
            argumentHint: stringValue(parsed.metadata['argument-hint']),
            path: path.resolve(file.path),
            canonicalPath: canonicalPath(file.path),
            baseDir: path.dirname(path.resolve(file.path)),
            scope: file.scope,
            body: parsed.body.trim(),
            disableModelInvocation: parsed.metadata['disable-model-invocation'] === true,
            userInvocable: parsed.metadata['user-invocable'] !== false,
            arguments: stringList(parsed.metadata.arguments),
            baseName: directoryName,
            appliesToDirectory: file.appliesToDirectory,
            ignoredRuntimeFields,
            toolReferences: extractClaudeToolReferences(parsed.body, [
                parsed.metadata['allowed-tools'],
                parsed.metadata['disallowed-tools'],
            ]),
        },
        diagnostics,
    };
}

function parseCommand(file: DiscoveredFile): { resource?: ClaudeCommandResource; diagnostics: ClaudeResourceDiagnostic[] } {
    const parsed = parseMarkdown(file.path);
    if (parsed.diagnostics.some((diagnostic) => diagnostic.kind === 'read-error')) return { diagnostics: parsed.diagnostics };
    const relative = path.relative(file.root, file.path).replace(/\\/g, '/').replace(/\.md$/i, '');
    const name = relative.split('/').join(':');
    const ignoredRuntimeFields = runtimeFields(parsed.metadata);
    return {
        resource: {
            kind: 'command',
            name,
            description: stringValue(parsed.metadata.description) ?? (firstParagraph(parsed.body) || name),
            argumentHint: stringValue(parsed.metadata['argument-hint']),
            path: path.resolve(file.path),
            canonicalPath: canonicalPath(file.path),
            baseDir: path.dirname(path.resolve(file.path)),
            scope: file.scope,
            body: parsed.body.trim(),
            ignoredRuntimeFields,
            toolReferences: extractClaudeToolReferences(parsed.body, [
                parsed.metadata['allowed-tools'],
                parsed.metadata['disallowed-tools'],
            ]),
        },
        diagnostics: [...parsed.diagnostics, ...runtimeDiagnostics(file.path, ignoredRuntimeFields)],
    };
}

function addWithPrecedence<T extends ClaudeInvocableResource>(
    map: Map<string, T>,
    resource: T,
    diagnostics: ClaudeResourceDiagnostic[],
): void {
    const key = resource.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
        map.set(key, resource);
        return;
    }
    diagnostics.push({
        kind: 'collision',
        path: resource.path,
        message: `${resource.kind} "${resource.name}" is shadowed by ${existing.scope} ${existing.kind} at ${existing.path}.`,
    });
}

export function indexClaudeResources(cwd: string, options: ClaudeResourceOptions = {}): ClaudeResourceIndex {
    const userClaudeDirectory = options.userClaudeDirectory ?? path.join(os.homedir(), '.claude');
    const skillSources: Array<{ directory: string; scope: ClaudeResourceScope }> = [
        { directory: path.join(userClaudeDirectory, 'skills'), scope: 'user' },
        ...(options.projectSkillDirectories ?? projectDirectories(cwd, 'skills')).map((directory) => ({ directory, scope: 'project' as const })),
    ];
    const commandSources: Array<{ directory: string; scope: ClaudeResourceScope }> = [
        { directory: path.join(userClaudeDirectory, 'commands'), scope: 'user' },
        ...(options.projectCommandDirectories ?? projectDirectories(cwd, 'commands')).map((directory) => ({ directory, scope: 'project' as const })),
    ];
    const diagnostics: ClaudeResourceDiagnostic[] = [];
    const skills = new Map<string, ClaudeSkillResource>();
    const commands = new Map<string, ClaudeCommandResource>();
    const canonicalSkills = new Set<string>();
    const canonicalCommands = new Set<string>();

    for (const source of skillSources) {
        for (const file of discoverSkillFiles(source.directory, source.scope)) {
            const parsed = parseSkill(file);
            diagnostics.push(...parsed.diagnostics);
            if (!parsed.resource) continue;
            const canonical = normalizePathForCompare(parsed.resource.canonicalPath);
            if (canonicalSkills.has(canonical)) continue;
            canonicalSkills.add(canonical);
            addWithPrecedence(skills, parsed.resource, diagnostics);
        }
    }
    for (const filePath of options.projectSkillFiles ?? []) {
        const file = nestedSkillFile(cwd, filePath);
        if (!file) {
            diagnostics.push({ kind: 'invalid-resource', path: filePath, message: 'Nested skill is outside the workspace or has an invalid .claude/skills layout.' });
            continue;
        }
        const parsed = parseSkill(file);
        diagnostics.push(...parsed.diagnostics);
        if (!parsed.resource) continue;
        const canonical = normalizePathForCompare(parsed.resource.canonicalPath);
        if (canonicalSkills.has(canonical)) continue;
        canonicalSkills.add(canonical);
        addWithPrecedence(skills, parsed.resource, diagnostics);
    }
    for (const source of commandSources) {
        for (const file of discoverCommandFiles(source.directory, source.scope)) {
            const parsed = parseCommand(file);
            diagnostics.push(...parsed.diagnostics);
            if (!parsed.resource) continue;
            const canonical = normalizePathForCompare(parsed.resource.canonicalPath);
            if (canonicalCommands.has(canonical)) continue;
            canonicalCommands.add(canonical);
            if (skills.has(parsed.resource.name.toLowerCase())) {
                diagnostics.push({
                    kind: 'collision',
                    path: parsed.resource.path,
                    message: `command "${parsed.resource.name}" is shadowed by a skill with the same name.`,
                });
                continue;
            }
            addWithPrecedence(commands, parsed.resource, diagnostics);
        }
    }
    return { skills: Array.from(skills.values()), commands: Array.from(commands.values()), diagnostics };
}

function parseArguments(raw: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: string | undefined;
    for (let index = 0; index < raw.length; index++) {
        const character = raw[index];
        if (quote) {
            if (character === quote) quote = undefined;
            else current += character;
        } else if (character === '"' || character === "'") quote = character;
        else if (/\s/.test(character)) {
            if (current) { args.push(current); current = ''; }
        } else current += character;
    }
    if (current) args.push(current);
    return args;
}

function replaceSkillArguments(
    resource: ClaudeSkillResource,
    rawArguments: string,
    cwd: string,
    sessionId?: string,
    effort?: string,
): string {
    const args = parseArguments(rawArguments);
    const names = new Map(resource.arguments.map((name, index) => [name, index]));
    let sawAllArguments = false;
    let content = resource.body.replace(/\\?\$(ARGUMENTS(?:\[(\d+)\])?|\d+|[A-Za-z_][A-Za-z0-9_-]*)|\$\{(CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_EFFORT)\}/g,
        (match, token: string | undefined, indexed: string | undefined, environment: string | undefined) => {
            if (match.startsWith('\\$')) return match.slice(1);
            if (environment === 'CLAUDE_SESSION_ID') return sessionId ?? 'pi-session';
            if (environment === 'CLAUDE_SKILL_DIR') return resource.baseDir.replace(/\\/g, '/');
            if (environment === 'CLAUDE_PROJECT_DIR') return cwd.replace(/\\/g, '/');
            if (environment === 'CLAUDE_EFFORT') return effort ?? 'inherit';
            if (token === 'ARGUMENTS') { sawAllArguments = true; return rawArguments.trim(); }
            if (token?.startsWith('ARGUMENTS[')) return args[Number(indexed)] ?? '';
            if (token && /^\d+$/.test(token)) return args[Number(token)] ?? '';
            const namedIndex = token ? names.get(token) : undefined;
            return namedIndex === undefined ? match : args[namedIndex] ?? '';
        });
    if (rawArguments.trim() && !sawAllArguments) content += `\n\nARGUMENTS: ${rawArguments.trim()}`;
    return content;
}

function replaceCommandArguments(resource: ClaudeCommandResource, rawArguments: string): string {
    const args = parseArguments(rawArguments);
    return resource.body.replace(/\\?\$(ARGUMENTS|\d+)/g, (match, token: string) => {
        if (match.startsWith('\\$')) return match.slice(1);
        if (token === 'ARGUMENTS') return rawArguments.trim();
        return args[Number(token) - 1] ?? '';
    });
}

export function renderClaudeInvocableResource(
    resource: ClaudeInvocableResource,
    rawArguments: string,
    cwd: string,
    sessionId?: string,
    effort?: string,
    availableTools: Iterable<string> = [],
): string {
    let body = resource.kind === 'skill'
        ? replaceSkillArguments(resource, rawArguments, cwd, sessionId, effort)
        : replaceCommandArguments(resource, rawArguments);
    body = body.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, cwd.replace(/\\/g, '/'));
    const source = path.relative(cwd, resource.path).replace(/\\/g, '/');
    const unsupported = resource.ignoredRuntimeFields.length > 0
        ? `\n\nCompatibility note: Claude runtime fields (${resource.ignoredRuntimeFields.join(', ')}) do not alter the current Pi identity, permissions, model, or tool contract.`
        : '';
    const toolCompatibility = formatClaudeToolCompatibility(resource.toolReferences, availableTools);
    return wrapClaudeCompatibilityContent(
        `# Adapted Claude ${resource.kind}: ${resource.name}\n\n` +
        `Source: ${source.startsWith('..') ? resource.path.replace(/\\/g, '/') : source}\n` +
        `Resolve relative file references against: ${resource.baseDir.replace(/\\/g, '/')}\n\n${body}${unsupported}` +
        (toolCompatibility ? `\n\n---\n\n${toolCompatibility}` : ''),
    );
}

function renderSkillCatalog(skills: ClaudeSkillResource[], cwd: string, heading: string): string {
    if (skills.length === 0) return '';
    const lines = [
        `# ${heading}`,
        '',
        'These are project resources, not Claude identity or runtime extensions. Read the listed SKILL.md only when the task matches, then apply it through the current Pi tools and instruction hierarchy.',
        'Tool names use capability mapping: Claude `Read`/`Glob`/etc. mean the available Pi equivalents, and `mcp__server__tool` means the registered `server_tool` direct tool or the existing Pi `mcp` proxy. Never call an unavailable Claude-form name literally.',
    ];
    for (const skill of skills) {
        const location = path.relative(cwd, skill.path).replace(/\\/g, '/');
        lines.push('', `- ${skill.name}: ${skill.description}`, `  location: ${location.startsWith('..') ? skill.path.replace(/\\/g, '/') : location}`);
    }
    return lines.join('\n');
}

export function renderClaudeSkillCatalog(index: ClaudeResourceIndex, cwd: string): string {
    return renderSkillCatalog(
        index.skills.filter((skill) => !skill.disableModelInvocation && !skill.appliesToDirectory),
        cwd,
        'Available adapted Claude skills',
    );
}

export function matchingNestedClaudeSkills(
    index: ClaudeResourceIndex,
    targetPaths: Iterable<string>,
    cwd: string,
): ClaudeSkillResource[] {
    const resolvedTargets = Array.from(targetPaths, (target) => path.resolve(cwd, target));
    return index.skills.filter((skill) =>
        !skill.disableModelInvocation &&
        Boolean(skill.appliesToDirectory) &&
        resolvedTargets.some((target) => isSameOrDescendant(skill.appliesToDirectory!, target)),
    );
}

export function renderNestedClaudeSkillCatalog(skills: ClaudeSkillResource[], cwd: string): string {
    return renderSkillCatalog(skills, cwd, 'Directory-scoped adapted Claude skills');
}
