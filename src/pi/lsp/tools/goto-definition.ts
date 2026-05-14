// `goto_definition` — wraps `vscode.executeDefinitionProvider`. Given a
// symbol position (or name), returns the location(s) where the symbol
// is declared, with surrounding code so the agent sees the signature
// and the start of the body without a follow-up `read`. Definitions
// for partial classes, overloaded methods, and some generated code can
// legitimately resolve to multiple sites — all are returned.
//
// Shares position-echo + resolved-symbol auto-probe with
// `find_references` so the agent gets identical sanity-check headers
// on both tools and can transfer its mental model 1:1 between them.

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
    type GotoDefinitionDetails,
    type GotoDefinitionParams,
    GotoDefinitionParamsSchema,
    LABEL_GOTO_DEFINITION,
    TOOL_GOTO_DEFINITION,
} from '../types';

const DEFAULT_CONTEXT_LINES = 4;

const TOOL_DESCRIPTION =
    'Jump to the definition site(s) of the symbol at a given file ' +
    'position via the active language server. USE THIS FOR "where is X ' +
    'declared / defined?" — NOT for "what is X?" (use `hover`, which ' +
    'returns the signature + docs directly without needing a file ' +
    'read). Returns each definition with file, line, column, and a ' +
    'snippet showing the signature plus a few lines of body. Most ' +
    'queries resolve to a single location, but partial classes, ' +
    'overloaded methods, and re-exports can legitimately produce ' +
    'multiple results — all are returned. External dependency ' +
    'definitions (cargo registry, NuGet decompiled sources, ' +
    'node_modules) are surfaced and annotated `[external]`. Address ' +
    'the symbol either via (file, line, column) — preferred when you ' +
    'have it from `document_symbols` or a prior grep/read — or via a ' +
    'symbol name; ambiguous name resolutions return the candidate ' +
    'list so you can pick.';

const TOOL_PROMPT_SNIPPET = 'Jump to the definition site of a symbol via the language server';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "Where is X DECLARED / DEFINED" → this tool. "What IS X / what does X do" → use `hover` instead (cheaper, no file read needed). "Where is X USED" → use `find_references`.',
    'When you know the target file and the target symbol name, prefer calling `document_symbols` first to get the authoritative `(line, column)`, then pass it here. Hand-counting columns from a `read` is fragile around same-named tokens and attribute targets.',
    'When you want to follow a TYPE mentioned in another tool\'s output (e.g. hover said `Player Core.Player { ... }` and you want to inspect the `Player` class itself), pass `{symbol: "Player"}` rather than trying to compute the column of the type token in some source line. If the name is ambiguous (type + field with the same name), the candidate list will let you pick the right one explicitly.',
    'ALWAYS read the three header lines before the result: `Position:`, `Line: |...`, `Column: |...`, and `Resolved symbol at position:`. The `Line` shows the actual source line at the column you sent; the `Column` line has a caret `^` under that exact column. The `Resolved symbol` shows what the language server saw there. If caret + resolved symbol do not match your intent, your column was off — adjust and retry, OR pass `{symbol: "..."}` to let the workspace symbol provider resolve it.',
    'The returned snippet shows the code at the definition site with `contextLines` of surrounding context (default 4). Use this when you need the signature or the start of the body. Increase `contextLines` for longer functions / multi-line declarations.',
    'Use `goto_definition` to read a callee\'s signature without doing a `read` of its file. The `Resolved symbol` header already gives you a one-liner hover; the snippet adds the actual source.',
    'Multiple results are normal for partial classes / overloads / re-exports — read all of them. Do not pick the first arbitrarily; explain to the user which definition is which (e.g. "two overloads, one for `int` and one for `string`").',
    'External dependency results (`source: "external"`) point to read-only sources such as ~/.cargo/registry, ~/.nuget/packages, or node_modules. They are valid definitions; treat them as informational unless the user is debugging the dependency itself.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension; do not interpret an empty result as "no definition".',
];

export function registerGotoDefinitionTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_GOTO_DEFINITION,
        label: LABEL_GOTO_DEFINITION,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: GotoDefinitionParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as GotoDefinitionParams;
            return await runGotoDefinition(typed);
        },
    });
}

async function runGotoDefinition(params: GotoDefinitionParams) {
    const contextLines = params.contextLines ?? DEFAULT_CONTEXT_LINES;

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
            'vscode.executeDefinitionProvider',
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

    const providerStatus = totalCount === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: GotoDefinitionDetails = {
        providerStatus,
        totalCount,
        results: normalized,
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

async function resolveTarget(params: GotoDefinitionParams): Promise<ResolvedTarget> {
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

function formatQueryEcho(details: GotoDefinitionDetails): string[] {
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

function formatText(details: GotoDefinitionDetails): string {
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
        ? 'No definition found.'
        : details.totalCount === 1
            ? '1 definition site:'
            : `${details.totalCount} definition sites (e.g. partial class / overloaded method):`;

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
