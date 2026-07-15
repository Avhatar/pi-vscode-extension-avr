import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';
import { stripClaudeHtmlComments } from './markdown';
import { canonicalPath, isCanonicalDescendant, isSameOrDescendant, normalizePathForCompare } from './path-scope';
import { isClaudePathExcluded, loadClaudeMdExcludes } from './settings';

export const CLAUDE_RULES_DIRECTORY = path.join('.claude', 'rules');
export const CLAUDE_RULE_APPLIED_ENTRY = 'claude-compat-rule-applied';

export interface ClaudeRule {
    path: string;
    canonicalPath: string;
    relativePath: string;
    sourceScope: 'user' | 'project';
    content: string;
    patterns: string[];
    projectWide: boolean;
    fingerprint: string;
}

export interface ClaudeRuleDiagnostic {
    kind: 'read-error' | 'frontmatter-error' | 'invalid-paths' | 'invalid-pattern' | 'settings-error';
    path: string;
    message: string;
}

export interface ClaudeRuleIndex {
    rules: ClaudeRule[];
    diagnostics: ClaudeRuleDiagnostic[];
}

export interface ClaudeRuleOptions {
    userClaudeDirectory?: string;
}

export interface RuleToolTarget {
    path: string;
    directoryScope: boolean;
    recursiveScope?: boolean;
}

interface DiscoveredRuleFile {
    path: string;
    scope: 'user' | 'project';
    baseDirectory: string;
}

interface CachedRule {
    mtimeMs: number;
    size: number;
    rule?: ClaudeRule;
    diagnostics: ClaudeRuleDiagnostic[];
}

const ruleCache = new Map<string, CachedRule>();
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);

function findMarkdownFiles(directory: string, scope: 'user' | 'project'): DiscoveredRuleFile[] {
    const files: DiscoveredRuleFile[] = [];
    const visitedDirectories = new Set<string>();
    const visit = (current: string): void => {
        let canonicalDirectory: string;
        try {
            canonicalDirectory = canonicalPath(current);
            const key = normalizePathForCompare(canonicalDirectory);
            if (visitedDirectories.has(key) || !fs.statSync(current).isDirectory()) return;
            visitedDirectories.add(key);
        } catch {
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const candidate = path.join(current, entry.name);
            try {
                const stats = fs.statSync(candidate); // follows symlinks intentionally
                if (stats.isDirectory()) visit(candidate);
                else if (stats.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                    files.push({ path: candidate, scope, baseDirectory: directory });
                }
            } catch {
                // Ignore broken links and entries that disappear during discovery.
            }
        }
    };
    visit(directory);
    return files;
}

function normalizePattern(pattern: string): string {
    return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function hasInvalidBracketExpression(pattern: string): boolean {
    for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] === '\\') {
            index++;
            continue;
        }
        if (pattern[index] !== '[') continue;
        let closed = false;
        for (let cursor = index + 1; cursor < pattern.length; cursor++) {
            if (pattern[cursor] === '\\') {
                cursor++;
                continue;
            }
            if (pattern[cursor] === ']') {
                closed = true;
                index = cursor;
                break;
            }
        }
        if (!closed) return true;
    }
    return false;
}

function fingerprint(content: string, patterns: string[], projectWide: boolean): string {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ content, patterns, projectWide }))
        .digest('hex');
}

function displayRulePath(file: DiscoveredRuleFile): string {
    const relative = path.relative(file.baseDirectory, file.path).replace(/\\/g, '/');
    return file.scope === 'user'
        ? `~/.claude/rules/${relative}`
        : `.claude/rules/${relative}`;
}

function parseRule(file: DiscoveredRuleFile): CachedRule {
    let stats: fs.Stats;
    try {
        stats = fs.statSync(file.path);
    } catch {
        return {
            mtimeMs: 0,
            size: 0,
            diagnostics: [{ kind: 'read-error', path: file.path, message: 'Rule file is not readable.' }],
        };
    }

    const resolved = canonicalPath(file.path);
    const key = `${normalizePathForCompare(resolved)}|${file.scope}`;
    const cached = ruleCache.get(key);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;

    let source: string;
    try {
        source = fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, '');
    } catch (error) {
        const result = {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            diagnostics: [{ kind: 'read-error' as const, path: file.path, message: (error as Error).message }],
        };
        ruleCache.set(key, result);
        return result;
    }

    const diagnostics: ClaudeRuleDiagnostic[] = [];
    const frontmatterMatch = source.match(FRONTMATTER_PATTERN);
    let content = source;
    let patterns: string[] = [];
    let projectWide = true;

    if (frontmatterMatch) {
        content = source.slice(frontmatterMatch[0].length);
        try {
            const metadata = parseYaml(frontmatterMatch[1]) as Record<string, unknown> | null;
            if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'paths')) {
                projectWide = false;
                const rawPaths = metadata.paths;
                const values = typeof rawPaths === 'string'
                    ? [rawPaths]
                    : Array.isArray(rawPaths) && rawPaths.every((value) => typeof value === 'string')
                        ? rawPaths as string[]
                        : undefined;
                if (!values) {
                    diagnostics.push({
                        kind: 'invalid-paths',
                        path: file.path,
                        message: 'Frontmatter paths must be a string or an array of strings.',
                    });
                } else {
                    patterns = values.map(normalizePattern).filter(Boolean);
                    if (patterns.length === 0) {
                        diagnostics.push({
                            kind: 'invalid-paths',
                            path: file.path,
                            message: 'Frontmatter paths must contain at least one non-empty pattern.',
                        });
                    }
                }
            }
        } catch (error) {
            projectWide = false;
            diagnostics.push({ kind: 'frontmatter-error', path: file.path, message: (error as Error).message });
        }
    }

    const validPatterns: string[] = [];
    for (const pattern of patterns) {
        try {
            if (hasInvalidBracketExpression(pattern)) throw new Error('Unclosed bracket expression.');
            new Minimatch(pattern, { dot: true });
            validPatterns.push(pattern);
        } catch (error) {
            diagnostics.push({
                kind: 'invalid-pattern',
                path: file.path,
                message: `${pattern}: ${(error as Error).message}`,
            });
        }
    }
    patterns = validPatterns;
    content = stripClaudeHtmlComments(content).trim();

    const rule: ClaudeRule = {
        path: path.resolve(file.path),
        canonicalPath: resolved,
        relativePath: displayRulePath(file),
        sourceScope: file.scope,
        content,
        patterns,
        projectWide,
        fingerprint: fingerprint(content, patterns, projectWide),
    };
    const result = { mtimeMs: stats.mtimeMs, size: stats.size, rule, diagnostics };
    ruleCache.set(key, result);
    return result;
}

export function indexClaudeRules(cwd: string, options: ClaudeRuleOptions = {}): ClaudeRuleIndex {
    const userClaudeDirectory = options.userClaudeDirectory ?? path.join(os.homedir(), '.claude');
    const sources: Array<{ directory: string; scope: 'user' | 'project' }> = [
        { directory: path.join(userClaudeDirectory, 'rules'), scope: 'user' },
        { directory: path.join(cwd, CLAUDE_RULES_DIRECTORY), scope: 'project' },
    ];
    const excludes = loadClaudeMdExcludes(cwd, userClaudeDirectory);
    const rulesByCanonicalPath = new Map<string, ClaudeRule>();
    const diagnostics: ClaudeRuleDiagnostic[] = excludes.diagnostics.map((diagnostic) => ({
        kind: 'settings-error',
        path: diagnostic.path,
        message: diagnostic.message,
    }));

    for (const source of sources) {
        for (const file of findMarkdownFiles(source.directory, source.scope)) {
            const canonical = canonicalPath(file.path);
            if (isClaudePathExcluded(file.path, excludes) || isClaudePathExcluded(canonical, excludes)) continue;
            const parsed = parseRule(file);
            if (parsed.rule) rulesByCanonicalPath.set(normalizePathForCompare(parsed.rule.canonicalPath), parsed.rule);
            diagnostics.push(...parsed.diagnostics);
        }
    }
    return { rules: Array.from(rulesByCanonicalPath.values()), diagnostics };
}

export function ruleMatchesPath(
    rule: ClaudeRule,
    targetPath: string,
    cwd: string,
    directoryScope = false,
    recursiveScope = false,
): boolean {
    if (rule.projectWide) return true;
    if (rule.patterns.length === 0) return false;

    const resolved = path.resolve(cwd, targetPath);
    if (!isSameOrDescendant(cwd, resolved)) return false;
    try {
        if (fs.existsSync(resolved) && !isCanonicalDescendant(cwd, resolved)) return false;
    } catch {
        return false;
    }

    const relative = path.relative(cwd, resolved).replace(/\\/g, '/').replace(/^\.\//, '');
    if (recursiveScope && (relative === '' || relative === '.')) return true;
    const isDirectory = directoryScope || (() => {
        try { return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory(); } catch { return false; }
    })();
    return rule.patterns.some((pattern) => new Minimatch(pattern, {
        dot: true,
        nocase: process.platform === 'win32',
        partial: isDirectory,
    }).match(relative));
}

export function matchingClaudeRules(rules: ClaudeRule[], targets: RuleToolTarget[], cwd: string): ClaudeRule[] {
    return rules.filter((rule) => targets.some((target) =>
        ruleMatchesPath(rule, target.path, cwd, target.directoryScope, target.recursiveScope ?? false),
    ));
}

export function extractRuleToolTargets(toolName: string, input: any): RuleToolTarget[] {
    if (!PATH_TOOLS.has(toolName)) return [];
    const targetPath = typeof input?.path === 'string' && input.path.length > 0 ? input.path : '.';
    return [{
        path: targetPath,
        directoryScope: toolName === 'grep' || toolName === 'find' || toolName === 'ls',
        recursiveScope: toolName === 'grep' || toolName === 'find',
    }];
}

export function renderClaudeRules(rules: ClaudeRule[], cwd: string, heading = 'Claude project rules'): string {
    if (rules.length === 0) return '';
    const sections = rules.map((rule) => `## Rule source: ${rule.relativePath}\n\n${rule.content}`);
    return `# ${heading}\n\n${sections.join('\n\n---\n\n')}`;
}

export function clearClaudeRuleCache(): void {
    ruleCache.clear();
}
