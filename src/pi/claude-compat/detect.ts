import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isExcludedClaudeDiscoveryPath } from './discovery';
import { isClaudeMdShim } from './shim';
import type {
    ClaudeActivationReason,
    ClaudeInfrastructure,
    ClaudePluginInstall,
} from './types';

interface DetectClaudeInfrastructureOptions {
    /**
     * The VS Code host supplies a bounded workspace search here. Keeping the
     * detector independent of `vscode` makes the filesystem rules cheap to
     * unit-test and reusable outside the extension host.
     */
    findNestedClaudeFiles?: () => Promise<string[]>;
    findNestedClaudeSkillFiles?: () => Promise<string[]>;
    /** Collect nested files even after a cheaper marker already activated the bridge. */
    collectNestedClaudeFiles?: boolean;
    collectNestedClaudeSkillFiles?: boolean;
    installedPluginsPath?: string;
    /**
     * When true (default), a root Claude context file that only redirects at the
     * workspace AGENTS.md is recorded as a shim and does not activate the bridge.
     * Pi already loads AGENTS.md natively; re-injecting it through the compat
     * boundary would be pure duplication. Set false to force activation for
     * every Claude context file, matching the pre-shim-collapse behaviour.
     */
    collapseShimContext?: boolean;
}

interface InstalledPluginEntry {
    scope?: string;
    projectPath?: string;
    installPath?: string;
}

interface InstalledPluginsFile {
    plugins?: Record<string, InstalledPluginEntry[]>;
}

const MARKDOWN_EXTENSION = '.md';

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function directoryContains(
    directory: string,
    predicate: (entry: fs.Dirent, fullPath: string) => boolean,
): boolean {
    if (!fs.existsSync(directory)) return false;

    const pending = [directory];
    const visitedDirectories = new Set<string>();
    while (pending.length > 0) {
        const current = pending.pop()!;
        let entries: fs.Dirent[];
        try {
            const canonical = fs.realpathSync.native(current);
            const key = normalizeForCompare(canonical);
            if (visitedDirectories.has(key)) continue;
            visitedDirectories.add(key);
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            try {
                const stats = fs.statSync(fullPath); // follows Claude-supported symlinks
                if (stats.isDirectory()) {
                    pending.push(fullPath);
                    continue;
                }
                if (stats.isFile() && predicate(entry, fullPath)) return true;
            } catch {
                // Ignore broken links and transient entries.
            }
        }
    }

    return false;
}

function containsMarkdown(directory: string): boolean {
    return directoryContains(directory, (entry) => entry.name.toLowerCase().endsWith(MARKDOWN_EXTENSION));
}

function containsSkill(directory: string): boolean {
    return directoryContains(directory, (entry) => entry.name === 'SKILL.md');
}

function normalizeForCompare(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrDescendant(parentPath: string, targetPath: string): boolean {
    const parent = normalizeForCompare(parentPath);
    const target = normalizeForCompare(targetPath);
    const relative = path.relative(parent, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readProjectPluginInstalls(cwd: string, installedPluginsPath: string): ClaudePluginInstall[] {
    let parsed: InstalledPluginsFile;
    try {
        parsed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8')) as InstalledPluginsFile;
    } catch {
        return [];
    }

    const installs: ClaudePluginInstall[] = [];
    for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (
                entry?.scope !== 'project' ||
                typeof entry.projectPath !== 'string' ||
                typeof entry.installPath !== 'string' ||
                !isSameOrDescendant(entry.projectPath, cwd)
            ) {
                continue;
            }
            installs.push({
                key,
                installPath: path.resolve(entry.installPath),
                projectPath: path.resolve(entry.projectPath),
            });
        }
    }
    return installs;
}

function addReason(reasons: ClaudeActivationReason[], reason: ClaudeActivationReason): void {
    if (!reasons.includes(reason)) reasons.push(reason);
}

export async function detectClaudeInfrastructure(
    cwd: string,
    options: DetectClaudeInfrastructureOptions = {},
): Promise<ClaudeInfrastructure> {
    const workspaceRoot = path.resolve(cwd);
    const dotClaude = path.join(workspaceRoot, '.claude');
    const rootContext = path.join(workspaceRoot, 'CLAUDE.md');
    const rootLocalContext = path.join(workspaceRoot, 'CLAUDE.local.md');
    const dotClaudeContext = path.join(dotClaude, 'CLAUDE.md');
    const skillsDir = path.join(dotClaude, 'skills');
    const commandsDir = path.join(dotClaude, 'commands');
    const agentsDir = path.join(dotClaude, 'agents');
    const rulesDir = path.join(dotClaude, 'rules');
    const pluginManifest = path.join(workspaceRoot, '.claude-plugin', 'plugin.json');

    const activationReasons: ClaudeActivationReason[] = [];
    const rootContextFiles: string[] = [];
    const shimContextFiles: string[] = [];
    const nestedContextFiles: string[] = [];
    const nestedSkillFiles: string[] = [];
    const skillDirectories: string[] = [];
    const commandDirectories: string[] = [];
    const agentDirectories: string[] = [];
    const ruleDirectories: string[] = [];
    const collapseShimContext = options.collapseShimContext ?? true;

    const recordRootContext = (filePath: string, reason: ClaudeActivationReason): void => {
        if (!isFile(filePath)) return;
        if (collapseShimContext && isClaudeMdShim(filePath, workspaceRoot)) {
            shimContextFiles.push(filePath);
            return;
        }
        rootContextFiles.push(filePath);
        addReason(activationReasons, reason);
    };

    recordRootContext(rootContext, 'root-context');
    recordRootContext(rootLocalContext, 'root-local-context');
    recordRootContext(dotClaudeContext, 'dot-claude-context');
    if (containsSkill(skillsDir)) {
        skillDirectories.push(skillsDir);
        addReason(activationReasons, 'project-skills');
    }
    if (containsMarkdown(commandsDir)) {
        commandDirectories.push(commandsDir);
        addReason(activationReasons, 'project-commands');
    }
    if (containsMarkdown(agentsDir)) {
        agentDirectories.push(agentsDir);
        addReason(activationReasons, 'project-agents');
    }
    if (containsMarkdown(rulesDir)) {
        ruleDirectories.push(rulesDir);
        addReason(activationReasons, 'project-rules');
    }
    if (isFile(pluginManifest)) {
        addReason(activationReasons, 'plugin-manifest');
    }

    const installedPluginsPath = options.installedPluginsPath
        ?? path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const pluginInstalls = readProjectPluginInstalls(workspaceRoot, installedPluginsPath);
    if (pluginInstalls.length > 0) {
        addReason(activationReasons, 'project-plugin');
    }

    // A workspace search is the only broad operation and is deferred until the
    // cheap direct markers found nothing. The host caps it at one result.
    if ((activationReasons.length === 0 || options.collectNestedClaudeFiles) && options.findNestedClaudeFiles) {
        let candidates: string[] = [];
        try {
            candidates = await options.findNestedClaudeFiles();
        } catch {
            candidates = [];
        }

        const bootstrapPaths = new Set(rootContextFiles.map((file) => normalizeForCompare(file)));
        for (const candidate of candidates) {
            const resolved = path.resolve(candidate);
            if (!isSameOrDescendant(workspaceRoot, resolved)) continue;
            if (isExcludedClaudeDiscoveryPath(workspaceRoot, resolved)) continue;
            if (bootstrapPaths.has(normalizeForCompare(resolved))) continue;
            if (!isFile(resolved)) continue;
            nestedContextFiles.push(resolved);
        }
        if (nestedContextFiles.length > 0) {
            addReason(activationReasons, 'nested-context');
        }
    }

    if ((activationReasons.length === 0 || options.collectNestedClaudeSkillFiles) && options.findNestedClaudeSkillFiles) {
        let candidates: string[] = [];
        try {
            candidates = await options.findNestedClaudeSkillFiles();
        } catch {
            candidates = [];
        }
        const rootSkills = normalizeForCompare(skillsDir);
        const seen = new Set<string>();
        for (const candidate of candidates) {
            const resolved = path.resolve(candidate);
            if (!isSameOrDescendant(workspaceRoot, resolved) || !isFile(resolved)) continue;
            if (isExcludedClaudeDiscoveryPath(workspaceRoot, resolved)) continue;
            if (isSameOrDescendant(rootSkills, resolved)) continue;
            const key = normalizeForCompare(resolved);
            if (seen.has(key)) continue;
            seen.add(key);
            nestedSkillFiles.push(resolved);
        }
        if (nestedSkillFiles.length > 0) addReason(activationReasons, 'nested-skills');
    }

    return {
        active: activationReasons.length > 0,
        activationReasons,
        rootContextFiles,
        shimContextFiles,
        nestedContextFiles,
        nestedSkillFiles,
        skillDirectories,
        commandDirectories,
        agentDirectories,
        ruleDirectories,
        pluginInstalls,
    };
}
