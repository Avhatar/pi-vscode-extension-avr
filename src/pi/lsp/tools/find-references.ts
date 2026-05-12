// `find_references` — wraps `vscode.executeReferenceProvider`. Returns a
// flat, normalized list of all usages of the symbol under the position,
// including matches in external dependency sources (annotated
// `source: "external"`) so the agent can decide whether to follow them.

import * as vscode from 'vscode';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
    detectProviderStatus,
    normalizeLocations,
    probeResolvedSymbol,
    resolveExplicitPosition,
    resolveSymbol,
    type SymbolCandidate,
} from '../helpers';
import {
    type FindReferencesDetails,
    type FindReferencesParams,
    FindReferencesParamsSchema,
    LABEL_FIND_REFERENCES,
    TOOL_FIND_REFERENCES,
} from '../types';

const DEFAULT_CONTEXT_LINES = 2;
// Empirically the cap that hits the sweet spot on real codebases: in
// pre-flight smoke a public Unity property had 72 references, with
// realistic ranges 30–300. 50 was too tight (truncation → wasted
// second call); 500+ blows the context window on popular framework
// symbols. 200 lets ~99% of queries return without truncation while
// still bounding the payload at ~20K tokens worst case.
const DEFAULT_MAX_RESULTS = 200;

const TOOL_DESCRIPTION =
    'Find all reference sites of the symbol at a given file position via ' +
    'the active language server (Roslyn for C#, rust-analyzer for Rust, ' +
    'tsserver for TS, Pylance for Python, etc.). USE THIS FOR "where is ' +
    'X used / called / written?" — NOT for "what is X?" (use `hover`) ' +
    'or "where is X declared?" (use `goto_definition`). Each result is ' +
    'a place in the codebase where the symbol is USED or DEFINED — not ' +
    'a place where the symbol is unrelated. Cross-file results are ' +
    'expected: a reference in `Foo.cs` simply means that file mentions ' +
    'the symbol. The returned snippet is the code AT the reference site ' +
    '(with surrounding context); the matching line is marked with `>` ' +
    'and every line is numbered so you can open the file at the exact ' +
    'location. Address the symbol either via (file, line, column) — ' +
    'preferred when you already have a position from `document_symbols`, ' +
    'grep, or read — or via a symbol name, which is resolved via ' +
    'workspace symbol search and returns the candidate list if ' +
    'ambiguous. Pass `includeAccessKind: true` to tag each reference ' +
    'with `read`/`write`/`text` from the language server itself when ' +
    'the user\'s question hinges on reads vs writes (e.g. "where is X ' +
    'assigned?" or "show only reads of X"); otherwise leave it off — ' +
    'classification costs N+1 LSP calls.';

const TOOL_PROMPT_SNIPPET = 'Find all reference sites of a symbol via the language server';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "Where is X USED / CALLED / WRITTEN" → this tool. "What IS X / what does X do / what type is X" → use `hover` instead (one cheap call returns signature + docs). "Where is X DECLARED" → use `goto_definition` (returns the definition with a snippet). Reaching for `find_references` to answer "what does X do" wastes a 200-result payload trying to infer meaning from use sites; hover gives you the language server\'s structured answer in 10 ms.',
    'When you know the target file and the target symbol name, ALWAYS call `document_symbols` first to get the authoritative `(line, column)` for that symbol — then pass that position here. Hand-counting columns from a `read` output is fragile around generics, attributes, and same-named tokens (e.g. `public Player Player;` where the type and field share a name; or `[field: SerializeField]` attribute targets resolving instead of the field).',
    'ALWAYS read the three header lines before the reference entries: `Position:`, `Line: |...`, `Column: |...`, and `Resolved symbol at position:`. The `Line` shows the actual source line at the column you sent; the `Column` line has a caret `^` under that exact column. The `Resolved symbol` shows what the language server saw there. Three outcomes: (1) caret lands on the intended token AND resolved symbol matches — proceed. (2) caret lands on the WRONG token (e.g. you intended `Player` but the caret sits on `Player ` the type or on whitespace) — adjust your column and retry. (3) caret lands on the right token but resolved symbol is something unrelated (e.g. `[field: SerializeField]` instead of the field — known Roslyn quirk on field-targeted attributes) — retry this same tool with the `symbol` parameter (e.g. `{symbol: "Player"}`); workspace symbol search bypasses the attribute-target quirk and gives an authoritative position from the language server. If the symbol-name form also returns "not found" or an ambiguous list with no clear match, only THEN fall back to grep.',
    'Each result is a USE SITE of the resolved symbol. The snippet shows the code at that site, not the symbol\'s definition. If a result lives in `Foo.cs`, it means Foo.cs *uses* the symbol — that is the expected outcome of a references query, not a wrong match.',
    'For "where is X assigned?" / "show only reads/writes of X" questions, pass `includeAccessKind: true`. Each result then carries `accessKind: read|write|text|unknown` from the language server\'s document-highlight provider — no need to grep for `X =` separately or eyeball snippets to classify them. The header line shows the breakdown counts (e.g. "72 reference sites — read: 65, write: 5, text: 2"). When the access kind is what the user is asking about, this flag is the correct, authoritative way to get it.',
    'The match line is marked with `>` in the snippet. Surrounding context lines use `  ` (two spaces). Read the `>` line to see the actual usage; ignore the framing as context only.',
    'Prefer (file, line, column) when you already have a known location from a prior grep or read. Use the symbol name form only when you do not have a position.',
    'Symbol-name resolution can return zero results even for symbols that exist (workspace symbol search is server-dependent). On an empty result, fall back to grep before concluding the symbol is unused.',
    'External dependency results (`source: "external"`) point to read-only sources such as ~/.cargo/registry, ~/.nuget/packages, or node_modules. Treat them as informational unless the user is debugging the dependency itself.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension; do not interpret an empty list as "no references".',
];

export function registerFindReferencesTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_FIND_REFERENCES,
        label: LABEL_FIND_REFERENCES,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: FindReferencesParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as FindReferencesParams;
            return await runFindReferences(typed);
        },
    });
}

async function runFindReferences(params: FindReferencesParams) {
    const contextLines = params.contextLines ?? DEFAULT_CONTEXT_LINES;
    const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
    const includeAccessKind = params.includeAccessKind === true;

    const target = await resolveTarget(params);
    if (target.kind === 'error') {
        return errorEnvelope(target.message);
    }
    if (target.kind === 'multiple') {
        return ambiguousEnvelope(target.candidates);
    }

    const { uri, pos, languageId } = target;

    // Probe what the language server actually resolves at this position
    // BEFORE doing the (expensive) reference search. Running both in
    // parallel keeps total latency at max(hover, references) instead of
    // sum — hover is typically 5–15 ms, references 200–600 ms, so the
    // extra hover call is effectively free.
    const queryDocPromise = vscode.workspace.openTextDocument(uri);
    const [resolvedSymbol, raw, queryDoc] = await Promise.all([
        probeResolvedSymbol(uri, pos),
        vscode.commands.executeCommand<unknown>(
            'vscode.executeReferenceProvider',
            uri,
            pos,
        ),
        queryDocPromise,
    ]);
    const queryLineText = pos.line < queryDoc.lineCount
        ? queryDoc.lineAt(pos.line).text
        : '';

    const normalized = await normalizeLocations(raw, { contextLines, includeAccessKind });
    const totalCount = normalized.length;
    const truncated = totalCount > maxResults;
    const results = truncated ? normalized.slice(0, maxResults) : normalized;

    // Distinguish "no provider" from "no matches". If the array is empty
    // AND no known language extension is active for this languageId, the
    // empty result almost certainly reflects a missing provider rather
    // than a real absence of references.
    const providerStatus = totalCount === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: FindReferencesDetails = {
        providerStatus,
        totalCount,
        truncated,
        results,
        languageId,
        resolvedSymbol,
        queryFile: displayFile(uri),
        queryLine: pos.line + 1,
        queryColumn: pos.character + 1,
        queryLineText,
    };

    return { content: [{ type: 'text' as const, text: formatText(details) }], details };
}

type ResolvedTarget =
    | { kind: 'ok'; uri: vscode.Uri; pos: vscode.Position; languageId: string }
    | { kind: 'multiple'; candidates: SymbolCandidate[] }
    | { kind: 'error'; message: string };

async function resolveTarget(params: FindReferencesParams): Promise<ResolvedTarget> {
    const hasExplicit =
        typeof params.file === 'string'
        && typeof params.line === 'number'
        && typeof params.column === 'number';

    if (hasExplicit) {
        try {
            const { uri, pos } = resolveExplicitPosition(
                params.file as string,
                params.line as number,
                params.column as number,
            );
            const doc = await vscode.workspace.openTextDocument(uri);
            return { kind: 'ok', uri, pos, languageId: doc.languageId };
        } catch (err) {
            return { kind: 'error', message: (err as Error).message };
        }
    }

    if (typeof params.symbol === 'string' && params.symbol.length > 0) {
        const resolution = await resolveSymbol(params.symbol);
        if (resolution.kind === 'none') {
            return {
                kind: 'error',
                message: `Symbol "${params.symbol}" not found via workspace symbol search. Workspace symbol providers are server-dependent and may miss valid names; pass an explicit file/line/column from a grep result instead.`,
            };
        }
        if (resolution.kind === 'multiple') {
            return { kind: 'multiple', candidates: resolution.candidates };
        }
        return {
            kind: 'ok',
            uri: resolution.uri,
            pos: resolution.pos,
            languageId: resolution.languageId,
        };
    }

    return {
        kind: 'error',
        message: 'Provide either (file, line, column) or a `symbol` name.',
    };
}

function formatText(details: FindReferencesDetails): string {
    if (details.providerStatus === 'no-provider') {
        return [
            `No language extension is active for "${details.languageId}".`,
            'Install the appropriate VS Code extension (e.g. C#, rust-analyzer, Pylance) and reload the window.',
        ].join('\n');
    }
    if (details.totalCount === 0) {
        return 'No references found.';
    }
    const kindBreakdown = buildKindBreakdown(details.results);
    const breakdownSuffix = kindBreakdown ? ` — ${kindBreakdown}` : '';
    const countLine = details.truncated
        ? `${details.results.length} of ${details.totalCount} reference sites (truncated)${breakdownSuffix}. Each entry is a place where the symbol is used; the `
          + '`>` line in the snippet is the actual match.'
        : `${details.totalCount} reference site${details.totalCount === 1 ? '' : 's'}${breakdownSuffix}. Each entry is a place where the symbol is used; the `
          + '`>` line in the snippet is the actual match.';
    const resolvedLine = details.resolvedSymbol
        ? `Resolved symbol at position: ${details.resolvedSymbol}`
        : 'Resolved symbol at position: <unknown — hover not available>';
    const lines: string[] = [];
    lines.push(...formatQueryEcho(details));
    lines.push(resolvedLine);
    lines.push(countLine);
    lines.push('');
    for (const r of details.results) {
        const tags: string[] = [];
        if (r.accessKind) tags.push(r.accessKind);
        if (r.source === 'external') tags.push('external');
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        lines.push(`${r.file}:${r.line}:${r.column}${tagStr}`);
        lines.push(r.snippet);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

function displayFile(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) return vscode.workspace.asRelativePath(uri, false);
    return uri.fsPath ?? uri.toString();
}

/**
 * Summarize access kinds for the header line, e.g. "read: 65, write: 5".
 * Returns empty string when no result carries `accessKind` (the agent
 * didn't ask for classification), so the header stays concise.
 */
function buildKindBreakdown(results: ReadonlyArray<{ accessKind?: string }>): string {
    const counts: Record<string, number> = {};
    for (const r of results) {
        if (r.accessKind) {
            counts[r.accessKind] = (counts[r.accessKind] ?? 0) + 1;
        }
    }
    const order = ['read', 'write', 'text', 'unknown'];
    const parts = order
        .filter((k) => counts[k] > 0)
        .map((k) => `${k}: ${counts[k]}`);
    return parts.join(', ');
}

/**
 * Render the requested position back to the agent: the actual source
 * line plus a caret pointing at the requested column. Lets the agent
 * see — at a glance — whether its column counting matches the file's
 * tabs/spaces reality, and whether the language server resolved this
 * position to something different than what the line content suggests.
 *
 * Layout (always two same-prefixed lines so the caret aligns under the
 * exact character regardless of line content):
 *
 *   Position: src/Core.cs:60:19
 *   Line:    |    public Player Player { get; private set; }
 *   Column:  |                  ^
 */
function formatQueryEcho(details: FindReferencesDetails): string[] {
    if (
        details.queryFile === undefined
        || details.queryLine === undefined
        || details.queryColumn === undefined
        || details.queryLineText === undefined
    ) {
        return [];
    }
    const col = Math.max(1, details.queryColumn);
    const caret = ' '.repeat(col - 1) + '^';
    return [
        `Position: ${details.queryFile}:${details.queryLine}:${details.queryColumn}`,
        `Line:    |${details.queryLineText}`,
        `Column:  |${caret}`,
    ];
}

function errorEnvelope(message: string) {
    return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        details: { error: message },
    };
}

function ambiguousEnvelope(candidates: SymbolCandidate[]) {
    const lines = [
        `Symbol name matched ${candidates.length} candidates. Re-run with an explicit (file, line, column) from one of:`,
    ];
    for (const c of candidates) {
        const container = c.containerName ? ` (in ${c.containerName})` : '';
        lines.push(`  ${c.kind} ${c.name}${container} — ${c.file}:${c.line}:${c.column}`);
    }
    return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: { ambiguous: true, candidates },
    };
}
