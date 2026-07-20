import type { WorkspaceFileSuggestion } from '../../shared/agent-protocol';

export interface FileMentionEntry {
    readonly relativePath: string;
    readonly relativePathLower: string;
    readonly basename: string;
    readonly basenameLower: string;
}

export interface FileMentionSettingsInput {
    readonly enabled?: boolean;
    readonly useDefaultExcludes?: boolean;
    readonly exclude?: readonly string[];
    readonly maxSuggestions?: number;
    readonly configPath?: string;
}

export interface ProjectFileMentionConfig {
    readonly useDefaultExcludes?: boolean;
    readonly exclude?: readonly string[];
    readonly maxSuggestions?: number;
}

export interface FileMentionConfig {
    readonly enabled: boolean;
    readonly useDefaultExcludes: boolean;
    readonly exclude: string[];
    readonly maxSuggestions: number;
    readonly configPath: string;
}

export const DEFAULT_FILE_MENTION_EXCLUDES = [
    '**/.git/**',
    '**/node_modules/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/coverage/**',
    '**/.vscode-test/**',
    '**/*.map',
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa',
    '**/id_ed25519',
] as const;

export const DEFAULT_FILE_MENTION_MAX_SUGGESTIONS = 30;
export const DEFAULT_FILE_MENTION_CONFIG_PATH = '.pi/file-mentions.json';

export function createFileMentionEntry(relativePath: string): FileMentionEntry {
    const normalized = normalizeFileMentionPath(relativePath);
    const basename = normalized.split('/').pop() ?? normalized;
    return {
        relativePath: normalized,
        relativePathLower: normalized.toLowerCase(),
        basename,
        basenameLower: basename.toLowerCase(),
    };
}

export function searchFileMentionEntries(
    entries: readonly FileMentionEntry[],
    query: string,
    maxSuggestions: number,
): WorkspaceFileSuggestion[] {
    const limit = Math.max(1, Math.min(200, maxSuggestions));
    const normalizedQuery = normalizeFileMentionPath(query).trim().toLowerCase();
    const scored: Array<{ entry: FileMentionEntry; score: number }> = [];
    for (const entry of entries) {
        const score = scoreEntry(entry, normalizedQuery);
        if (score !== null) scored.push({ entry, score });
    }
    scored.sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score;
        if (left.entry.relativePath.length !== right.entry.relativePath.length) {
            return left.entry.relativePath.length - right.entry.relativePath.length;
        }
        return left.entry.relativePath.localeCompare(right.entry.relativePath);
    });
    return scored.slice(0, limit).map(({ entry }) => ({
        relativePath: entry.relativePath,
        basename: entry.basename,
        insertText: formatFileMentionInsertText(entry.relativePath),
    }));
}

export type FileMentionLookup =
    | readonly FileMentionEntry[]
    | Map<string, FileMentionEntry>;

export function extractValidFileMentions(
    text: string,
    entries: FileMentionLookup,
): string[] {
    const byPath = entries instanceof Map
        ? entries
        : new Map(entries.map((entry) => [entry.relativePathLower, entry]));
    if (byPath.size === 0) return [];
    const found: string[] = [];
    const seen = new Set<string>();
    for (const candidate of parseMentionCandidates(text)) {
        const key = normalizeFileMentionPath(candidate).toLowerCase();
        const entry = byPath.get(key);
        if (!entry || seen.has(key)) continue;
        seen.add(key);
        found.push(entry.relativePath);
    }
    return found;
}

export function augmentPromptWithFileMentions(
    text: string,
    entries: FileMentionLookup,
): string {
    const mentions = extractValidFileMentions(text, entries);
    if (mentions.length === 0) return text;
    return `${text}\n\nReferenced workspace files to inspect if needed:\n${mentions.map((entry) => `- ${entry}`).join('\n')}`;
}

export function resolveFileMentionConfig(
    settings: FileMentionSettingsInput,
    project: ProjectFileMentionConfig = {},
): FileMentionConfig {
    const projectUseDefaults = typeof project.useDefaultExcludes === 'boolean'
        ? project.useDefaultExcludes
        : undefined;
    const settingsUseDefaults = typeof settings.useDefaultExcludes === 'boolean'
        ? settings.useDefaultExcludes
        : undefined;
    const useDefaultExcludes = projectUseDefaults ?? settingsUseDefaults ?? true;
    const settingsExclude = Array.isArray(settings.exclude)
        ? settings.exclude.filter((value): value is string => typeof value === 'string')
        : [];
    const projectExclude = Array.isArray(project.exclude)
        ? project.exclude.filter((value): value is string => typeof value === 'string')
        : [];
    return {
        enabled: typeof settings.enabled === 'boolean' ? settings.enabled : true,
        useDefaultExcludes,
        exclude: uniqueFileMentionPatterns([
            ...(useDefaultExcludes ? DEFAULT_FILE_MENTION_EXCLUDES : []),
            ...settingsExclude,
            ...projectExclude,
        ]),
        maxSuggestions: clampFileMentionNumber(
            project.maxSuggestions ?? settings.maxSuggestions,
            1,
            200,
            DEFAULT_FILE_MENTION_MAX_SUGGESTIONS,
        ),
        configPath: normalizeFileMentionPath(
            typeof settings.configPath === 'string' && settings.configPath
                ? settings.configPath
                : DEFAULT_FILE_MENTION_CONFIG_PATH,
        ),
    };
}

export function compileFileMentionExcludePatterns(patterns: readonly string[]): RegExp[] {
    return patterns.map(fileMentionGlobToRegExp);
}

export function isFileMentionPathExcluded(
    relativePath: string,
    patterns: readonly RegExp[],
): boolean {
    const normalized = normalizeFileMentionPath(relativePath);
    return patterns.some((pattern) => pattern.test(normalized));
}

export function normalizeFileMentionPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function uniqueFileMentionPatterns(patterns: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const pattern of patterns) {
        const normalized = normalizeFileMentionPath(String(pattern ?? '').trim());
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

export function toFileMentionExcludeGlob(patterns: readonly string[]): string | undefined {
    if (patterns.length === 0) return undefined;
    if (patterns.length === 1) return patterns[0];
    return `{${patterns.join(',')}}`;
}

function formatFileMentionInsertText(relativePath: string): string {
    return /\s/.test(relativePath) ? `@{${relativePath}} ` : `@${relativePath} `;
}

function parseMentionCandidates(text: string): string[] {
    const candidates: string[] = [];
    const braced = /@\{([^}\r\n]+)\}/g;
    let bracedMatch: RegExpExecArray | null;
    while ((bracedMatch = braced.exec(text)) !== null) {
        candidates.push(bracedMatch[1].trim());
    }
    const normal = /(^|[\s([{:,;])@([^\s{}]+)/g;
    let normalMatch: RegExpExecArray | null;
    while ((normalMatch = normal.exec(text)) !== null) {
        const raw = normalMatch[2];
        if (!raw) continue;
        const trimmed = raw.replace(/[.,;:!?\])]+$/g, '');
        if (trimmed) candidates.push(trimmed);
    }
    return candidates;
}

function scoreEntry(entry: FileMentionEntry, query: string): number | null {
    if (!query) return 1000;
    const basename = entry.basenameLower;
    const relative = entry.relativePathLower;
    if (basename === query) return 0;
    if (basename.startsWith(query)) return 10 + basename.length - query.length;
    const basenameIndex = basename.indexOf(query);
    if (basenameIndex >= 0) return 100 + basenameIndex + basename.length * 0.01;
    if (relative.startsWith(query)) return 200 + relative.length * 0.01;
    const relativeIndex = relative.indexOf(query);
    if (relativeIndex >= 0) return 300 + relativeIndex + relative.length * 0.01;
    const fuzzy = fuzzyScore(relative, query);
    if (fuzzy !== null) return 500 + fuzzy + relative.length * 0.01;
    return null;
}

function fuzzyScore(value: string, query: string): number | null {
    let valueIndex = 0;
    let score = 0;
    let lastMatch = -1;
    for (let queryIndex = 0; queryIndex < query.length; queryIndex++) {
        const found = value.indexOf(query[queryIndex], valueIndex);
        if (found < 0) return null;
        score += found - valueIndex;
        if (lastMatch >= 0 && found === lastMatch + 1) score -= 1;
        lastMatch = found;
        valueIndex = found + 1;
    }
    return score;
}

function fileMentionGlobToRegExp(glob: string): RegExp {
    const normalized = normalizeFileMentionPath(glob);
    let source = '^';
    for (let index = 0; index < normalized.length; index++) {
        const character = normalized[index];
        const next = normalized[index + 1];
        if (character === '*') {
            if (next === '*') {
                const after = normalized[index + 2];
                if (after === '/') {
                    source += '(?:.*/)?';
                    index += 2;
                } else {
                    source += '.*';
                    index += 1;
                }
            } else {
                source += '[^/]*';
            }
            continue;
        }
        if (character === '?') {
            source += '[^/]';
            continue;
        }
        source += escapeRegExp(character);
    }
    source += '$';
    return new RegExp(source, 'i');
}

function escapeRegExp(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function clampFileMentionNumber(
    value: unknown,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
}
