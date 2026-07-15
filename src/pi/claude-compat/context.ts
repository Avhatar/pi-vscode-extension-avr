import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    expandInstructionFiles,
    type ExpandedInstructionFile,
    type ImportDiagnostic,
    type InstructionExpansion,
} from './imports';
import { collectNestedClaudeFiles, normalizePathForCompare } from './path-scope';
import {
    isClaudePathExcluded,
    loadClaudeMdExcludes,
    type ClaudeSettingsDiagnostic,
} from './settings';

export interface ClaudeContextOptions {
    userClaudeDirectory?: string;
}

export interface RenderedInstructions {
    content: string;
    files: ExpandedInstructionFile[];
    diagnostics: ImportDiagnostic[];
    settingsDiagnostics?: ClaudeSettingsDiagnostic[];
}

export function getUserClaudeDirectory(options: ClaudeContextOptions = {}): string {
    return options.userClaudeDirectory ?? path.join(os.homedir(), '.claude');
}

export function getRootClaudeFiles(cwd: string, options: ClaudeContextOptions = {}): string[] {
    const userClaudeDirectory = getUserClaudeDirectory(options);
    const excludes = loadClaudeMdExcludes(cwd, userClaudeDirectory);
    const ancestorDirectories: string[] = [];
    let current = path.resolve(cwd);
    while (true) {
        ancestorDirectories.unshift(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    const candidates = [path.join(userClaudeDirectory, 'CLAUDE.md')];
    for (const directory of ancestorDirectories) {
        candidates.push(path.join(directory, 'CLAUDE.md'));
        if (normalizePathForCompare(directory) === normalizePathForCompare(cwd)) {
            candidates.push(path.join(directory, '.claude', 'CLAUDE.md'));
        }
        candidates.push(path.join(directory, 'CLAUDE.local.md'));
    }
    return candidates.filter((file, index) => {
        if (candidates.findIndex((candidate) => normalizePathForCompare(candidate) === normalizePathForCompare(file)) !== index) {
            return false;
        }
        try {
            return fs.statSync(file).isFile() && !isClaudePathExcluded(file, excludes);
        } catch {
            return false;
        }
    });
}

export function buildRootInstructions(
    cwd: string,
    preloadedPaths: string[] = [],
    options: ClaudeContextOptions = {},
): RenderedInstructions {
    const userClaudeDirectory = getUserClaudeDirectory(options);
    const excludes = loadClaudeMdExcludes(cwd, userClaudeDirectory);
    const expansion = expandInstructionFiles(getRootClaudeFiles(cwd, options), { cwd, userClaudeDirectory });
    return {
        ...renderExpansion(expansion, cwd, new Set(preloadedPaths.map(normalizePathForCompare))),
        settingsDiagnostics: excludes.diagnostics,
    };
}

export function buildPathInstructions(
    cwd: string,
    targetPaths: string[],
    excludedFiles: Set<string> = new Set(),
    options: ClaudeContextOptions = {},
): RenderedInstructions {
    const roots: string[] = [];
    const seen = new Set<string>();
    const userClaudeDirectory = getUserClaudeDirectory(options);
    const excludes = loadClaudeMdExcludes(cwd, userClaudeDirectory);
    for (const targetPath of targetPaths) {
        for (const file of collectNestedClaudeFiles(
            cwd,
            targetPath,
            (candidate) => isClaudePathExcluded(candidate, excludes),
        )) {
            const key = normalizePathForCompare(file);
            if (!seen.has(key)) {
                seen.add(key);
                roots.push(file);
            }
        }
    }

    const expansion = expandInstructionFiles(roots, {
        cwd,
        userClaudeDirectory,
    });
    return {
        ...renderExpansion(expansion, cwd, excludedFiles),
        settingsDiagnostics: excludes.diagnostics,
    };
}

export function renderExpansion(
    expansion: InstructionExpansion,
    cwd: string,
    excludedFiles: Set<string> = new Set(),
): RenderedInstructions {
    const files = expansion.files.filter((file) => !excludedFiles.has(normalizePathForCompare(file.canonicalPath)));
    if (files.length === 0) return { content: '', files, diagnostics: expansion.diagnostics };

    const sections = files.map((file) => {
        const relative = path.relative(cwd, file.path).replace(/\\/g, '/');
        const label = relative.startsWith('..') || path.isAbsolute(relative)
            ? file.path.replace(/\\/g, '/')
            : relative || path.basename(file.path);
        return `## Instruction source: ${label}\n\n${file.content.trim()}`;
    });
    return {
        content: `# Claude project instructions\n\n${sections.join('\n\n---\n\n')}`,
        files,
        diagnostics: expansion.diagnostics,
    };
}
