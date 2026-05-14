// `workspace_symbols` — wraps `vscode.executeWorkspaceSymbolProvider`.
// Discovery tool: given a free-form query, returns every symbol in the
// workspace whose name matches (the language server decides on its own
// matching rules — Roslyn uses CamelCase segments, rust-analyzer and
// tsserver use substring/fuzzy). Distinct from `document_symbols`,
// which only enumerates a single file.
//
// Important known limitation (documented in design doc §5): Roslyn's
// workspace symbol search occasionally drops valid matches for some
// queries — pre-flight observed `"CoreData"` and `"InitContext"`
// returning 0 even though those names exist in the workspace.
// Tool description and guidelines tell the agent to fall back to grep
// when an expected-present symbol returns empty. We intentionally do
// NOT auto-fallback inside the tool: silent grep substitution would
// hide the failure mode from the agent and produce different (more
// noisy) results than the LSP path. Surface the empty result honestly
// and let the agent decide.

import * as vscode from 'vscode';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    detectProviderStatus,
    normalizeWorkspaceSymbols,
} from '../helpers';
import {
    LABEL_WORKSPACE_SYMBOLS,
    type NormalizedSymbol,
    TOOL_WORKSPACE_SYMBOLS,
    type WorkspaceSymbolsDetails,
    type WorkspaceSymbolsParams,
    WorkspaceSymbolsParamsSchema,
} from '../types';

const DEFAULT_MAX_RESULTS = 50;

const TOOL_DESCRIPTION =
    'Search the entire workspace for symbols matching a free-form query ' +
    'via the active language server. USE THIS FOR "find class / method / ' +
    'interface / struct named X anywhere", "what classes exist with ' +
    'prefix Foo?", "list all methods called Apply". NOT for: "what is X" ' +
    '(→ `hover`), "where is X declared" when you already know the file ' +
    '(→ `document_symbols`), "where is X used" (→ `find_references`). ' +
    'Returns name, kind (class / method / field / ...), parent ' +
    'container, and authoritative `(file, line, column)` for each match ' +
    '— ready to feed into `find_references`, `goto_definition`, ' +
    '`hover`, etc. Server matching rules differ: Roslyn (C#) uses ' +
    'CamelCase-segment matching ("PC" matches "PlayerController"); ' +
    'rust-analyzer and tsserver use substring/fuzzy. Known limitation: ' +
    'Roslyn occasionally returns 0 results for queries whose target ' +
    'symbol provably exists (observed for some short names like ' +
    '"CoreData"). On a surprising empty result, fall back to grep ' +
    'before concluding the symbol is missing. Optional `kindFilter` ' +
    'narrows by SymbolKind for short queries that would otherwise ' +
    'return hundreds across kinds.';

const TOOL_PROMPT_SNIPPET = 'Search the workspace for symbols by name (cross-file)';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "Find class/method/struct named X anywhere in the project" → this tool. "What is X / what type is X" → `hover`. "Where is X declared" if you ALREADY know the file → `document_symbols` (faster, more reliable than workspace search). "Where is X used" → `find_references`. Workspace symbol search is broader and noisier than document_symbols; reach for it only when the file is unknown.',
    'When a search returns 0 results for a symbol you have reason to believe exists (e.g. you saw it in a recent `read` or grep), DO NOT conclude the symbol is missing. Roslyn\'s workspace symbol provider in particular is known to drop valid matches for some queries. Fall back to grep on the identifier; if grep finds it, use the grep result\'s file/line as input to other LSP tools.',
    'Short queries on large workspaces return many results across kinds. Use `kindFilter: ["class"]` or `["interface", "struct"]` to narrow when you only need declarations of a specific shape. Combine with maxResults if needed.',
    'Each result is a position you can pass directly into the next LSP tool — `find_references({file, line, column})`, `goto_definition({file, line, column})`, `hover(...)`. The line and column are authoritative from the language server; do not recompute them.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the workspace folders\' primary language. Suggest the user install the appropriate extension.',
];

const KIND_FILTER_ALIASES: Record<string, string> = {
    class: 'class',
    struct: 'struct',
    interface: 'interface',
    enum: 'enum',
    'enum-member': 'enum-member',
    method: 'method',
    function: 'function',
    field: 'field',
    property: 'property',
    namespace: 'namespace',
    module: 'module',
    variable: 'variable',
    constant: 'constant',
    constructor: 'constructor',
    event: 'event',
    'type-parameter': 'type-parameter',
    typeparameter: 'type-parameter',
};

export function registerWorkspaceSymbolsTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_WORKSPACE_SYMBOLS,
        label: LABEL_WORKSPACE_SYMBOLS,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: WorkspaceSymbolsParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as WorkspaceSymbolsParams;
            return await runWorkspaceSymbols(typed);
        },
    });
}

async function runWorkspaceSymbols(params: WorkspaceSymbolsParams) {
    const query = params.query ?? '';
    const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
    const kindFilter = normalizeKindFilter(params.kindFilter);

    if (query.length === 0) {
        return errorEnvelope('Provide a non-empty `query` string.');
    }

    const raw = await vscode.commands.executeCommand<unknown>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
    );

    const all = normalizeWorkspaceSymbols(raw);
    const filtered = kindFilter
        ? all.filter((s) => kindFilter.has(s.kind))
        : all;
    const totalCount = filtered.length;
    const truncated = totalCount > maxResults;
    const symbols = truncated ? filtered.slice(0, maxResults) : filtered;

    // No anchor file → use the primary workspace folder's languageId
    // heuristically for the provider-status check. If unknown, default
    // to 'ok' (we already got a non-empty result OR no extensions to
    // check against).
    const providerStatus = totalCount === 0
        ? detectProviderStatus(guessPrimaryLanguageId())
        : 'ok';

    const details: WorkspaceSymbolsDetails = {
        providerStatus,
        query,
        totalCount,
        truncated,
        symbols,
    };

    return { content: [{ type: 'text' as const, text: formatText(details, kindFilter) }], details };
}

function normalizeKindFilter(raw: readonly string[] | undefined): Set<string> | undefined {
    if (!raw || raw.length === 0) return undefined;
    const out = new Set<string>();
    for (const k of raw) {
        const normalized = KIND_FILTER_ALIASES[k.toLowerCase().trim()];
        if (normalized) out.add(normalized);
    }
    return out.size === 0 ? undefined : out;
}

/**
 * Pick a reasonable languageId for the `no-provider` heuristic when
 * we have no anchor file. Walk open editors first (most likely match
 * for what the user is working on), then fall back to a hardcoded set
 * derived from workspace folder names — extremely approximate, but
 * the alternative is forcing the user to specify a language, which
 * would clutter the API for a corner case.
 */
function guessPrimaryLanguageId(): string {
    for (const editor of vscode.window.visibleTextEditors) {
        const id = editor.document.languageId;
        if (id && id !== 'plaintext') return id;
    }
    // Fallback: try the active text editor (might be a non-visible
    // panel). If nothing, just return an empty string — the provider
    // status check will then return 'ok'.
    return vscode.window.activeTextEditor?.document.languageId ?? '';
}

function formatText(details: WorkspaceSymbolsDetails, kindFilter: Set<string> | undefined): string {
    if (details.providerStatus === 'no-provider') {
        return [
            `No active language extension matched the workspace's primary language.`,
            'Install a VS Code language extension (e.g. C#, rust-analyzer, Pylance) and reload the window.',
        ].join('\n');
    }
    const filterSuffix = kindFilter
        ? ` filtered to kinds [${[...kindFilter].join(', ')}]`
        : '';
    if (details.totalCount === 0) {
        return [
            `No symbols matching "${details.query}"${filterSuffix}.`,
            'If you have reason to believe a symbol with this name exists (e.g. you saw it in grep), fall back to grep — workspace symbol search occasionally drops valid matches, especially on Roslyn.',
        ].join('\n');
    }
    const header = details.truncated
        ? `${details.symbols.length} of ${details.totalCount} symbols matching "${details.query}"${filterSuffix} (truncated):`
        : `${details.totalCount} symbol${details.totalCount === 1 ? '' : 's'} matching "${details.query}"${filterSuffix}:`;
    const lines: string[] = [header, ''];
    for (const s of details.symbols) {
        lines.push(formatSymbol(s));
    }
    return lines.join('\n');
}

function formatSymbol(s: NormalizedSymbol): string {
    const container = s.container ? ` (in ${s.container})` : '';
    return `${s.kind} ${s.name}${container} @ ${s.file}:${s.line}:${s.column}`;
}

function errorEnvelope(message: string) {
    return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        details: { error: message },
    };
}
