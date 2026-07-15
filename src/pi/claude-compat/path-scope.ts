import * as fs from 'node:fs';
import * as path from 'node:path';

export function normalizePathForCompare(filePath: string): string {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isSameOrDescendant(rootPath: string, targetPath: string): boolean {
    const root = path.resolve(rootPath);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function canonicalPath(filePath: string): string {
    try {
        return fs.realpathSync.native(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

export function isCanonicalDescendant(rootPath: string, targetPath: string): boolean {
    return isSameOrDescendant(canonicalPath(rootPath), canonicalPath(targetPath));
}

/** Collect nested CLAUDE.md and CLAUDE.local.md files from general to specific. */
export function collectNestedClaudeFiles(
    cwd: string,
    targetPath: string,
    isExcluded: (filePath: string) => boolean = () => false,
): string[] {
    const root = path.resolve(cwd);
    const resolved = path.resolve(cwd, targetPath);
    if (!isSameOrDescendant(root, resolved)) return [];

    try {
        if (fs.existsSync(resolved) && !isCanonicalDescendant(root, resolved)) return [];
    } catch {
        return [];
    }

    let targetDirectory = resolved;
    try {
        if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
            targetDirectory = path.dirname(resolved);
        } else if (!fs.existsSync(resolved) && path.extname(resolved)) {
            targetDirectory = path.dirname(resolved);
        }
    } catch {
        return [];
    }

    const directories: string[] = [];
    let current = targetDirectory;
    while (isSameOrDescendant(root, current)) {
        directories.push(current);
        if (path.resolve(current) === root) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    directories.reverse();

    const bootstrapFiles = new Set([
        path.join(root, 'CLAUDE.md'),
        path.join(root, 'CLAUDE.local.md'),
    ].map(normalizePathForCompare));
    return directories
        .flatMap((directory) => [
            path.join(directory, 'CLAUDE.md'),
            path.join(directory, 'CLAUDE.local.md'),
        ])
        .filter((file) => !bootstrapFiles.has(normalizePathForCompare(file)))
        .filter((file) => !isExcluded(file))
        .filter((file) => {
            try {
                return fs.statSync(file).isFile() && isCanonicalDescendant(root, file);
            } catch {
                return false;
            }
        });
}
