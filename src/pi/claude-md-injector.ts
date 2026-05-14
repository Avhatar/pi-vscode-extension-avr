import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Inline Pi extension that mirrors Claude Code's behavior of auto-loading
 * `CLAUDE.md` (root) and `.claude/CLAUDE.md` plus any nested `CLAUDE.md`
 * files into the agent's context.
 *
 * Hooks:
 *  - `before_agent_start` — instructs the agent to read the bootstrap
 *    `CLAUDE.md` files and any files they `@`-import (depth ≤ 5) that
 *    haven't already been read or pre-loaded by Pi this session.
 *  - `tool_result` — scans tool input / output for repo paths and, for
 *    each path, walks up to `cwd` collecting `CLAUDE.md` files along the
 *    way; tells the agent to read the unread ones so per-folder rules
 *    are honored.
 *
 * Optimizations:
 *  - Both hooks short-circuit immediately when neither `CLAUDE.md` nor
 *    `.claude/CLAUDE.md` exists in the cwd. Cost in that case is one
 *    `getBootstrapClaudeFiles` call (2 `existsSync`) per session.
 *  - `@`-import expansion is cached by file mtime to avoid re-reading
 *    bootstrap files on every event.
 *  - Files whose content is purely `@`-imports plus whitespace
 *    ("pure alias" stubs) are dropped from the nudge — the agent is
 *    told to read the targets directly instead, skipping a useless
 *    `read` on the alias file itself.
 *
 * Read-tracking is done by appending custom session entries
 * (`claude-md-injector-read` for tool reads, `claude-md-injector-pi-context`
 * for files Pi pre-loaded via `systemPromptOptions.contextFiles`).
 * Lookups consider only entries since the last compaction.
 *
 * Also registers a `/claude-md-injector` slash command that prints
 * status: which `CLAUDE.md` files are applicable, which were read this
 * session, which are pure aliases, and which `@`-linked files they
 * pulled in. Pass a path (`/claude-md-injector src/foo`) to inspect just
 * the files that would apply to that path.
 */

const READ_TRACK_ENTRY = 'claude-md-injector-read';
const PI_CONTEXT_TRACK_ENTRY = 'claude-md-injector-pi-context';

const LINK_DEPTH_LIMIT = 5;
const MAX_TEXT_SCAN = 1_000_000;
const MAX_DISK_CHECKS = 500;

type LinkedInstructionFile = {
    file: string;
    via: string[];
};

type InstructionBreakdown = {
    claudeFiles: string[];
    linkedFiles: LinkedInstructionFile[];
    allFiles: string[];
};

function getLinkedFiles(filePath: string, cwd: string, depth = 0, visited: Set<string> = new Set()): string[] {
    if (depth >= LINK_DEPTH_LIMIT || visited.has(filePath)) return [];
    visited.add(filePath);

    const links: string[] = [];
    try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf8');
        const regex = /@([\w./\\-]+)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            const linkPath = match[1];
            if (!linkPath) continue;

            let target = path.resolve(cwd, linkPath);
            if (!fs.existsSync(target)) {
                target = path.resolve(path.dirname(filePath), linkPath);
            }

            if (fs.existsSync(target) && fs.statSync(target).isFile() && !visited.has(target)) {
                links.push(target);
                links.push(...getLinkedFiles(target, cwd, depth + 1, visited));
            }
        }
    } catch {
        // ignore read errors
    }
    return links;
}

// Cache transitive @-import expansion by (filePath, cwd), invalidated when the
// top file's mtime changes. Tradeoff: if a transitively-linked file changes but
// the top file doesn't, the cache stays stale until the top file is touched or
// the process restarts. CLAUDE.md changes mid-session are vanishingly rare.
const linkedFilesCache = new Map<string, { mtimeMs: number; result: string[] }>();

function getLinkedFilesCached(filePath: string, cwd: string): string[] {
    let mtimeMs: number;
    try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
        return [];
    }

    const key = `${filePath}|${cwd}`;
    const cached = linkedFilesCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) return cached.result;

    const result = getLinkedFiles(filePath, cwd);
    linkedFilesCache.set(key, { mtimeMs, result });
    return result;
}

// Detect a file whose content is only `@`-imports plus whitespace ("pure alias").
// Such files add no information of their own — the nudge skips them and tells
// the agent to read the @-targets directly. Cached by mtime.
const pureAliasCache = new Map<string, { mtimeMs: number; pure: boolean }>();

function isPureAliasFile(filePath: string): boolean {
    let mtimeMs: number;
    try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
        return false;
    }

    const cached = pureAliasCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.pure;

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return false;
    }

    const stripped = content.replace(/@[\w./\\-]+/g, '').trim();
    const pure = stripped.length === 0;
    pureAliasCache.set(filePath, { mtimeMs, pure });
    return pure;
}

function findLastCompaction(entries: any[]): any | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === 'compaction') return entries[i];
    }
    return undefined;
}

function getEntriesSinceLastCompaction(entries: any[]): any[] {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === 'compaction') {
            return entries.slice(i + 1);
        }
    }
    return entries;
}

function normalizePathForCompare(targetPath: string, cwd: string): string {
    return path.resolve(cwd, targetPath).replace(/\\/g, '/').toLowerCase();
}

function matchesRequestedPath(requestedPath: string | undefined, file: string, cwd: string): boolean {
    if (!requestedPath) return false;

    const requestedNormalized = normalizePathForCompare(requestedPath, cwd);
    const fileNormalized = path.resolve(file).replace(/\\/g, '/').toLowerCase();
    const relPath = path.relative(cwd, file).replace(/\\/g, '/').toLowerCase();
    const baseName = path.basename(file).toLowerCase();

    return (
        requestedNormalized === fileNormalized ||
        requestedNormalized === normalizePathForCompare(relPath, cwd) ||
        requestedPath.replace(/\\/g, '/').toLowerCase() === relPath ||
        requestedPath.toLowerCase() === baseName
    );
}

function toolBatchReadIncludesFile(input: any, file: string, cwd: string): boolean {
    const calls = Array.isArray(input?.calls) ? input.calls : [];
    for (const call of calls) {
        const toolName = call?.tool ?? call?.name;
        if (toolName !== 'read') continue;

        const requestedPath = call?.args?.path ?? call?.path ?? call?.arguments?.path;
        if (matchesRequestedPath(requestedPath, file, cwd)) return true;
    }
    return false;
}

function wasFileReadThisSession(entries: any[], file: string, cwd: string): boolean {
    const normalizedFile = path.resolve(file).replace(/\\/g, '/').toLowerCase();
    const relPath = path.relative(cwd, file).replace(/\\/g, '/');
    const absPath = path.resolve(file).replace(/\\/g, '/');
    const baseName = path.basename(file);

    return entries.some((e) => {
        if (e.type === 'custom' && (e.customType === READ_TRACK_ENTRY || e.customType === PI_CONTEXT_TRACK_ENTRY)) {
            const trackedPath = typeof e.data?.path === 'string' ? e.data.path.replace(/\\/g, '/').toLowerCase() : '';
            return trackedPath === normalizedFile;
        }

        if (e.type !== 'message' || e.message?.role !== 'toolResult') return false;

        if (e.message.toolName === 'read') {
            const inputStr = (() => {
                try { return JSON.stringify(e.message.input || {}); } catch { return ''; }
            })();
            return inputStr.includes(relPath) || inputStr.includes(absPath) || inputStr.includes(baseName);
        }

        if (e.message.toolName === 'tool_batch') {
            return toolBatchReadIncludesFile(e.message.input, file, cwd);
        }

        return false;
    });
}

function collectPiContextPaths(contextFiles: Array<{ path: string; content?: string }> | undefined): string[] {
    const paths = new Set<string>();
    for (const file of contextFiles ?? []) {
        if (typeof file?.path === 'string' && file.path.length > 0) {
            paths.add(path.resolve(file.path).replace(/\\/g, '/'));
        }
    }
    return Array.from(paths);
}

function collectReadPathsFromToolInput(toolName: string | undefined, input: any, cwd: string): string[] {
    const readPaths = new Set<string>();

    if (toolName === 'read') {
        const requestedPath = input?.path;
        if (typeof requestedPath === 'string') {
            readPaths.add(path.resolve(cwd, requestedPath).replace(/\\/g, '/'));
        }
    }

    if (toolName === 'tool_batch') {
        const calls = Array.isArray(input?.calls) ? input.calls : [];
        for (const call of calls) {
            const nestedTool = call?.tool ?? call?.name;
            if (nestedTool !== 'read') continue;
            const requestedPath = call?.args?.path ?? call?.path ?? call?.arguments?.path;
            if (typeof requestedPath === 'string') {
                readPaths.add(path.resolve(cwd, requestedPath).replace(/\\/g, '/'));
            }
        }
    }

    return Array.from(readPaths);
}

function getBootstrapClaudeFiles(cwd: string): string[] {
    const candidates = [path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')];
    return candidates.filter((file, index, array) => fs.existsSync(file) && array.indexOf(file) === index);
}

function getTextToScanFromToolResultMessage(message: any): string {
    let textToScan = '';

    if (message?.input) {
        try {
            textToScan += JSON.stringify(message.input) + '\n';
        } catch {
            // ignore circular references
        }
    }

    const content = message?.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block?.type === 'text' && block?.text) {
                textToScan += block.text + '\n';
            }
        }
    } else if (typeof content === 'string') {
        textToScan += content + '\n';
    }

    if (textToScan.length > MAX_TEXT_SCAN) {
        textToScan = textToScan.slice(0, MAX_TEXT_SCAN);
    }

    return textToScan;
}

function extractPotentialPaths(textToScan: string): string[] {
    const potentialPaths = new Set<string>();
    const tokens = textToScan.split(/[\s'"\[\]{}()<>:;,|*]+/);

    for (const token of tokens) {
        if (!token || token.length < 3) continue;
        if (token.includes('/') || token.includes('\\') || /\.[a-zA-Z0-9]{2,5}$/.test(token)) {
            potentialPaths.add(token);
        }
    }

    return Array.from(potentialPaths);
}

function buildInstructionBreakdown(claudeFiles: string[], cwd: string): InstructionBreakdown {
    const directClaudeFiles = Array.from(new Set(claudeFiles)).sort();
    const linkedFileSources = new Map<string, Set<string>>();

    for (const md of directClaudeFiles) {
        for (const link of getLinkedFilesCached(md, cwd)) {
            if (directClaudeFiles.includes(link)) continue;
            const sources = linkedFileSources.get(link) ?? new Set<string>();
            sources.add(md);
            linkedFileSources.set(link, sources);
        }
    }

    const linkedFiles = Array.from(linkedFileSources.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, via]) => ({ file, via: Array.from(via).sort() }));

    return {
        claudeFiles: directClaudeFiles,
        linkedFiles,
        allFiles: [...directClaudeFiles, ...linkedFiles.map((entry) => entry.file)],
    };
}

function buildInstructionBreakdownForPath(targetPath: string, cwd: string): InstructionBreakdown {
    const applicableClaudeMds = new Set<string>();
    const normalizedRoot = path.resolve(cwd).toLowerCase();
    const bootstrapFiles = new Set(getBootstrapClaudeFiles(cwd).map((file) => path.resolve(file).toLowerCase()));

    try {
        const resolved = path.resolve(cwd, targetPath);
        const resolvedLower = resolved.toLowerCase();
        if (!resolvedLower.startsWith(normalizedRoot)) return { claudeFiles: [], linkedFiles: [], allFiles: [] };
        if (!fs.existsSync(resolved)) return { claudeFiles: [], linkedFiles: [], allFiles: [] };

        let current = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
        while (true) {
            const currentLower = current.toLowerCase();
            if (!currentLower.startsWith(normalizedRoot)) break;

            const claudePath = path.join(current, 'CLAUDE.md');
            if (fs.existsSync(claudePath) && !bootstrapFiles.has(path.resolve(claudePath).toLowerCase())) {
                applicableClaudeMds.add(claudePath);
            }

            if (currentLower === normalizedRoot) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    } catch {
        // ignore invalid paths
    }

    return buildInstructionBreakdown(Array.from(applicableClaudeMds), cwd);
}

function subtractInstructionBreakdown(source: InstructionBreakdown, exclude: InstructionBreakdown): InstructionBreakdown {
    const excludedFiles = new Set(exclude.allFiles.map((file) => file.toLowerCase()));
    const claudeFiles = source.claudeFiles.filter((file) => !excludedFiles.has(file.toLowerCase()));
    const linkedFiles = source.linkedFiles.filter((entry) => !excludedFiles.has(entry.file.toLowerCase()));

    return {
        claudeFiles,
        linkedFiles,
        allFiles: [...claudeFiles, ...linkedFiles.map((entry) => entry.file)],
    };
}

function mergeInstructionBreakdowns(...breakdowns: InstructionBreakdown[]): InstructionBreakdown {
    const claudeFiles = new Set<string>();
    const linkedMap = new Map<string, Set<string>>();

    for (const breakdown of breakdowns) {
        for (const file of breakdown.claudeFiles) {
            claudeFiles.add(file);
        }
        for (const entry of breakdown.linkedFiles) {
            const sources = linkedMap.get(entry.file) ?? new Set<string>();
            for (const via of entry.via) sources.add(via);
            linkedMap.set(entry.file, sources);
        }
    }

    return {
        claudeFiles: Array.from(claudeFiles).sort(),
        linkedFiles: Array.from(linkedMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([file, via]) => ({ file, via: Array.from(via).sort() })),
        allFiles: [
            ...Array.from(claudeFiles).sort(),
            ...Array.from(linkedMap.keys()).sort(),
        ],
    };
}

function collectObservedPathScopedBreakdown(entries: any[], cwd: string): InstructionBreakdown {
    const observedClaudeFiles = new Set<string>();

    for (const entry of entries) {
        if (entry?.type !== 'message' || entry?.message?.role !== 'toolResult') continue;

        const textToScan = getTextToScanFromToolResultMessage(entry.message);
        for (const targetPath of extractPotentialPaths(textToScan)) {
            const breakdown = buildInstructionBreakdownForPath(targetPath, cwd);
            for (const file of breakdown.claudeFiles) {
                observedClaudeFiles.add(file);
            }
        }
    }

    return buildInstructionBreakdown(Array.from(observedClaudeFiles), cwd);
}

function formatStatusLine(file: string, cwd: string, entries: any[]): string {
    const relPath = path.relative(cwd, file).replace(/\\/g, '/');
    const status = wasFileReadThisSession(entries, file, cwd) ? 'read' : 'unread';
    const aliasTag = isPureAliasFile(file) ? ' (alias)' : '';
    return `- [${status}] ${relPath}${aliasTag}`;
}

function formatStatusReport(args: string, ctx: ExtensionCommandContext): string {
    const cwd = ctx.cwd;
    const branchEntries = ctx.sessionManager.getBranch();
    const entriesSinceCompaction = getEntriesSinceLastCompaction(branchEntries);
    const lastCompaction = findLastCompaction(branchEntries);

    const bootstrapClaudeFiles = getBootstrapClaudeFiles(cwd);
    const rootBreakdown: InstructionBreakdown = bootstrapClaudeFiles.length > 0
        ? buildInstructionBreakdown(bootstrapClaudeFiles, cwd)
        : { claudeFiles: [], linkedFiles: [], allFiles: [] };
    const observedPathScopedBreakdown = subtractInstructionBreakdown(
        collectObservedPathScopedBreakdown(entriesSinceCompaction, cwd),
        rootBreakdown,
    );
    const combinedBreakdown = mergeInstructionBreakdowns(rootBreakdown, observedPathScopedBreakdown);

    const targetArg = args.trim();
    const pathScopedBreakdown: InstructionBreakdown = targetArg
        ? buildInstructionBreakdownForPath(targetArg, cwd)
        : { claudeFiles: [], linkedFiles: [], allFiles: [] };

    const lines: string[] = [];
    lines.push('# CLAUDE.md Injector Status');
    lines.push('');
    lines.push(`- cwd: ${cwd.replace(/\\/g, '/')}`);
    if (lastCompaction) {
        lines.push(`- last compaction: ${lastCompaction.timestamp ?? 'unknown'} (${lastCompaction.id ?? 'no-id'})`);
    } else {
        lines.push('- last compaction: none in current branch');
    }
    lines.push(`- entries since last compaction: ${entriesSinceCompaction.length}`);

    lines.push('');
    lines.push('## CLAUDE.md files');
    if (combinedBreakdown.claudeFiles.length === 0) {
        lines.push('- none');
    } else {
        for (const file of combinedBreakdown.claudeFiles) {
            lines.push(formatStatusLine(file, cwd, entriesSinceCompaction));
        }
    }

    lines.push('');
    lines.push('## links');
    if (combinedBreakdown.linkedFiles.length === 0) {
        lines.push('- none');
    } else {
        for (const entry of combinedBreakdown.linkedFiles) {
            const via = entry.via.map((file) => path.relative(cwd, file).replace(/\\/g, '/')).join(', ');
            lines.push(`${formatStatusLine(entry.file, cwd, entriesSinceCompaction)} <- ${via}`);
        }
    }

    if (targetArg) {
        lines.push('');
        lines.push(`## For path: ${targetArg.replace(/\\/g, '/')}`);
        lines.push('### CLAUDE.md files');
        if (pathScopedBreakdown.claudeFiles.length === 0) {
            lines.push('- none');
        } else {
            for (const file of pathScopedBreakdown.claudeFiles) {
                lines.push(formatStatusLine(file, cwd, entriesSinceCompaction));
            }
        }
        lines.push('');
        lines.push('### links');
        if (pathScopedBreakdown.linkedFiles.length === 0) {
            lines.push('- none');
        } else {
            for (const entry of pathScopedBreakdown.linkedFiles) {
                const via = entry.via.map((file) => path.relative(cwd, file).replace(/\\/g, '/')).join(', ');
                lines.push(`${formatStatusLine(entry.file, cwd, entriesSinceCompaction)} <- ${via}`);
            }
        }
    } else {
        lines.push('');
        lines.push('Tip: run `/claude-md-injector path/to/file` to inspect path-specific files.');
    }

    return lines.join('\n');
}

export function createClaudeMdInjectorExtension(): (pi: ExtensionAPI) => void {
    return (pi) => {
        // Per-extension-instance cache. cwd is fixed for the lifetime of a chat
        // session, so a single slot suffices. When the list is empty the project
        // doesn't follow CLAUDE.md conventions and both hooks bail out fast.
        // Limitation: a CLAUDE.md added mid-session is picked up only after the
        // chat is restarted.
        let cachedCwd: string | null = null;
        let cachedBootstrapFiles: string[] = [];

        function getCachedBootstrapClaudeFiles(cwd: string): string[] {
            if (cwd === cachedCwd) return cachedBootstrapFiles;
            cachedCwd = cwd;
            cachedBootstrapFiles = getBootstrapClaudeFiles(cwd);
            return cachedBootstrapFiles;
        }

        pi.registerCommand('claude-md-injector', {
            description: 'Show CLAUDE.md injector status for this session',
            handler: async (args, ctx) => {
                const content = formatStatusReport(args, ctx);
                pi.sendMessage(
                    {
                        customType: 'claude-md-injector-status',
                        content,
                        display: true,
                    },
                    { triggerTurn: false },
                );
            },
        });

        pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
            const bootstrapClaudeFiles = getCachedBootstrapClaudeFiles(ctx.cwd);
            if (bootstrapClaudeFiles.length === 0) return;

            for (const contextPath of collectPiContextPaths(event.systemPromptOptions?.contextFiles)) {
                pi.appendEntry(PI_CONTEXT_TRACK_ENTRY, { path: contextPath });
            }

            const toRead = new Set<string>(bootstrapClaudeFiles);
            for (const claudePath of bootstrapClaudeFiles) {
                for (const link of getLinkedFilesCached(claudePath, ctx.cwd)) {
                    toRead.add(link);
                }
            }

            const entries = getEntriesSinceLastCompaction(ctx.sessionManager.getBranch());
            const unread = new Set<string>();

            for (const file of toRead) {
                // Pure-alias files (content is only @-imports) add nothing beyond
                // their targets, which are already in `toRead` via transitive
                // expansion. Skipping saves a redundant `read` and trims the nudge.
                if (isPureAliasFile(file)) continue;
                if (wasFileReadThisSession(entries, file, ctx.cwd)) continue;
                const relPath = path.relative(ctx.cwd, file).replace(/\\/g, '/');
                unread.add(relPath);
            }

            if (unread.size > 0) {
                const filesList = Array.from(unread).sort().map((f) => `- ${f}`).join('\n');
                return {
                    systemPrompt:
                        event.systemPrompt +
                        `\n\nCRITICAL: You MUST read the following instruction files immediately before proceeding with the user's request:\n${filesList}`,
                };
            }
            return;
        });

        pi.on('tool_result', async (event: ToolResultEvent, ctx: ExtensionContext) => {
            if (getCachedBootstrapClaudeFiles(ctx.cwd).length === 0) return;

            for (const readPath of collectReadPathsFromToolInput(event.toolName, event.input, ctx.cwd)) {
                pi.appendEntry(READ_TRACK_ENTRY, { path: readPath });
            }

            const textToScan = getTextToScanFromToolResultMessage(event);
            const potentialPaths = extractPotentialPaths(textToScan);

            const cwd = ctx.cwd;
            const normalizedRoot = path.resolve(cwd).toLowerCase();
            const existsCache = new Map<string, boolean>();
            const isDirCache = new Map<string, boolean>();
            const applicableClaudeMds = new Set<string>();
            let diskChecks = 0;

            for (const p of potentialPaths) {
                if (diskChecks >= MAX_DISK_CHECKS) break;

                try {
                    const resolved = path.resolve(cwd, p);
                    const resolvedLower = resolved.toLowerCase();
                    if (!resolvedLower.startsWith(normalizedRoot)) continue;

                    const cleanResolved = resolved.replace(/[/\\]+$/, '');
                    if (!existsCache.has(cleanResolved)) {
                        diskChecks++;
                        existsCache.set(cleanResolved, fs.existsSync(cleanResolved));
                    }

                    if (!existsCache.get(cleanResolved)) continue;

                    if (!isDirCache.has(cleanResolved)) {
                        isDirCache.set(cleanResolved, fs.statSync(cleanResolved).isDirectory());
                    }

                    let current = isDirCache.get(cleanResolved) ? cleanResolved : path.dirname(cleanResolved);
                    while (true) {
                        const currentLower = current.toLowerCase();
                        if (!currentLower.startsWith(normalizedRoot)) break;

                        const claudePath = path.join(current, 'CLAUDE.md');
                        if (!existsCache.has(claudePath)) {
                            diskChecks++;
                            existsCache.set(claudePath, fs.existsSync(claudePath));
                        }

                        if (existsCache.get(claudePath)) {
                            applicableClaudeMds.add(claudePath);
                        }

                        if (currentLower === normalizedRoot) break;
                        const parent = path.dirname(current);
                        if (parent === current) break;
                        current = parent;
                    }
                } catch {
                    // ignore invalid paths
                }
            }

            if (applicableClaudeMds.size === 0) return;

            const allToRead = new Set<string>();
            for (const md of applicableClaudeMds) {
                allToRead.add(md);
                for (const link of getLinkedFilesCached(md, cwd)) {
                    allToRead.add(link);
                }
            }

            const entries = getEntriesSinceLastCompaction(ctx.sessionManager.getBranch());
            const unreadToRead = Array.from(allToRead)
                .filter((file) => !isPureAliasFile(file) && !wasFileReadThisSession(entries, file, cwd))
                .sort();

            if (unreadToRead.length === 0) return;

            const newContent = Array.isArray(event.content)
                ? [...event.content]
                : [{ type: 'text' as const, text: String(event.content) }];

            let appendText = '\n\n---\n**[Extension: CLAUDE.md Injector]**\n';
            appendText += 'CRITICAL: The following instruction files are applicable to the paths you just interacted with and are still unread in this session:\n';
            for (const md of unreadToRead) {
                const relPath = path.relative(cwd, md).replace(/\\/g, '/');
                appendText += `- ${relPath}\n`;
            }
            appendText += '\nYOU MUST READ THESE FILES IMMEDIATELY using the `read` tool.';

            newContent.push({ type: 'text' as const, text: appendText });
            return { content: newContent };
        });
    };
}
