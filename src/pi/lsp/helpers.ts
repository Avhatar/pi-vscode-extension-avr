// Shared helpers for LSP-backed tools. Three responsibilities:
//
//   1. Provider-status detection — distinguish "no results" from
//      "no language extension registered" (see lsp-integration.md §4.8).
//   2. Location normalization — handle both `Location` (Roslyn) and
//      `LocationLink` (rust-analyzer); produce a uniform shape with
//      snippet + context + workspace/external classification.
//   3. Symbol resolution — turn a symbol name into a concrete
//      (uri, Position) by consulting `executeWorkspaceSymbolProvider`.

import * as vscode from 'vscode';
import type { AccessKind, NormalizedLocation, NormalizedSymbol, ProviderStatus } from './types';

// Known language extensions per languageId. Used by the provider-status
// detector to distinguish "extension installed, returned []" from
// "no extension installed". Extend as we observe new ecosystems; missing
// entries fall back to a permissive `unknown` status (we assume `ok`
// rather than reporting a false-negative).
const KNOWN_LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
    csharp: ['ms-dotnettools.csharp', 'ms-dotnettools.csdevkit'],
    typescript: ['vscode.typescript-language-features'],
    typescriptreact: ['vscode.typescript-language-features'],
    javascript: ['vscode.typescript-language-features'],
    javascriptreact: ['vscode.typescript-language-features'],
    python: ['ms-python.python', 'ms-python.vscode-pylance'],
    rust: ['rust-lang.rust-analyzer'],
    go: ['golang.go'],
    cpp: ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'],
    c: ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'],
    java: ['redhat.java'],
    ruby: ['shopify.ruby-lsp', 'rebornix.ruby'],
    php: ['bmewburn.vscode-intelephense-client'],
    kotlin: ['fwcd.kotlin'],
    swift: ['sswg.swift-lang'],
};

/**
 * Decide whether a (suspiciously empty) provider result means "no
 * provider registered" or just "no matches". Heuristic:
 *
 *   - If the languageId has a known set of language extensions and none
 *     of them is `active`, treat as `no-provider`.
 *   - Otherwise treat as `ok` (the extension is responsible, even if it
 *     returned an empty array).
 *
 * We deliberately do NOT use a timing heuristic here. Pre-flight showed
 * empty-with-provider can be as fast as 1 ms (e.g. document symbols on a
 * trivial file), so timing-based detection would produce false positives.
 */
export function detectProviderStatus(languageId: string): ProviderStatus {
    const known = KNOWN_LANGUAGE_EXTENSIONS[languageId];
    if (!known || known.length === 0) {
        return 'ok';
    }
    const anyActive = vscode.extensions.all.some(
        (ext) => known.includes(ext.id) && ext.isActive,
    );
    return anyActive ? 'ok' : 'no-provider';
}

/**
 * Convert a raw LSP-ish result (Location[] or LocationLink[] or a single
 * Location) to the agent-facing NormalizedLocation[]. Reads each
 * location's file to build a snippet with `contextLines` of context on
 * either side. File contents are cached for the lifetime of this call so
 * a 50-reference result on a few files does not re-read each file 50
 * times.
 *
 * When `includeAccessKind` is true, each reference is additionally
 * tagged with `accessKind` from the language server's documentHighlight
 * provider — see `classifyAccess` for cost and accuracy notes.
 */
export async function normalizeLocations(
    raw: unknown,
    opts: { contextLines: number; includeAccessKind?: boolean },
): Promise<NormalizedLocation[]> {
    const flat = flattenLocations(raw);
    if (flat.length === 0) return [];

    const kindByKey = opts.includeAccessKind
        ? await classifyAccess(flat)
        : undefined;

    const fileCache = new Map<string, string[]>();
    const out: NormalizedLocation[] = [];
    for (const loc of flat) {
        const lines = await loadLines(loc.uri, fileCache);
        const startLine = loc.range.start.line;
        const startChar = loc.range.start.character;
        const snippet = extractSnippet(lines, startLine, opts.contextLines);
        const source = classifySource(loc.uri);
        const accessKind = kindByKey?.get(locationKey(loc));
        out.push({
            file: displayPath(loc.uri),
            line: startLine + 1,
            column: startChar + 1,
            snippet,
            source,
            ...(accessKind ? { accessKind } : {}),
        });
    }
    return out;
}

/**
 * Tag each reference with `read | write | text | unknown` using the
 * language server's `textDocument/documentHighlight`. Strategy:
 *
 *   1. Group references by file URI.
 *   2. For each group, call `executeDocumentHighlights` once, anchored
 *      at the first reference position in that file. The server returns
 *      every occurrence of the same symbol in the file with a kind.
 *   3. Build a (uri, line, char) → kind map by matching range starts.
 *      Refs that don't appear in the highlights map (external files
 *      whose server has no highlights provider, or servers that don't
 *      implement documentHighlight at all) get `unknown`.
 *
 * Cost: N+1 LSP calls (1 reference search + N highlights for N
 * distinct files). Each highlight call is typically 50–150 ms. For a
 * typical query touching 5–10 files the overhead is ~0.5–1 s — not
 * free, which is why it's opt-in via `includeAccessKind`.
 */
async function classifyAccess(refs: FlatLocation[]): Promise<Map<string, AccessKind>> {
    const result = new Map<string, AccessKind>();
    const byFile = new Map<string, FlatLocation[]>();
    for (const r of refs) {
        const k = r.uri.toString();
        const list = byFile.get(k) ?? [];
        list.push(r);
        byFile.set(k, list);
    }
    for (const [, group] of byFile) {
        const anchor = group[0];
        let highlights: vscode.DocumentHighlight[] | undefined;
        try {
            highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
                'vscode.executeDocumentHighlights',
                anchor.uri,
                anchor.range.start,
            );
        } catch {
            highlights = undefined;
        }
        if (!highlights || highlights.length === 0) {
            for (const r of group) result.set(locationKey(r), 'unknown');
            continue;
        }
        for (const r of group) {
            const match = highlights.find(
                (h) =>
                    h.range.start.line === r.range.start.line
                    && h.range.start.character === r.range.start.character,
            );
            result.set(locationKey(r), match ? mapHighlightKind(match.kind) : 'unknown');
        }
    }
    return result;
}

function locationKey(loc: FlatLocation): string {
    return `${loc.uri.toString()}::${loc.range.start.line}::${loc.range.start.character}`;
}

function mapHighlightKind(kind: vscode.DocumentHighlightKind | undefined): AccessKind {
    if (kind === vscode.DocumentHighlightKind.Read) return 'read';
    if (kind === vscode.DocumentHighlightKind.Write) return 'write';
    return 'text';
}

interface FlatLocation {
    uri: vscode.Uri;
    range: vscode.Range;
}

function flattenLocations(raw: unknown): FlatLocation[] {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    const out: FlatLocation[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        if (obj.uri instanceof vscode.Uri && obj.range) {
            out.push({ uri: obj.uri as vscode.Uri, range: obj.range as vscode.Range });
        } else if (obj.targetUri instanceof vscode.Uri && obj.targetSelectionRange) {
            // LocationLink — prefer targetSelectionRange (the symbol's
            // own range) over targetRange (the enclosing block) for a
            // tight pointer.
            out.push({
                uri: obj.targetUri as vscode.Uri,
                range: obj.targetSelectionRange as vscode.Range,
            });
        } else if (obj.targetUri instanceof vscode.Uri && obj.targetRange) {
            out.push({
                uri: obj.targetUri as vscode.Uri,
                range: obj.targetRange as vscode.Range,
            });
        }
    }
    return out;
}

async function loadLines(
    uri: vscode.Uri,
    cache: Map<string, string[]>,
): Promise<string[]> {
    return loadFileLines(uri, cache);
}

/**
 * Public version of `loadLines`. Reads the document text via VS Code's
 * workspace API (uses the in-memory copy when the file is open in the
 * editor, otherwise falls back to disk). Lines are split on `\r?\n` and
 * cached so repeated lookups in the same call don't re-tokenize. Used
 * by call-hierarchy tools to render snippets at fromRanges across many
 * caller files without re-opening each file per range.
 */
export async function loadFileLines(
    uri: vscode.Uri,
    cache?: Map<string, string[]>,
): Promise<string[]> {
    const map = cache ?? new Map<string, string[]>();
    const key = uri.toString();
    const hit = map.get(key);
    if (hit) return hit;
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const lines = text.split(/\r?\n/);
        map.set(key, lines);
        return lines;
    } catch {
        map.set(key, []);
        return [];
    }
}

/**
 * Build a snippet around the match line. The match line is prefixed
 * with `> ` and surrounding context with `  `, so the agent can spot
 * the actual reference at a glance instead of guessing from the
 * surrounding text. Both prefixes are the same width to keep code
 * vertically aligned for easy reading. Lines are numbered with their
 * absolute line number so cross-referencing with grep / open-file
 * results is trivial.
 */
function extractSnippet(
    lines: string[],
    line: number,
    contextLines: number,
): string {
    return formatSnippetBlock(lines, line, contextLines);
}

/**
 * Public version of `extractSnippet`. Renders `[contextLines]` lines
 * around a 0-based source line with a `>` marker on the match line and
 * absolute line numbers. Shared between `normalizeLocations` (reference /
 * implementation / definition snippets) and the call-hierarchy tools
 * (one snippet per fromRange of an incoming/outgoing call).
 */
export function formatSnippetBlock(
    lines: string[],
    line: number,
    contextLines: number,
): string {
    if (lines.length === 0) return '';
    const start = Math.max(0, line - contextLines);
    const end = Math.min(lines.length, line + contextLines + 1);
    const width = String(end).length;
    const out: string[] = [];
    for (let i = start; i < end; i++) {
        const num = String(i + 1).padStart(width, ' ');
        const marker = i === line ? '>' : ' ';
        out.push(`${marker} ${num} | ${lines[i] ?? ''}`);
    }
    return out.join('\n');
}

export function classifySource(uri: vscode.Uri): 'workspace' | 'external' {
    return vscode.workspace.getWorkspaceFolder(uri) ? 'workspace' : 'external';
}

export function displayPath(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) return vscode.workspace.asRelativePath(uri, false);
    return uri.fsPath ?? uri.toString();
}

/**
 * Probe the language server's hover provider at `(uri, pos)` and return
 * a one-liner identifying the symbol Roslyn / rust-analyzer / tsserver
 * actually resolved there. The agent reads this back to verify its
 * column landed on the intended token — without it, a column off by a
 * few characters silently resolves to a nearby symbol (e.g.
 * `[SerializeField]` instead of the field name) and the reference
 * results become misleading.
 *
 * Returns `undefined` if hover is empty or the provider is missing —
 * never throws, since this is a sanity-check, not a precondition.
 */
export async function probeResolvedSymbol(
    uri: vscode.Uri,
    pos: vscode.Position,
): Promise<string | undefined> {
    try {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            uri,
            pos,
        );
        if (!hovers || hovers.length === 0) return undefined;
        for (const h of hovers) {
            const line = extractHoverFirstLine(h);
            if (line) return line;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function extractHoverFirstLine(hover: vscode.Hover): string | undefined {
    const contents = hover.contents ?? [];
    for (const c of contents) {
        const text = typeof c === 'string' ? c : (c as { value?: string }).value ?? '';
        const cleaned = stripMarkdownCode(text).trim();
        if (cleaned.length === 0) continue;
        const firstLine = cleaned.split(/\r?\n/).find((l) => l.trim().length > 0);
        if (firstLine) return firstLine.trim();
    }
    return undefined;
}

function stripMarkdownCode(text: string): string {
    // Strip ```lang ... ``` fences, keep the inner content. Leaves prose
    // markdown untouched.
    return text.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
}

/**
 * Render the full hover payload for the agent. Unlike
 * `probeResolvedSymbol` (which extracts only the first signature line
 * for the resolved-symbol header), this preserves the language
 * server's full markdown — code fences, multi-paragraph docs, inferred
 * types — because that's what makes hover the most info-dense tool the
 * agent has.
 *
 * Multiple Hover entries are joined with a separator. Empty sections
 * are dropped. The final string is the agent-facing tool output.
 */
export async function fetchHoverContent(
    uri: vscode.Uri,
    pos: vscode.Position,
): Promise<string> {
    try {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            uri,
            pos,
        );
        if (!hovers || hovers.length === 0) return '';
        const sections: string[] = [];
        for (const h of hovers) {
            const section = renderHover(h).trim();
            if (section.length > 0) sections.push(section);
        }
        return sections.join('\n\n---\n\n');
    } catch {
        return '';
    }
}

function renderHover(hover: vscode.Hover): string {
    const contents = hover.contents ?? [];
    const parts: string[] = [];
    for (const c of contents) {
        if (typeof c === 'string') {
            parts.push(c);
        } else if ('language' in c) {
            // Old-style MarkedString: { language, value } → code block.
            const block = c as { language: string; value: string };
            parts.push(`\`\`\`${block.language}\n${block.value}\n\`\`\``);
        } else if ('value' in c) {
            // MarkdownString: keep as-is.
            parts.push((c as { value: string }).value);
        }
    }
    return parts.join('\n\n');
}

/**
 * Resolve an explicit `(file, line, column)` triple to a (uri, Position).
 * Accepts both workspace-relative and absolute paths. Throws a
 * user-readable error if the file cannot be resolved.
 */
export function resolveExplicitPosition(
    file: string,
    line: number,
    column: number,
): { uri: vscode.Uri; pos: vscode.Position } {
    const uri = resolveFile(file);
    // Convert from 1-based (agent-facing) to 0-based (LSP).
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
    return { uri, pos };
}

function resolveFile(file: string): vscode.Uri {
    if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/')) {
        return vscode.Uri.file(file);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error(`No workspace folder open; cannot resolve relative path: ${file}`);
    }
    return vscode.Uri.joinPath(folders[0].uri, file);
}

/**
 * Symbol-name resolution. Calls `executeWorkspaceSymbolProvider` and
 * returns one of:
 *
 *   - { kind: 'single', uri, pos }           — exactly one match.
 *   - { kind: 'multiple', candidates: [...] } — ambiguity; agent must
 *                                                 disambiguate via
 *                                                 file+line+column.
 *   - { kind: 'none' }                        — no match (or workspace
 *                                                 symbol provider is
 *                                                 known-flaky on this
 *                                                 server — see §5).
 */
export type SymbolResolution =
    | { kind: 'single'; uri: vscode.Uri; pos: vscode.Position; languageId: string }
    | { kind: 'multiple'; candidates: SymbolCandidate[] }
    | { kind: 'none' };

export interface SymbolCandidate {
    name: string;
    containerName: string;
    kind: string;
    file: string;
    line: number;
    column: number;
}

export async function resolveSymbol(name: string): Promise<SymbolResolution> {
    const raw = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        name,
    );
    const matches = (raw ?? []).filter((s) => s.name === name);
    if (matches.length === 0) return { kind: 'none' };
    if (matches.length === 1) {
        const m = matches[0];
        const doc = await vscode.workspace.openTextDocument(m.location.uri);
        return {
            kind: 'single',
            uri: m.location.uri,
            pos: m.location.range.start,
            languageId: doc.languageId,
        };
    }
    return {
        kind: 'multiple',
        candidates: matches.slice(0, 20).map((m) => ({
            name: m.name,
            containerName: m.containerName ?? '',
            kind: symbolKindToString(m.kind),
            file: displayPath(m.location.uri),
            line: m.location.range.start.line + 1,
            column: m.location.range.start.character + 1,
        })),
    };
}

/**
 * Normalize a `vscode.executeDocumentSymbolProvider` result into a flat
 * `NormalizedSymbol[]`. The provider returns either:
 *
 *   - `DocumentSymbol[]` — hierarchical, with `range`, `selectionRange`
 *     and `children`. Roslyn (C#) and many newer servers use this.
 *   - `SymbolInformation[]` — flat, with `location` and `containerName`.
 *     rust-analyzer and older servers use this.
 *
 * We walk both shapes to produce a flat list with explicit `depth` and
 * a dotted `container` path so the agent can both scan it linearly and
 * grep by substring.
 *
 * The `line`/`column` we surface point at the symbol's own identifier
 * (LSP `selectionRange.start` for DocumentSymbol; the location range
 * start for SymbolInformation, which is the best we have without
 * post-processing the source). 1-based for the agent.
 */
export function normalizeDocumentSymbols(raw: unknown, uri: vscode.Uri): NormalizedSymbol[] {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    if (items.length === 0) return [];

    const file = displayPath(uri);
    const out: NormalizedSymbol[] = [];

    // DocumentSymbol shape: object has `selectionRange` AND `children`
    // arrays. SymbolInformation shape: object has `location` with `uri`
    // and `range`. Decide on the first non-null item.
    const first = items.find((i) => i && typeof i === 'object') as Record<string, unknown> | undefined;
    if (!first) return [];

    if ('selectionRange' in first || 'children' in first) {
        for (const item of items) {
            walkDocumentSymbol(item as vscode.DocumentSymbol, '', 0, file, out);
        }
    } else if ('location' in first) {
        for (const item of items) {
            const si = item as vscode.SymbolInformation;
            out.push({
                name: String(si.name ?? ''),
                kind: symbolKindToString(si.kind ?? 0),
                container: String(si.containerName ?? ''),
                file,
                line: (si.location?.range?.start?.line ?? 0) + 1,
                column: (si.location?.range?.start?.character ?? 0) + 1,
                depth: 0,
            });
        }
    }
    return out;
}

/**
 * Normalize a `vscode.executeWorkspaceSymbolProvider` result. The
 * provider always returns flat `SymbolInformation[]`, each item with
 * its OWN `.location.uri` (unlike `document_symbols` where every result
 * lives in the file we asked about). Always depth 0, container is the
 * server-reported containerName.
 */
export function normalizeWorkspaceSymbols(raw: unknown): NormalizedSymbol[] {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    const out: NormalizedSymbol[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const si = item as vscode.SymbolInformation;
        if (!si.location) continue;
        out.push({
            name: String(si.name ?? ''),
            kind: symbolKindToString(si.kind ?? 0),
            container: String(si.containerName ?? ''),
            file: displayPath(si.location.uri),
            line: (si.location.range?.start?.line ?? 0) + 1,
            column: (si.location.range?.start?.character ?? 0) + 1,
            depth: 0,
        });
    }
    return out;
}

function walkDocumentSymbol(
    sym: vscode.DocumentSymbol,
    parentPath: string,
    depth: number,
    file: string,
    out: NormalizedSymbol[],
): void {
    if (!sym) return;
    const selStart = sym.selectionRange?.start ?? sym.range?.start;
    out.push({
        name: String(sym.name ?? ''),
        kind: symbolKindToString(sym.kind ?? 0),
        container: parentPath,
        file,
        line: (selStart?.line ?? 0) + 1,
        column: (selStart?.character ?? 0) + 1,
        depth,
    });
    const children = (sym as { children?: vscode.DocumentSymbol[] }).children ?? [];
    const nextPath = parentPath ? `${parentPath}.${sym.name}` : String(sym.name ?? '');
    for (const child of children) {
        walkDocumentSymbol(child, nextPath, depth + 1, file, out);
    }
}

/**
 * Translate LSP `SymbolKind` integers to human-readable strings. The
 * enum values are stable in the protocol; rendering them as words makes
 * agent-facing output self-explanatory and avoids the agent having to
 * memorize numeric kinds (which we saw vary in meaning across servers).
 */
/**
 * Bootstrap a call-hierarchy session at `(uri, pos)`. The LSP requires
 * a two-step protocol: `prepareCallHierarchy` first to identify the
 * callable anchor (a method / function / constructor under the cursor),
 * then `provideIncomingCalls` / `provideOutgoingCalls` on that anchor.
 *
 * Returns the first anchor when the language server returns multiple
 * (rare — happens at positions that span more than one callable, e.g.
 * the closing brace of an overload set). Returns `undefined` for:
 *
 *   - language servers without a call-hierarchy provider (base
 *     `ms-dotnettools.csharp` is one; users need C# Dev Kit instead);
 *   - positions that are not on a callable symbol;
 *   - servers that returned `null` / `[]`.
 *
 * Caller decides how to surface the undefined case (typically:
 * `providerStatus: detectProviderStatus(languageId)` so we distinguish
 * "wrong cursor position" from "no language extension").
 */
export async function prepareCallHierarchyItem(
    uri: vscode.Uri,
    pos: vscode.Position,
): Promise<vscode.CallHierarchyItem | undefined> {
    try {
        const result = await vscode.commands.executeCommand<
            vscode.CallHierarchyItem | vscode.CallHierarchyItem[] | undefined
        >('vscode.prepareCallHierarchy', uri, pos);
        if (!result) return undefined;
        if (Array.isArray(result)) return result[0];
        return result;
    } catch {
        return undefined;
    }
}

export function symbolKindToString(kind: vscode.SymbolKind | number): string {
    switch (kind as vscode.SymbolKind) {
        case vscode.SymbolKind.File: return 'file';
        case vscode.SymbolKind.Module: return 'module';
        case vscode.SymbolKind.Namespace: return 'namespace';
        case vscode.SymbolKind.Package: return 'package';
        case vscode.SymbolKind.Class: return 'class';
        case vscode.SymbolKind.Method: return 'method';
        case vscode.SymbolKind.Property: return 'property';
        case vscode.SymbolKind.Field: return 'field';
        case vscode.SymbolKind.Constructor: return 'constructor';
        case vscode.SymbolKind.Enum: return 'enum';
        case vscode.SymbolKind.Interface: return 'interface';
        case vscode.SymbolKind.Function: return 'function';
        case vscode.SymbolKind.Variable: return 'variable';
        case vscode.SymbolKind.Constant: return 'constant';
        case vscode.SymbolKind.String: return 'string';
        case vscode.SymbolKind.Number: return 'number';
        case vscode.SymbolKind.Boolean: return 'boolean';
        case vscode.SymbolKind.Array: return 'array';
        case vscode.SymbolKind.Object: return 'object';
        case vscode.SymbolKind.Key: return 'key';
        case vscode.SymbolKind.Null: return 'null';
        case vscode.SymbolKind.EnumMember: return 'enum-member';
        case vscode.SymbolKind.Struct: return 'struct';
        case vscode.SymbolKind.Event: return 'event';
        case vscode.SymbolKind.Operator: return 'operator';
        case vscode.SymbolKind.TypeParameter: return 'type-parameter';
        default: return String(kind);
    }
}
