// `find_implementations` — wraps `vscode.executeImplementationProvider`.
// Given a symbol position on an interface, abstract member, or virtual
// method, returns every concrete implementation/override in the
// codebase. Complements `goto_definition` (which lands on the
// declaration) for OOP refactoring questions: "who implements IFoo?",
// "all overrides of Update()", "every class deriving from Card".
//
// Plumbing mirrors `goto_definition` exactly — same position-echo +
// resolved-symbol probe, same workspace/external annotation, same two
// addressing modes (explicit position or symbol name with ambiguity
// fallback). The only differences are the underlying LSP command and
// the default `contextLines` / `maxResults` tuned for the common case
// of multiple implementations.

import * as vscode from 'vscode';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    detectProviderStatus,
    normalizeLocations,
    probeResolvedSymbol,
    resolveExplicitPosition,
    resolveSymbol,
    type SymbolCandidate,
} from '../helpers';
import {
    type FindImplementationsDetails,
    type FindImplementationsParams,
    FindImplementationsParamsSchema,
    LABEL_FIND_IMPLEMENTATIONS,
    TOOL_FIND_IMPLEMENTATIONS,
} from '../types';

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_RESULTS = 100;

const TOOL_DESCRIPTION =
    'Find every concrete implementation or override of the symbol at a ' +
    'given file position via the active language server. USE THIS FOR ' +
    '"who implements IFoo?", "all overrides of method X", "every class ' +
    'deriving from abstract class Y" — NOT for "what is X?" (use ' +
    '`hover`), "where is X declared" (use `goto_definition` for the ' +
    'declaration itself), or "where is X used" (use `find_references` ' +
    'for all use sites, which is broader than implementations). ' +
    'Complements `goto_definition`: on an interface method, ' +
    'goto_definition lands on the interface declaration; ' +
    'find_implementations returns each implementing class\'s method. ' +
    'Each result has file, line, column, and a snippet identifying the ' +
    'implementing type. Multi-site is the common case here — interfaces ' +
    'usually have several implementations. External implementations ' +
    '(cargo registry, NuGet, node_modules) are annotated `[external]`. ' +
    'Address via (file, line, column) — preferred when you have a ' +
    'position from `document_symbols`, grep, or read — or via a symbol ' +
    'name; ambiguous resolutions return the candidate list.';

const TOOL_PROMPT_SNIPPET = 'Find all implementations or overrides of a symbol via the language server';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "Who implements / overrides X" → this tool. "What IS X / what does X do" → use `hover`. "Where is X declared" → use `goto_definition`. "Where is X USED" → use `find_references` (broader than implementations: includes call sites, reads, writes, and type references, not only concrete overrides).',
    'When you know the target file and the target symbol name, ALWAYS call `document_symbols` first to get the authoritative `(line, column)`, then pass it here. Hand-counting columns from a `read` is fragile around generics, attributes, and same-named tokens.',
    'When you want to follow a TYPE mentioned in another tool\'s output (e.g. hover said `Player Core.Player { ... }` and you want all subclasses of `Player`), pass `{symbol: "Player"}` rather than computing the column of the type token in some source line.',
    'ALWAYS read the three header lines before the entries: `Position:`, `Line: |...`, `Column: |...`, and `Resolved symbol at position:`. The `Line` shows the actual source line at the column you sent; the `Column` line has a caret `^` under that exact column. If the resolved symbol does not match the symbol you intended, your column was off — adjust or pass `{symbol: "..."}`.',
    'Each result is an IMPLEMENTING / OVERRIDING site — the file and line where a concrete class implements the interface member or overrides the virtual one. The snippet shows the implementing method or class declaration with `contextLines` of surrounding code (default 3, raise for more class context). Read the `>` line to see the actual override.',
    'External dependency results (`source: "external"`) point to implementations in read-only sources such as ~/.cargo/registry, ~/.nuget/packages, or node_modules. Treat them as informational unless the user is debugging the dependency itself.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension; do not interpret an empty list as "no implementations".',
];

export function registerFindImplementationsTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_FIND_IMPLEMENTATIONS,
        label: LABEL_FIND_IMPLEMENTATIONS,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: FindImplementationsParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as FindImplementationsParams;
            return await runFindImplementations(typed);
        },
    });
}

async function runFindImplementations(params: FindImplementationsParams) {
    const contextLines = params.contextLines ?? DEFAULT_CONTEXT_LINES;
    const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;

    const target = await resolveTarget(params);
    if (target.kind === 'error') {
        return errorEnvelope(target.message);
    }
    if (target.kind === 'multiple') {
        return ambiguousEnvelope(target.candidates);
    }

    const { uri, pos, languageId } = target;

    const queryDocPromise = vscode.workspace.openTextDocument(uri);
    const [resolvedSymbol, raw, queryDoc] = await Promise.all([
        probeResolvedSymbol(uri, pos),
        vscode.commands.executeCommand<unknown>(
            'vscode.executeImplementationProvider',
            uri,
            pos,
        ),
        queryDocPromise,
    ]);
    const queryLineText = pos.line < queryDoc.lineCount
        ? queryDoc.lineAt(pos.line).text
        : '';

    const normalized = await normalizeLocations(raw, { contextLines });
    const totalCount = normalized.length;
    const truncated = totalCount > maxResults;
    const results = truncated ? normalized.slice(0, maxResults) : normalized;

    const providerStatus = totalCount === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: FindImplementationsDetails = {
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

async function resolveTarget(params: FindImplementationsParams): Promise<ResolvedTarget> {
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
                message: `Symbol "${params.symbol}" not found via workspace symbol search. Pass an explicit file/line/column from a grep result or document_symbols instead.`,
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

function displayFile(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) return vscode.workspace.asRelativePath(uri, false);
    return uri.fsPath ?? uri.toString();
}

function formatQueryEcho(details: FindImplementationsDetails): string[] {
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

function formatText(details: FindImplementationsDetails): string {
    if (details.providerStatus === 'no-provider') {
        return [
            `No language extension is active for "${details.languageId}".`,
            'Install the appropriate VS Code extension (e.g. C#, rust-analyzer, Pylance) and reload the window.',
        ].join('\n');
    }
    const resolvedLine = details.resolvedSymbol
        ? `Resolved symbol at position: ${details.resolvedSymbol}`
        : 'Resolved symbol at position: <unknown — hover not available>';
    const countLine = details.totalCount === 0
        ? 'No implementations found. The symbol may be a concrete final method, a primitive type, or unimplemented; cross-check with `goto_definition` to confirm what the resolved symbol is.'
        : details.truncated
            ? `${details.results.length} of ${details.totalCount} implementations (truncated). Each entry is a concrete implementing / overriding site; the \`>\` line in the snippet is the actual match.`
            : `${details.totalCount} implementation${details.totalCount === 1 ? '' : 's'}. Each entry is a concrete implementing / overriding site; the \`>\` line in the snippet is the actual match.`;

    const lines: string[] = [];
    lines.push(...formatQueryEcho(details));
    lines.push(resolvedLine);
    lines.push(countLine);
    lines.push('');
    for (const r of details.results) {
        const tag = r.source === 'external' ? ' [external]' : '';
        lines.push(`${r.file}:${r.line}:${r.column}${tag}`);
        lines.push(r.snippet);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
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
