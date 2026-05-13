// `hover` — wraps `vscode.executeHoverProvider`. Returns the language
// server's full hover payload (signature + inferred type + doc
// comments) at a given position, in whatever markdown the server
// produces.
//
// This is the most info-dense LSP tool: one cheap call gives the agent
// enough to often answer "what is X?" without any further `read` or
// `find_references`. The same hover is used internally by
// `find_references` and `goto_definition` to populate their
// resolved-symbol header — this tool exposes the full payload (not
// just the first line) for direct queries.

import * as vscode from 'vscode';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
    detectProviderStatus,
    fetchHoverContent,
    resolveExplicitPosition,
    resolveSymbol,
    type SymbolCandidate,
} from '../helpers';
import {
    type HoverDetails,
    type HoverParams,
    HoverParamsSchema,
    LABEL_HOVER,
    TOOL_HOVER,
} from '../types';

const TOOL_DESCRIPTION =
    'Default tool for "what is X?" / "what does X do?" / "what type does ' +
    'X have?" questions. Returns the language server\'s full hover ' +
    'payload — signature, inferred type, parameter list, xml-doc / ' +
    'rustdoc / jsdoc — at a single position. Cheap (~10 ms) and dense: ' +
    'one call typically answers the whole question without any further ' +
    '`read`, `find_references`, or `goto_definition`. PREFER this tool ' +
    'over `find_references` / `goto_definition` whenever the user wants ' +
    'to UNDERSTAND a symbol rather than navigate to its uses or ' +
    'declaration. Address via (file, line, column) — preferred when you ' +
    'have a position from `document_symbols`, grep, or read — or via a ' +
    'symbol name; ambiguous resolutions return the candidate list.';

const TOOL_PROMPT_SNIPPET = 'Get signature + docs + type of a symbol via the language server';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'DEFAULT TOOL FOR UNDERSTANDING. If the user asks "what is X?", "what does X do?", "what type is X?", "what are the parameters of X?", "what does this attribute mean?" — call `hover` FIRST. Do not reach for `find_references` (that\'s for "where is X used") or `goto_definition` (that\'s for "where is X declared") on these questions. Hover returns the structured answer (signature + type + docs) directly in one cheap call.',
    'EXCEPTION — type-navigation requests go to `type_definition`, NOT hover. If the user says "give me the type of X", "show me the type of X", "open the type of X", "navigate to the type of variable X" (verbs of NAVIGATION/SEEING, not description), use `type_definition` — it jumps straight to the class / struct / interface declaration in one call. Hover only describes; it does not navigate. The literal word "type" in the question is not a hover signal by itself — read the verb.',
    'PREFER addressing by `{file, symbol: "X"}` when you know the target file: call `document_symbols` first to get the exact position of X, then pass `{file, line, column}` to `hover`. This is more reliable than guessing a column from raw text and avoids the type-vs-field-with-same-name pitfall.',
    'When you want to follow a TYPE mentioned in a previous hover result (e.g. hover on `Player Core.Player { ... }` told you the type is `Player`, and you now want to inspect that class), pass `{symbol: "Player"}` instead of trying to compute the column of the type token in some source line. The workspace symbol resolver handles type names directly; if ambiguous, the candidate list lets you pick.',
    'ALWAYS read the position-echo header (`Position:`, `Line: |...`, `Column: |...`) before trusting the hover content. If the caret lands on the wrong token, the hover describes a different symbol than you intended — adjust column, or use `document_symbols` to get the authoritative position.',
    'Hover content is markdown — code fences, paragraphs, links. Pass it through to the user as-is; it renders cleanly in chat. Do not strip formatting; the structure is informative.',
    'If hover returns empty for a position the user clearly intends as meaningful, the language server has no info for that exact column (e.g. cursor on whitespace, on a keyword, or inside a string literal). Adjust the column to land on the identifier.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension.',
];

export function registerHoverTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_HOVER,
        label: LABEL_HOVER,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: HoverParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as HoverParams;
            return await runHover(typed);
        },
    });
}

async function runHover(params: HoverParams) {
    const target = await resolveTarget(params);
    if (target.kind === 'error') {
        return errorEnvelope(target.message);
    }
    if (target.kind === 'multiple') {
        return ambiguousEnvelope(target.candidates);
    }

    const { uri, pos, languageId } = target;

    const queryDocPromise = vscode.workspace.openTextDocument(uri);
    const [content, queryDoc] = await Promise.all([
        fetchHoverContent(uri, pos),
        queryDocPromise,
    ]);
    const queryLineText = pos.line < queryDoc.lineCount
        ? queryDoc.lineAt(pos.line).text
        : '';

    const providerStatus = content.length === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: HoverDetails = {
        providerStatus,
        languageId,
        content,
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

async function resolveTarget(params: HoverParams): Promise<ResolvedTarget> {
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

function formatQueryEcho(details: HoverDetails): string[] {
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

function formatText(details: HoverDetails): string {
    if (details.providerStatus === 'no-provider') {
        return [
            `No language extension is active for "${details.languageId}".`,
            'Install the appropriate VS Code extension (e.g. C#, rust-analyzer, Pylance) and reload the window.',
        ].join('\n');
    }
    const echo = formatQueryEcho(details);
    if (details.content.length === 0) {
        return [...echo, '', 'No hover information available at this position. Adjust the column to land on an identifier.'].join('\n');
    }
    return [...echo, '', details.content].join('\n');
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
