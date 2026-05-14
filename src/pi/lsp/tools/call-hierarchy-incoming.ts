// `call_hierarchy_incoming` — wraps `vscode.prepareCallHierarchy` +
// `vscode.provideIncomingCalls`. Given a callable position (a method,
// function, or constructor), returns every function that INVOKES it,
// each annotated with the line(s) inside the caller's body where the
// call happens. Strictly narrower than `find_references`: only true
// CALLS, not field reads, type references, `nameof(...)`, or assignment.
//
// Two-step LSP protocol:
//   1. `prepareCallHierarchy(uri, pos)` → anchor item (the callable).
//   2. `provideIncomingCalls(anchor)`   → list of callers, each with
//      `from` (the caller's CallHierarchyItem) and `fromRanges`
//      (the line ranges inside the caller's body where the call site is).
//
// Server support: rust-analyzer, tsserver, Pylance, C# Dev Kit, gopls,
// clangd. NOT supported by the base `ms-dotnettools.csharp` extension
// (the OmniSharp-only mode). Tool description and empty-result message
// both surface this so the agent doesn't blame missing data on its own
// query when the real cause is a missing provider.

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
    CallHierarchyIncomingParamsSchema,
    type CallHierarchyEntry,
    type CallHierarchyIncomingDetails,
    type CallHierarchyIncomingParams,
    type CallSite,
    LABEL_CALL_HIERARCHY_INCOMING,
    TOOL_CALL_HIERARCHY_INCOMING,
} from '../types';

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_RESULTS = 100;

const TOOL_DESCRIPTION =
    'Find every function that CALLS the callable at a given file ' +
    'position via the active language server. USE THIS FOR "who calls ' +
    'method X", "trace callers of function Y", "find the entry points ' +
    'that reach Z" — strictly narrower than `find_references`: only ' +
    'true call sites are returned, not field reads, type references, ' +
    '`nameof(...)` mentions, or string occurrences. Each entry is a ' +
    'CALLER (with its own declaration `file:line:column` ready for ' +
    'follow-up tools) plus the call site(s) inside the caller\'s body ' +
    'where it invokes the anchor — every call site is shown with the ' +
    'match line marked `>` and `contextLines` of surrounding code. ' +
    'Anchor must be a callable (method / function / constructor); ' +
    'calling on a field, type, or keyword returns "no anchor at this ' +
    'position". Server support varies: rust-analyzer, tsserver, ' +
    'Pylance, C# Dev Kit (`ms-dotnettools.csdevkit`), gopls, and clangd ' +
    'support it; the OmniSharp-only `ms-dotnettools.csharp` extension ' +
    'does NOT — install C# Dev Kit if results are unexpectedly empty ' +
    'on a C# project. Address via (file, line, column) — preferred when ' +
    'you have a position from `document_symbols`, grep, or read — or ' +
    'via a symbol name; ambiguous resolutions return the candidate list.';

const TOOL_PROMPT_SNIPPET = 'List the functions that call a given callable (incoming calls)';

const TOOL_PROMPT_GUIDELINES: readonly string[] = [
    'BEFORE calling this tool, check the user\'s question. "Who CALLS X / who INVOKES X / who reaches X / what are the entry points to X" → this tool. "Where is X mentioned at all" → use `find_references` (broader: catches type refs, reads, writes, `nameof`, attribute uses, in addition to actual calls). "What does X do internally" / "what does X call" → use `call_hierarchy_outgoing`. "Where is X defined" → use `goto_definition`. The agent value of call_hierarchy over references is the same as a debugger\'s call-stack view vs. an editor\'s find-all-references: cleaner, fewer false matches, and grouped by caller.',
    'When you know the target file and the target callable\'s name, ALWAYS call `document_symbols` first to get the authoritative `(line, column)`, then pass it here. Hand-counting columns from a `read` is fragile around generics, attributes, decorators, and same-named tokens (e.g. `public Player Player()` where type and constructor share a name).',
    'ALWAYS read the four header lines before the entries: `Position:`, `Line: |...`, `Column: |...`, and `Resolved symbol at position:` / `Anchor: ...`. The `Anchor` line shows what `prepareCallHierarchy` actually resolved (e.g. `method Foo.Bar()` or `function update(state, ctx)`); if it does not match the symbol you intended, your column was off — adjust or pass `{symbol: "..."}` to re-anchor via workspace symbol search. The `>` marker in each snippet is the call site inside the caller.',
    'Each entry is one CALLER (one function that invokes the anchor). The entry header gives the caller\'s declaration `file:line:column` — feed that into `find_references` / `goto_definition` / `hover` / further `call_hierarchy_incoming` to walk up the call graph. `callSites:` lists the line(s) inside the caller\'s body where the call to the anchor appears; large callers can call the anchor multiple times (e.g. a wrapper retry loop).',
    'An empty result means one of: (a) the anchor really has no callers in the indexed code (private method only called by tests not yet loaded; constructor with implicit creation paths); (b) the position is not on a callable (field, type, keyword, parameter); (c) the language server does not implement call hierarchy. The output distinguishes these via `Anchor:` (present → had a callable, no callers found) vs. `No callable anchor at this position` (b/c). For (c), check `providerStatus`; for base C# extension specifically, suggest installing C# Dev Kit.',
    'External callers (`source: "external"`) point to read-only sources such as ~/.cargo/registry, ~/.nuget/packages, or node_modules. Treat them as informational unless the user is debugging the dependency itself.',
    'If `providerStatus` is `no-provider`, no language extension is registered for the file. Suggest the user install the appropriate extension; do not interpret an empty list as "no callers".',
];

export function registerCallHierarchyIncomingTool(api: ExtensionAPI): void {
    api.registerTool({
        name: TOOL_CALL_HIERARCHY_INCOMING,
        label: LABEL_CALL_HIERARCHY_INCOMING,
        description: TOOL_DESCRIPTION,
        promptSnippet: TOOL_PROMPT_SNIPPET,
        promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
        parameters: CallHierarchyIncomingParamsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const typed = params as unknown as CallHierarchyIncomingParams;
            return await runIncoming(typed);
        },
    });
}

async function runIncoming(params: CallHierarchyIncomingParams) {
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
        const details: CallHierarchyIncomingDetails = {
            providerStatus,
            languageId,
            totalCount: 0,
            truncated: false,
            callers: [],
            resolvedSymbol,
            queryFile: displayPath(uri),
            queryLine: pos.line + 1,
            queryColumn: pos.character + 1,
            queryLineText,
        };
        return { content: [{ type: 'text' as const, text: formatText(details) }], details };
    }

    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>(
        'vscode.provideIncomingCalls',
        anchor,
    );

    const fileCache = new Map<string, string[]>();
    const entries: CallHierarchyEntry[] = [];
    for (const c of calls ?? []) {
        if (!c || !c.from) continue;
        const callSites = await renderCallSites(c.from.uri, c.fromRanges ?? [], contextLines, fileCache);
        const selStart = c.from.selectionRange?.start ?? c.from.range?.start;
        entries.push({
            name: String(c.from.name ?? ''),
            kind: symbolKindToString(c.from.kind ?? 0),
            detail: String(c.from.detail ?? ''),
            file: displayPath(c.from.uri),
            line: (selStart?.line ?? 0) + 1,
            column: (selStart?.character ?? 0) + 1,
            source: classifySource(c.from.uri),
            callSites,
        });
    }

    const totalCount = entries.length;
    const truncated = totalCount > maxResults;
    const callers = truncated ? entries.slice(0, maxResults) : entries;

    const providerStatus = totalCount === 0
        ? detectProviderStatus(languageId)
        : 'ok';

    const details: CallHierarchyIncomingDetails = {
        providerStatus,
        languageId,
        totalCount,
        truncated,
        callers,
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

async function resolveTarget(params: CallHierarchyIncomingParams): Promise<ResolvedTarget> {
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

function formatQueryEcho(details: CallHierarchyIncomingDetails): string[] {
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

function formatText(details: CallHierarchyIncomingDetails): string {
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
            'Place the cursor on a method / function / constructor name. If you did, the language server may not implement call hierarchy (base `ms-dotnettools.csharp` does not — install C# Dev Kit). Fall back to `find_references` for a broader semantic match.',
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
            'No incoming calls found. The function may have no callers in the indexed code (private utility, constructor with implicit construction, entry point), OR the language server\'s call-hierarchy support is incomplete. Cross-check with `find_references` on the same position for a broader semantic match.',
        );
        return lines.join('\n');
    }

    const totalSites = details.callers.reduce((acc, c) => acc + c.callSites.length, 0);
    const countLine = details.truncated
        ? `${details.callers.length} of ${details.totalCount} callers (truncated; ${totalSites} call site${totalSites === 1 ? '' : 's'} in the shown subset). Each entry below is one CALLER; \`callSites\` show the line(s) inside that caller where the anchor is invoked, with \`>\` on the actual call line.`
        : `${details.totalCount} caller${details.totalCount === 1 ? '' : 's'} (${totalSites} call site${totalSites === 1 ? '' : 's'} total). Each entry below is one CALLER; \`callSites\` show the line(s) inside that caller where the anchor is invoked, with \`>\` on the actual call line.`;

    const lines: string[] = [];
    lines.push(...formatQueryEcho(details));
    lines.push(resolvedLine);
    lines.push(anchorLine);
    lines.push(countLine);
    lines.push('');
    for (const c of details.callers) {
        const tag = c.source === 'external' ? ' [external]' : '';
        const detailSuffix = c.detail ? ` — ${c.detail}` : '';
        lines.push(`${c.kind} ${c.name}${detailSuffix} @ ${c.file}:${c.line}:${c.column}${tag}`);
        for (const site of c.callSites) {
            lines.push(`  call site @ ${c.file}:${site.line}:${site.column}`);
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
