import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractClaudeImportReferences, stripClaudeHtmlComments } from './markdown';
import { canonicalPath, isCanonicalDescendant, normalizePathForCompare } from './path-scope';

/** Claude Code allows four recursive import hops beyond the root file. */
export const CLAUDE_IMPORT_DEPTH_LIMIT = 4;

export interface ExpandedInstructionFile {
    path: string;
    canonicalPath: string;
    content: string;
    depth: number;
    importedBy?: string;
    fingerprint: string;
}

export interface ImportDiagnostic {
    kind: 'missing' | 'outside-root' | 'cycle' | 'depth-limit' | 'read-error';
    source: string;
    reference?: string;
    target?: string;
}

export interface InstructionExpansion {
    files: ExpandedInstructionFile[];
    diagnostics: ImportDiagnostic[];
}

export interface ExpandInstructionOptions {
    cwd: string;
    userClaudeDirectory?: string;
    depthLimit?: number;
}

interface FileStamp {
    path: string;
    exists: boolean;
    mtimeMs?: number;
    size?: number;
}

interface CachedExpansion {
    stamps: FileStamp[];
    result: InstructionExpansion;
}

const expansionCache = new Map<string, CachedExpansion>();

function stamp(filePath: string): FileStamp {
    try {
        const stats = fs.statSync(filePath);
        return { path: filePath, exists: true, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
        return { path: filePath, exists: false };
    }
}

function stampsStillValid(stamps: FileStamp[]): boolean {
    return stamps.every((previous) => {
        const current = stamp(previous.path);
        return current.exists === previous.exists && current.mtimeMs === previous.mtimeMs && current.size === previous.size;
    });
}

function cloneExpansion(result: InstructionExpansion): InstructionExpansion {
    return {
        files: result.files.map((file) => ({ ...file })),
        diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
}

function fingerprint(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function allowedRootFor(sourceFile: string, options: ExpandInstructionOptions): string {
    const userRoot = options.userClaudeDirectory;
    if (userRoot && isCanonicalDescendant(userRoot, sourceFile)) return userRoot;
    return options.cwd;
}

function resolveImport(
    reference: string,
    sourceFile: string,
    options: ExpandInstructionOptions,
    stamps: Map<string, FileStamp>,
): { target?: string; diagnostic?: ImportDiagnostic } {
    const allowedRoot = allowedRootFor(sourceFile, options);
    const expandedReference = reference.startsWith('~/') || reference.startsWith('~\\')
        ? path.join(os.homedir(), reference.slice(2))
        : reference;
    const candidate = path.isAbsolute(expandedReference)
        ? expandedReference
        : path.resolve(path.dirname(sourceFile), expandedReference);
    const uniqueCandidates = [path.resolve(candidate)];
    let outsideTarget: string | undefined;
    for (const candidate of uniqueCandidates) {
        const currentStamp = stamp(candidate);
        stamps.set(normalizePathForCompare(candidate), currentStamp);
        if (!currentStamp.exists) continue;
        try {
            if (!fs.statSync(candidate).isFile()) continue;
            if (!isCanonicalDescendant(allowedRoot, candidate)) {
                outsideTarget = candidate;
                continue;
            }
            return { target: canonicalPath(candidate) };
        } catch {
            continue;
        }
    }

    if (outsideTarget) {
        return {
            diagnostic: { kind: 'outside-root', source: sourceFile, reference, target: outsideTarget },
        };
    }
    return { diagnostic: { kind: 'missing', source: sourceFile, reference } };
}

export function expandInstructionFiles(
    rootFiles: string[],
    options: ExpandInstructionOptions,
): InstructionExpansion {
    const normalizedRoots = rootFiles.map((file) => path.resolve(file));
    const cacheKey = JSON.stringify({
        roots: normalizedRoots.map(normalizePathForCompare),
        cwd: normalizePathForCompare(options.cwd),
        user: options.userClaudeDirectory ? normalizePathForCompare(options.userClaudeDirectory) : '',
        depth: options.depthLimit ?? CLAUDE_IMPORT_DEPTH_LIMIT,
    });
    const cached = expansionCache.get(cacheKey);
    if (cached && stampsStillValid(cached.stamps)) return cloneExpansion(cached.result);

    const files: ExpandedInstructionFile[] = [];
    const diagnostics: ImportDiagnostic[] = [];
    const visited = new Set<string>();
    const activeStack = new Set<string>();
    const stamps = new Map<string, FileStamp>();
    const depthLimit = options.depthLimit ?? CLAUDE_IMPORT_DEPTH_LIMIT;

    const visit = (filePath: string, depth: number, importedBy?: string): void => {
        const resolved = canonicalPath(filePath);
        const key = normalizePathForCompare(resolved);
        if (activeStack.has(key)) {
            diagnostics.push({ kind: 'cycle', source: importedBy ?? resolved, target: resolved });
            return;
        }
        if (visited.has(key)) return;

        const currentStamp = stamp(resolved);
        stamps.set(key, currentStamp);
        if (!currentStamp.exists) {
            diagnostics.push({ kind: 'missing', source: importedBy ?? resolved, target: resolved });
            return;
        }

        let rawContent: string;
        try {
            rawContent = fs.readFileSync(resolved, 'utf8');
        } catch {
            diagnostics.push({ kind: 'read-error', source: importedBy ?? resolved, target: resolved });
            return;
        }

        const content = stripClaudeHtmlComments(rawContent);
        visited.add(key);
        activeStack.add(key);
        files.push({
            path: resolved,
            canonicalPath: resolved,
            content,
            depth,
            importedBy,
            fingerprint: fingerprint(content),
        });

        const references = extractClaudeImportReferences(rawContent);
        if (references.length > 0 && depth >= depthLimit) {
            for (const reference of references) {
                diagnostics.push({ kind: 'depth-limit', source: resolved, reference });
            }
        } else {
            for (const reference of references) {
                const resolution = resolveImport(reference, resolved, options, stamps);
                if (resolution.diagnostic) {
                    diagnostics.push(resolution.diagnostic);
                } else if (resolution.target) {
                    visit(resolution.target, depth + 1, resolved);
                }
            }
        }
        activeStack.delete(key);
    };

    for (const rootFile of normalizedRoots) visit(rootFile, 0);

    const result = { files, diagnostics };
    expansionCache.set(cacheKey, {
        stamps: Array.from(stamps.values()),
        result: cloneExpansion(result),
    });
    return result;
}

export function clearInstructionImportCache(): void {
    expansionCache.clear();
}
