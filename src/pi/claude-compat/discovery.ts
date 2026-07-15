import * as path from 'node:path';

/**
 * Generated dependency/build directories must not contribute project-scoped
 * Claude infrastructure. Other ignored source directories remain discoverable
 * unless they match a generic generated-output category.
 */
const EXCLUDED_DIRECTORY_NAMES = new Set([
    '.git',
    '.vs',
    'bin',
    'build',
    'dist',
    'library',
    'logs',
    'node_modules',
    'obj',
    'out',
    'temp',
]);

export const CLAUDE_NESTED_SEARCH_EXCLUDE =
    '{**/.git/**,**/.vs/**,**/bin/**,**/build/**,**/dist/**,**/Library/**,**/Logs/**,**/node_modules/**,**/obj/**,**/out/**,**/Temp/**}';

export function isExcludedClaudeDiscoveryPath(cwd: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(cwd), path.resolve(candidate));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    return relative.split(path.sep).some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()));
}
