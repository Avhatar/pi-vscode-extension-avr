// `document_symbols` — lists every declaration in a file with its
// authoritative LSP position. Solves the column-counting problem the
// agent hits when trying to address symbols by hand from a `read`
// result: instead of guessing where in `public Player Player;` the
// field identifier starts, the agent asks this tool and gets
// `field Player @ Core.cs:60:19` straight from Roslyn / rust-analyzer
// / tsserver. Pair with `find_references` for "all uses of field X in
// file Y" workflows.

import * as vscode from 'vscode';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
    detectProviderStatus,
    normalizeDocumentSymbols,
    resolveExplicitPosition,
} from '../helpers';
import {
    type DocumentSymbolsDetails,
    type DocumentSymbolsParams,
    DocumentSymbolsParamsSchema,
    LABEL_DOCUMENT_SYMBOLS,
    type NormalizedSymbol,
    TOOL_DOCUMENT_SYMBOLS,
} from '../types';

const DEFAULT_MAX_RESULTS = 200;

const TOOL_DESCRIPTION =
    'List every declaration in a file with its authoritative position ' +
    'from the language server (Roslyn for C#, rust-analyzer for Rust, ' +
    'tsserver for TS, Pylance for Python, etc.). Returns name, kind ' +
    '(class / method / field / property / ...), parent container, and ' +
    '1-based line and column pointing at the identifier itself — not ' +
    'the enclosing block. Use this BEFORE `find_references` whenever ' +
    'you want to address a symbol by name in a known file: it removes ' +
    'the need to hand-count columns from a `read` output, which is ' +
    'fragile around generics, qualified types, and same-named ' +
    'tokens like `public Player Player;` (where the type and the ' +
    'field share a name). Supports an optional `nameContains` filter ' +
    'for files with hundreds of symbols.';

const TOOL_PROMPT_SNIPPET = 'List declarations in a file with authoritative LSP positions';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'Call this tool BEFORE `find_references`, `goto_definition`, or `hover` whenever you know the target file and the target symbol name. The returned (line, column) is authoritative — pass it straight into the next LSP tool instead of counting characters yourself. Skipping this step is the most common reason those tools resolve to the wrong symbol.',
    'When two declarations share a name in the same scope (e.g. `public Player Player;` — a type AND a field both called Player), filter by `kind`: pick `field` / `property` for instance members, `class` / `struct` for type references. The `kind` column in the result is the differentiator.',
    'Use `nameContains` (case-insensitive substring) to narrow down on big files. For example, `nameContains: "Init"` on a 500-symbol controller file returns just the initialization-related declarations.',
    'Symbols are listed in source order with a `depth` indicator and a `container` path (e.g. `Core.Inner`) so nested types and members read cleanly. Do not try to reconstruct the hierarchy from indentation in your `read` output — use `container` and `depth` here instead.',
    'If `providerStatus` is `no-provider`, no language extension is registered for this file\'s language. Suggest the user install the appropriate extension (C# / rust-analyzer / Pylance / ...).',
];

export function registerDocumentSymbolsTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_DOCUMENT_SYMBOLS,
        label: LABEL_DOCUMENT_SYMBOLS,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: DocumentSymbolsParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as DocumentSymbolsParams;
            return await runDocumentSymbols(typed);
        },
    });
}

async function runDocumentSymbols(params: DocumentSymbolsParams) {
    const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
    const nameFilter = params.nameContains?.toLowerCase();

    let uri: vscode.Uri;
    try {
        ({ uri } = resolveExplicitPosition(params.file, 1, 1));
    } catch (err) {
        return errorEnvelope((err as Error).message);
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const languageId = doc.languageId;

    const raw = await vscode.commands.executeCommand<unknown>(
        'vscode.executeDocumentSymbolProvider',
        uri,
    );

    const all = normalizeDocumentSymbols(raw, uri);
    const filtered = nameFilter
        ? all.filter((s) => s.name.toLowerCase().includes(nameFilter))
        : all;
    const totalCount = filtered.length;
    const truncated = totalCount > maxResults;
    const symbols = truncated ? filtered.slice(0, maxResults) : filtered;

    const providerStatus = all.length === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: DocumentSymbolsDetails = {
        providerStatus,
        file: displayFile(uri),
        languageId,
        totalCount,
        truncated,
        symbols,
    };

    return { content: [{ type: 'text' as const, text: formatText(details, nameFilter) }], details };
}

function displayFile(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) return vscode.workspace.asRelativePath(uri, false);
    return uri.fsPath ?? uri.toString();
}

function formatText(details: DocumentSymbolsDetails, nameFilter: string | undefined): string {
    if (details.providerStatus === 'no-provider') {
        return [
            `No language extension is active for "${details.languageId}".`,
            'Install the appropriate VS Code extension (e.g. C#, rust-analyzer, Pylance) and reload the window.',
        ].join('\n');
    }
    if (details.totalCount === 0) {
        return nameFilter
            ? `No declarations matching "${nameFilter}" in ${details.file}.`
            : `No declarations found in ${details.file}.`;
    }
    const header = details.truncated
        ? `${details.symbols.length} of ${details.totalCount} declarations (truncated):`
        : `${details.totalCount} declaration${details.totalCount === 1 ? '' : 's'}:`;
    const lines: string[] = [`File: ${details.file}`, header, ''];
    for (const s of details.symbols) {
        lines.push(formatSymbol(s));
    }
    return lines.join('\n');
}

function formatSymbol(s: NormalizedSymbol): string {
    const indent = '  '.repeat(s.depth);
    const container = s.container ? ` (in ${s.container})` : '';
    return `${indent}${s.kind} ${s.name}${container} @ ${s.line}:${s.column}`;
}

function errorEnvelope(message: string) {
    return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        details: { error: message },
    };
}
