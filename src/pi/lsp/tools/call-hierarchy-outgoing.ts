// `call_hierarchy_outgoing` — wraps `vscode.prepareCallHierarchy` +
// `vscode.provideOutgoingCalls`. Given a callable position (a method,
// function, or constructor), returns every callable IT invokes, each
// annotated with the line(s) inside the anchor's body where that
// outgoing call appears. Useful for "what does this function do?"
// queries without reading the whole body, and for tracing call chains
// downward (anchor → callee → callee's callees → ...).
//
// Two-step LSP protocol — same shape as the incoming variant, only the
// direction of the call edges is reversed:
//
//   1. `prepareCallHierarchy(uri, pos)` → anchor item (the callable).
//   2. `provideOutgoingCalls(anchor)`   → list of callees, each with
//      `to` (the callee's CallHierarchyItem) and `fromRanges` — the
//      line ranges INSIDE THE ANCHOR'S body where it invokes the
//      callee. (Important: fromRanges are relative to the anchor's
//      file, NOT the callee's.)
//
// Server support: same as the incoming variant — rust-analyzer,
// tsserver, Pylance, C# Dev Kit, gopls, clangd. Base
// `ms-dotnettools.csharp` does NOT support call hierarchy.

import * as vscode from 'vscode';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    classifySource,
    detectProviderStatus,
    displayPath,
    formatSnippetBlock,
    loadFileLines,
    prepareCallHierarchyItem,
    probeResolvedSymbol,
    resolveExplicitPosition,
    resolveSymbol,
    symbolKindToString,
    type SymbolCandidate,
} from '../helpers';
import {
    CallHierarchyOutgoingParamsSchema,
    type CallHierarchyEntry,
    type CallHierarchyOutgoingDetails,
    type CallHierarchyOutgoingParams,
    type CallSite,
    LABEL_CALL_HIERARCHY_OUTGOING,
    TOOL_CALL_HIERARCHY_OUTGOING,
} from '../types';

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_RESULTS = 100;

const TOOL_DESCRIPTION =
    'Find every function that the callable at a given file position ' +
    'CALLS via the active language server. USE THIS FOR "what does ' +
    'method X call internally?", "summarize what function Y does ' +
    'without reading it", "trace the call chain downward from Z" — ' +
    'strictly narrower than `find_references` on the body and cleaner ' +
    'than reading the full source: only true outgoing call edges are ' +
    'returned. Each entry is a CALLEE (with its own declaration ' +
    '`file:line:column` ready for follow-up tools) plus the call ' +
    'site(s) INSIDE THE ANCHOR\'S body where the call expression ' +
    'appears — every call site is shown with the match line marked ' +
    '`>` and `contextLines` of surrounding code. Anchor must be a ' +
    'callable (method / function / constructor); calling on a field, ' +
    'type, or keyword returns "no anchor at this position". Server ' +
    'support varies: rust-analyzer, tsserver, Pylance, C# Dev Kit ' +
    '(`ms-dotnettools.csdevkit`), gopls, and clangd support it; the ' +
    'OmniSharp-only `ms-dotnettools.csharp` extension does NOT — ' +
    'install C# Dev Kit if results are unexpectedly empty on a C# ' +
    'project. Address via (file, line, column) — preferred when you ' +
    'have a position from `document_symbols`, grep, or read — or via ' +
    'a symbol name; ambiguous resolutions return the candidate list.';

const TOOL_PROMPT_SNIPPET = 'List the functions that a given callable calls (outgoing calls)';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "What does X CALL / what does X INVOKE / what is X\'s call chain / summarize what X does" → this tool. "Who calls X" → use `call_hierarchy_incoming`. "Where is X mentioned" → use `find_references`. "Where is X defined" → use `goto_definition`. "What IS X" → use `hover`. The agent value here is "skim the function semantically": for a 200-line method, the outgoing call list is often a more useful summary than reading the body.',
    'When you know the target file and the target callable\'s name, ALWAYS call `document_symbols` first to get the authoritative `(line, column)`, then pass it here. Hand-counting columns from a `read` is fragile around generics, attributes, decorators, and same-named tokens.',
    'ALWAYS read the four header lines before the entries: `Position:`, `Line: |...`, `Column: |...`, and `Resolved symbol at position:` / `Anchor: ...`. The `Anchor` line shows what `prepareCallHierarchy` actually resolved. If it does not match the symbol you intended, your column was off — adjust or pass `{symbol: "..."}` to re-anchor via workspace symbol search. The `>` marker in each snippet is the call site INSIDE the anchor.',
    'Each entry is one CALLEE (one function that the anchor invokes). The entry header gives the callee\'s declaration `file:line:column` — feed that into `goto_definition` / `hover` / further `call_hierarchy_outgoing` to walk DOWN the call graph. `callSites:` lists the line(s) INSIDE THE ANCHOR\'S body where each callee is invoked; the same callee may appear multiple times (e.g. a helper called in a loop).',
    'External callees (`source: "external"`) point to call targets in read-only sources such as ~/.cargo/registry, ~/.nuget/packages, node_modules. These are typically framework / library functions the anchor relies on; treat them as informational unless the user is debugging the dependency itself.',
    'An empty result means one of: (a) the anchor really has no outgoing calls (a pure data accessor, a stub, a constructor whose body is just field assignments); (b) the position is not on a callable (field, type, keyword, parameter); (c) the language server does not implement call hierarchy. The output distinguishes these via `Anchor:` (present → had a callable, no callees found) vs. `No callable anchor at this position` (b/c). For (c), check `providerStatus`; for base C# extension specifically, suggest installing C# Dev Kit.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension; do not interpret an empty list as "no callees".',
];

export function registerCallHierarchyOutgoingTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_CALL_HIERARCHY_OUTGOING,
        label: LABEL_CALL_HIERARCHY_OUTGOING,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: CallHierarchyOutgoingParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as CallHierarchyOutgoingParams;
            return await runOutgoing(typed);
        },
    });
}

async function runOutgoing(params: CallHierarchyOutgoingParams) {
    const contextLines = params.contextLines ?? DEFAULT_CONTEXT_LINES;
    const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;

    const target = await resolveTarget(params);
    if (target.kind === 'error') return errorEnvelope(target.message);
    if (target.kind === 'multiple') return ambiguousEnvelope(target.candidates);
    const { uri, pos, languageId } = target;

    const queryDocPromise = vscode.workspace.openTextDocument(uri);
    const [resolvedSymbol, anchor, queryDoc] = await Promise.all([
        probeResolvedSymbol(uri, pos),
        prepareCallHierarchyItem(uri, pos),
        queryDocPromise,
    ]);
    const queryLineText = pos.line < queryDoc.lineCount
        ? queryDoc.lineAt(pos.line).text
        : '';

    if (!anchor) {
        const providerStatus = detectProviderStatus(languageId);
        const details: CallHierarchyOutgoingDetails = {
            providerStatus,
            languageId,
            totalCount: 0,
            truncated: false,
            callees: [],
            resolvedSymbol,
            queryFile: displayPath(uri),
            queryLine: pos.line + 1,
            queryColumn: pos.character + 1,
            queryLineText,
        };
        return { content: [{ type: 'text' as const, text: formatText(details) }], details };
    }

    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>(
        'vscode.provideOutgoingCalls',
        anchor,
    );

    // For outgoing calls, ALL `fromRanges` are inside the anchor's file
    // (the function whose body contains the call expressions). Pre-load
    // the anchor source once and reuse for every callee's snippets.
    const fileCache = new Map<string, string[]>();
    const anchorUri = anchor.uri;
    const entries: CallHierarchyEntry[] = [];
    for (const c of calls ?? []) {
        if (!c || !c.to) continue;
        const callSites = await renderCallSites(anchorUri, c.fromRanges ?? [], contextLines, fileCache);
        const selStart = c.to.selectionRange?.start ?? c.to.range?.start;
        entries.push({
            name: String(c.to.name ?? ''),
            kind: symbolKindToString(c.to.kind ?? 0),
            detail: String(c.to.detail ?? ''),
            file: displayPath(c.to.uri),
            line: (selStart?.line ?? 0) + 1,
            column: (selStart?.character ?? 0) + 1,
            source: classifySource(c.to.uri),
            callSites,
        });
    }

    const totalCount = entries.length;
    const truncated = totalCount > maxResults;
    const callees = truncated ? entries.slice(0, maxResults) : entries;

    const providerStatus = totalCount === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: CallHierarchyOutgoingDetails = {
        providerStatus,
        languageId,
        totalCount,
        truncated,
        callees,
        resolvedSymbol,
        anchorName: anchor.name,
        anchorKind: symbolKindToString(anchor.kind),
        anchorDetail: anchor.detail ?? '',
        queryFile: displayPath(uri),
        queryLine: pos.line + 1,
        queryColumn: pos.character + 1,
        queryLineText,
    };

    return { content: [{ type: 'text' as const, text: formatText(details) }], details };
}

async function renderCallSites(
    uri: vscode.Uri,
    ranges: readonly vscode.Range[],
    contextLines: number,
    fileCache: Map<string, string[]>,
): Promise<CallSite[]> {
    if (!ranges || ranges.length === 0) return [];
    const lines = await loadFileLines(uri, fileCache);
    return ranges.map((r) => ({
        line: (r.start.line ?? 0) + 1,
        column: (r.start.character ?? 0) + 1,
        snippet: formatSnippetBlock(lines, r.start.line ?? 0, contextLines),
    }));
}

type ResolvedTarget =
    | { kind: 'ok'; uri: vscode.Uri; pos: vscode.Position; languageId: string }
    | { kind: 'multiple'; candidates: SymbolCandidate[] }
    | { kind: 'error'; message: string };

async function resolveTarget(params: CallHierarchyOutgoingParams): Promise<ResolvedTarget> {
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

function formatQueryEcho(details: CallHierarchyOutgoingDetails): string[] {
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

function formatText(details: CallHierarchyOutgoingDetails): string {
    if (details.providerStatus === 'no-provider') {
        return [
            `No language extension is active for "${details.languageId}".`,
            'Install the appropriate VS Code extension (e.g. C# Dev Kit, rust-analyzer, Pylance) and reload the window.',
        ].join('\n');
    }

    const resolvedLine = details.resolvedSymbol
        ? `Resolved symbol at position: ${details.resolvedSymbol}`
        : 'Resolved symbol at position: <unknown — hover not available>';

    if (!details.anchorName) {
        const lines: string[] = [];
        lines.push(...formatQueryEcho(details));
        lines.push(resolvedLine);
        lines.push('No callable anchor at this position.');
        lines.push(
            'Place the cursor on a method / function / constructor name. If you did, the language server may not implement call hierarchy (base `ms-dotnettools.csharp` does not — install C# Dev Kit). Read the function body via `read` or use `find_references` on identifiers inside it for a broader semantic match.',
        );
        return lines.join('\n');
    }

    const anchorDetail = details.anchorDetail ? ` — ${details.anchorDetail}` : '';
    const anchorLine = `Anchor: ${details.anchorKind ?? 'callable'} ${details.anchorName}${anchorDetail}`;

    if (details.totalCount === 0) {
        const lines: string[] = [];
        lines.push(...formatQueryEcho(details));
        lines.push(resolvedLine);
        lines.push(anchorLine);
        lines.push(
            'No outgoing calls found. The function may have no internal call expressions (pure accessor, stub, constructor that only assigns fields), OR the language server\'s call-hierarchy support is incomplete. Cross-check by reading the body directly with `read`.',
        );
        return lines.join('\n');
    }

    const totalSites = details.callees.reduce((acc, c) => acc + c.callSites.length, 0);
    const countLine = details.truncated
        ? `${details.callees.length} of ${details.totalCount} callees (truncated; ${totalSites} call site${totalSites === 1 ? '' : 's'} in the shown subset). Each entry below is one CALLEE; \`callSites\` show the line(s) inside the anchor where it invokes that callee, with \`>\` on the actual call line.`
        : `${details.totalCount} callee${details.totalCount === 1 ? '' : 's'} (${totalSites} call site${totalSites === 1 ? '' : 's'} total). Each entry below is one CALLEE; \`callSites\` show the line(s) inside the anchor where it invokes that callee, with \`>\` on the actual call line.`;

    const lines: string[] = [];
    lines.push(...formatQueryEcho(details));
    lines.push(resolvedLine);
    lines.push(anchorLine);
    lines.push(countLine);
    lines.push('');
    for (const c of details.callees) {
        const tag = c.source === 'external' ? ' [external]' : '';
        const detailSuffix = c.detail ? ` — ${c.detail}` : '';
        lines.push(`${c.kind} ${c.name}${detailSuffix} @ ${c.file}:${c.line}:${c.column}${tag}`);
        for (const site of c.callSites) {
            lines.push(`  call site @ ${details.queryFile ?? c.file}:${site.line}:${site.column}`);
            lines.push(site.snippet);
        }
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
