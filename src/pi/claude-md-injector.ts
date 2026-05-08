import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_DISK_CHECKS = 500;
const MAX_TEXT_SCAN = 1_000_000;
const LINK_DEPTH_LIMIT = 5;

function getLinkedFiles(filePath: string, cwd: string, depth = 0, visited: Set<string> = new Set()): string[] {
    if (depth >= LINK_DEPTH_LIMIT || visited.has(filePath)) return [];
    visited.add(filePath);

    const links: string[] = [];
    try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf8');
        const regex = /@([\w./\\-]+)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const linkPath = match[1];
            if (!linkPath) continue;

            let target = path.resolve(cwd, linkPath);
            if (!fs.existsSync(target)) {
                target = path.resolve(path.dirname(filePath), linkPath);
            }

            if (fs.existsSync(target) && fs.statSync(target).isFile()) {
                if (!visited.has(target)) {
                    links.push(target);
                    links.push(...getLinkedFiles(target, cwd, depth + 1, visited));
                }
            }
        }
    } catch {
        // ignore read errors
    }
    return links;
}

/**
 * Inline Pi extension that mirrors Claude Code's behavior of auto-loading
 * `.claude/CLAUDE.md` and any nested `CLAUDE.md` files into the agent's context.
 *
 * Hooks:
 *  - `before_agent_start` — once per user prompt, instruct the agent to read
 *    `<cwd>/.claude/CLAUDE.md` and any files it `@`-imports (depth ≤ 5).
 *  - `tool_result` — scans tool input / output for repo paths and, for each path,
 *    walks up to `cwd` collecting any `CLAUDE.md` files along the way; tells the
 *    agent to read them so per-folder rules are honored.
 *
 * Cost when the project has no `.claude/CLAUDE.md` (i.e. user is not following
 * Claude Code conventions): exactly **one `fs.existsSync` per session-start cwd**.
 * Both hooks short-circuit immediately after that single check, no scanning,
 * no token bloat.
 */
export function createClaudeMdInjectorExtension(): (pi: ExtensionAPI) => void {
    return (pi) => {
        // Cache: per-cwd, does `.claude/CLAUDE.md` exist? Re-checked when cwd changes
        // (e.g. user opens a different workspace). For a non-Claude project both
        // hooks return immediately after the cached check.
        let cachedCwd: string | null = null;
        let cwdHasClaudeMd = false;

        function projectUsesClaudeMd(cwd: string): boolean {
            if (cwd === cachedCwd) return cwdHasClaudeMd;
            cachedCwd = cwd;
            cwdHasClaudeMd = fs.existsSync(path.join(cwd, '.claude', 'CLAUDE.md'));
            return cwdHasClaudeMd;
        }

        pi.on('before_agent_start', async (event: any, ctx: any) => {
            if (!projectUsesClaudeMd(ctx.cwd)) return;

            const claudePath = path.join(ctx.cwd, '.claude', 'CLAUDE.md');
            const toRead = new Set<string>([claudePath]);
            for (const link of getLinkedFiles(claudePath, ctx.cwd)) {
                toRead.add(link);
            }

            const entries = ctx.sessionManager.getEntries();
            const unread = new Set<string>();

            for (const file of toRead) {
                const relPath = path.relative(ctx.cwd, file).replace(/\\/g, '/');
                const wasRead = entries.some((e: any) => {
                    if (e.type !== 'message' || e.message.role !== 'toolResult') return false;
                    if (e.message.toolName !== 'read') return false;
                    const inputStr = JSON.stringify(e.message.input || {}) || '';
                    return inputStr.includes(relPath) || inputStr.includes(path.basename(file));
                });
                if (!wasRead) {
                    unread.add(relPath);
                }
            }

            if (unread.size > 0) {
                const filesList = Array.from(unread).map((f) => `- ${f}`).join('\n');
                return {
                    systemPrompt: event.systemPrompt + `\n\nCRITICAL: You MUST read the following instruction files immediately before proceeding with the user's request:\n${filesList}`,
                };
            }
        });

        pi.on('tool_result', async (event: any, ctx: any) => {
            if (!projectUsesClaudeMd(ctx.cwd)) return;

            let textToScan = '';
            if (event.input) {
                try { textToScan += JSON.stringify(event.input) + '\n'; } catch { /* circular */ }
            }
            if (Array.isArray(event.content)) {
                for (const block of event.content) {
                    if (block.type === 'text' && block.text) {
                        textToScan += block.text + '\n';
                    }
                }
            } else if (typeof event.content === 'string') {
                textToScan += event.content + '\n';
            }

            if (textToScan.length > MAX_TEXT_SCAN) {
                textToScan = textToScan.slice(0, MAX_TEXT_SCAN);
            }

            const potentialPaths = new Set<string>();
            const tokens = textToScan.split(/[\s'"\[\]{}()<>:;,|*]+/);
            for (const token of tokens) {
                if (!token || token.length < 3) continue;
                if (token.includes('/') || token.includes('\\') || /\.[a-zA-Z0-9]{2,5}$/.test(token)) {
                    potentialPaths.add(token);
                }
            }

            const cwd = ctx.cwd;
            const normalizedRoot = path.resolve(cwd).toLowerCase();

            const existsCache = new Map<string, boolean>();
            const isDirCache = new Map<string, boolean>();
            let diskChecks = 0;
            const applicableClaudeMds = new Set<string>();

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

                    if (existsCache.get(cleanResolved)) {
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
                    }
                } catch {
                    // ignore invalid paths
                }
            }

            if (applicableClaudeMds.size === 0) return;

            const allToRead = new Set<string>();
            for (const md of applicableClaudeMds) {
                allToRead.add(md);
                for (const link of getLinkedFiles(md, cwd)) {
                    allToRead.add(link);
                }
            }

            const newContent = Array.isArray(event.content)
                ? [...event.content]
                : [{ type: 'text', text: String(event.content) }];

            const sortedMds = Array.from(allToRead).sort();
            let appendText = '\n\n---\n**[Extension: CLAUDE.md Injector]**\nCRITICAL: The following instruction files are applicable to the paths you just interacted with:\n';
            for (const md of sortedMds) {
                const relPath = path.relative(cwd, md).replace(/\\/g, '/');
                appendText += `- ${relPath}\n`;
            }
            appendText += '\nYOU MUST READ THESE FILES IMMEDIATELY using the `read` tool if you haven\'t already read them in the current session. They contain mandatory rules and context for this repository.';

            newContent.push({ type: 'text', text: appendText });

            return { content: newContent };
        });
    };
}
