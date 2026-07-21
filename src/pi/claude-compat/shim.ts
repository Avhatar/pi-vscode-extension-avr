import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    extractClaudeImportReferences,
    maskNonImportMarkdown,
    stripClaudeHtmlComments,
} from './markdown';
import { normalizePathForCompare } from './path-scope';

const IMPORT_TOKEN_PATTERN = /(?:^|[\s(])@([^\s`<>"'(){}\[\],;]+)/gm;

function findWorkspaceAgentsFile(workspaceRoot: string): string | undefined {
    const candidate = path.join(workspaceRoot, 'AGENTS.md');
    try {
        if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
        // Missing AGENTS.md means there's nothing for the shim to alias.
    }
    return undefined;
}

/**
 * A shim Claude context file exists only to redirect Claude Code at AGENTS.md,
 * which Pi already loads natively. Detecting this avoids re-injecting AGENTS.md
 * through the compatibility bridge — pure duplication in Pi Code sessions.
 */
export function isClaudeMdShim(filePath: string, workspaceRoot: string): boolean {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return false;
    }

    const stripped = stripClaudeHtmlComments(raw);
    const references = extractClaudeImportReferences(stripped);
    if (references.length === 0) return false;

    const agentsFile = findWorkspaceAgentsFile(workspaceRoot);
    if (!agentsFile) return false;
    const expected = normalizePathForCompare(agentsFile);
    const sourceDir = path.dirname(filePath);
    for (const reference of references) {
        const resolved = path.resolve(sourceDir, reference);
        if (normalizePathForCompare(resolved) !== expected) return false;
    }

    const withoutImports = maskNonImportMarkdown(stripped).replace(
        IMPORT_TOKEN_PATTERN,
        (match) => ' '.repeat(match.length),
    );
    return !/\S/.test(withoutImports);
}
