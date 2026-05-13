// `type_definition` — wraps `vscode.executeTypeDefinitionProvider`. Given
// a position on a variable, property, parameter, or expression, returns
// the declaration of its TYPE (the class / struct / interface), not the
// declaration of the variable itself. Distinct from `goto_definition`:
//
//   - `goto_definition` on `var x = ...;` → the `var x` line.
//   - `type_definition` on the same `x`   → the `class Thing { ... }`.
//
// Shortcut for the "show me what type X has" workflow that would
// otherwise be `hover` (read signature) → `goto_definition({symbol: T})`
// — collapses two calls into one.
//
// Plumbing mirrors `goto_definition` exactly: same position-echo +
// resolved-symbol probe, same workspace/external annotation, same two
// addressing modes.

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
    type TypeDefinitionDetails,
    type TypeDefinitionParams,
    TypeDefinitionParamsSchema,
    LABEL_TYPE_DEFINITION,
    TOOL_TYPE_DEFINITION,
} from '../types';

const DEFAULT_CONTEXT_LINES = 4;

const TOOL_DESCRIPTION =
    'Jump to the type declaration of a variable / property / parameter ' +
    'at a given file position via the active language server. USE THIS ' +
    'FOR "give me the type of X", "show me the type of X", "where is ' +
    'the type of X defined", "navigate to the type of variable X", or ' +
    'any phrasing that asks to NAVIGATE to / SEE / OPEN the type — as ' +
    'opposed to "what type does X have" (just the name → use `hover`). ' +
    'When the user requests the TYPE of a variable they almost always ' +
    'want the class/struct/interface itself, not just its name printed ' +
    'back. Different from `goto_definition`: for `var x = ...`, ' +
    '`goto_definition` on `x` lands on the `var x` line; ' +
    '`type_definition` lands on the declaration of the type (the ' +
    '`class Thing { ... }`). Saves a hover + goto_definition round-trip ' +
    'when the type is the target, not the signature. Returns each ' +
    'type-definition site with file, line, column, and a snippet ' +
    'showing the type\'s declaration plus a few lines of body. ' +
    'External dependency types (cargo registry, NuGet, node_modules) ' +
    'are surfaced and annotated `[external]`. Address via (file, line, ' +
    'column) — preferred when you have a position from ' +
    '`document_symbols`, grep, or read — or via a symbol name; ' +
    'ambiguous resolutions return the candidate list. Returns empty ' +
    'when called on a symbol that has no type (e.g. a method name, a ' +
    'class name itself, a keyword) — in that case use `goto_definition` ' +
    'or `hover` instead.';

const TOOL_PROMPT_SNIPPET = 'Jump to the type declaration of a variable / property / parameter';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "Give me / show me / navigate to the TYPE of variable X" → this tool. "What type does X have" (just describe the type by name) → could be `hover`, but if the user follows up wanting the class itself, route here. "Where is X itself declared" (the variable, not its type) → use `goto_definition`. "Who implements / overrides X" → use `find_implementations`. The verbs "give me / show me / open / navigate / find the type" strongly imply navigation: prefer this tool over hover even when the literal word "type" is in the question.',
    'This tool is most useful on variables, properties, parameters, and expressions — anything that HAS a type. Calling it on a method name, a class name itself, or a keyword returns empty (those have no separate "type" to jump to). On an empty result, switch to `goto_definition` for the symbol itself or `hover` for context.',
    'When you know the target file and the target symbol name, ALWAYS call `document_symbols` first to get the authoritative `(line, column)`, then pass it here. Hand-counting columns from a `read` is fragile around generics, attributes, and same-named tokens.',
    'ALWAYS read the three header lines before the result: `Position:`, `Line: |...`, `Column: |...`, and `Resolved symbol at position:`. The `Line` shows the actual source line at the column you sent; the `Column` line has a caret `^` under that exact column. If the resolved symbol does not match the variable you intended, your column was off — adjust or pass `{symbol: "..."}`.',
    'External dependency results (`source: "external"`) point to type declarations in read-only sources such as ~/.cargo/registry, ~/.nuget/packages, or node_modules. They are valid type definitions; treat as informational unless the user is debugging the dependency itself.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension; do not interpret an empty list as "no type".',
];

export function registerTypeDefinitionTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_TYPE_DEFINITION,
        label: LABEL_TYPE_DEFINITION,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: TypeDefinitionParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as TypeDefinitionParams;
            return await runTypeDefinition(typed);
        },
    });
}

async function runTypeDefinition(params: TypeDefinitionParams) {
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
            'vscode.executeTypeDefinitionProvider',
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

    const details: TypeDefinitionDetails = {
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

async function resolveTarget(params: TypeDefinitionParams): Promise<ResolvedTarget> {
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

function formatQueryEcho(details: TypeDefinitionDetails): string[] {
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

function formatText(details: TypeDefinitionDetails): string {
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
        ? 'No type definition found. The symbol at this position may not have a separate type to jump to (e.g. method name, class name itself, keyword). Use `goto_definition` for the symbol itself or `hover` for context.'
        : details.totalCount === 1
            ? '1 type definition:'
            : `${details.totalCount} type definitions (multiple type-defs are rare; possibly a union / sum type):`;

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
