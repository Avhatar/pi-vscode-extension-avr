import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Minimatch } from 'minimatch';

export interface ClaudeSettingsDiagnostic {
    path: string;
    message: string;
}

export interface ClaudeExcludes {
    patterns: string[];
    diagnostics: ClaudeSettingsDiagnostic[];
}

function managedSettingsPath(): string {
    if (process.platform === 'win32') {
        return path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
    }
    if (process.platform === 'darwin') {
        return '/Library/Application Support/ClaudeCode/managed-settings.json';
    }
    return '/etc/claude-code/managed-settings.json';
}

function normalizeGlob(pattern: string, cwd: string): string {
    const expanded = pattern.startsWith('~/') || pattern.startsWith('~\\')
        ? path.join(os.homedir(), pattern.slice(2))
        : pattern;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    return absolute.replace(/\\/g, '/');
}

export function loadClaudeMdExcludes(cwd: string, userClaudeDirectory: string): ClaudeExcludes {
    const settingsFiles = [
        path.join(userClaudeDirectory, 'settings.json'),
        path.join(cwd, '.claude', 'settings.json'),
        path.join(cwd, '.claude', 'settings.local.json'),
        managedSettingsPath(),
    ];
    const patterns: string[] = [];
    const diagnostics: ClaudeSettingsDiagnostic[] = [];

    for (const settingsPath of settingsFiles) {
        if (!fs.existsSync(settingsPath)) continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { claudeMdExcludes?: unknown };
            if (parsed.claudeMdExcludes === undefined) continue;
            if (!Array.isArray(parsed.claudeMdExcludes) || !parsed.claudeMdExcludes.every((item) => typeof item === 'string')) {
                diagnostics.push({ path: settingsPath, message: 'claudeMdExcludes must be an array of strings.' });
                continue;
            }
            for (const pattern of parsed.claudeMdExcludes) {
                patterns.push(normalizeGlob(pattern, cwd));
            }
        } catch (error) {
            diagnostics.push({ path: settingsPath, message: (error as Error).message });
        }
    }

    return { patterns: Array.from(new Set(patterns)), diagnostics };
}

export function isClaudePathExcluded(filePath: string, excludes: ClaudeExcludes): boolean {
    const absolute = path.resolve(filePath).replace(/\\/g, '/');
    return excludes.patterns.some((pattern) => {
        try {
            return new Minimatch(pattern, {
                dot: true,
                nocase: process.platform === 'win32',
            }).match(absolute);
        } catch {
            return false;
        }
    });
}
