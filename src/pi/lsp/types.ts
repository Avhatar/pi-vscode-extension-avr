// Shared types and TypeBox schemas for the LSP tool surface. Every
// LLM-facing description string here doubles as prompt copy — keep tight
// and English. Schemas use TypeBox (same as the todo tool); the runtime
// passes `Static<typeof Schema>` shapes to `execute()` without casts.

import { type Static, Type } from 'typebox';

// Logical names used in the system prompt. Renaming requires updating
// allow-lists and any pinned references in user settings.
export const TOOL_FIND_REFERENCES = 'find_references';
export const LABEL_FIND_REFERENCES = 'Find References';
export const TOOL_DOCUMENT_SYMBOLS = 'document_symbols';
export const LABEL_DOCUMENT_SYMBOLS = 'Document Symbols';
export const TOOL_GOTO_DEFINITION = 'goto_definition';
export const LABEL_GOTO_DEFINITION = 'Go to Definition';
export const TOOL_HOVER = 'hover';
export const LABEL_HOVER = 'Hover';
export const TOOL_FIND_IMPLEMENTATIONS = 'find_implementations';
export const LABEL_FIND_IMPLEMENTATIONS = 'Find Implementations';
export const TOOL_TYPE_DEFINITION = 'type_definition';
export const LABEL_TYPE_DEFINITION = 'Type Definition';
export const TOOL_WORKSPACE_SYMBOLS = 'workspace_symbols';
export const LABEL_WORKSPACE_SYMBOLS = 'Workspace Symbols';
export const TOOL_CALL_HIERARCHY_INCOMING = 'call_hierarchy_incoming';
export const LABEL_CALL_HIERARCHY_INCOMING = 'Incoming Calls';
export const TOOL_CALL_HIERARCHY_OUTGOING = 'call_hierarchy_outgoing';
export const LABEL_CALL_HIERARCHY_OUTGOING = 'Outgoing Calls';

// Provider-status signal. VS Code silently returns `[]` when no language
// extension is registered for the active document — the agent would read
// that as "zero references" and draw the wrong conclusion. The
// normalization layer detects the no-provider case and surfaces it here.
export type ProviderStatus = 'ok' | 'no-provider';

// Per-reference access classification produced by the language server's
// `textDocument/documentHighlight` (Read | Write | Text). Populated only
// when `find_references` is called with `includeAccessKind: true`.
// `unknown` is used when the server didn't return a matching highlight
// for that range (e.g. external sources, or servers that don't
// implement documentHighlight).
export type AccessKind = 'read' | 'write' | 'text' | 'unknown';

// Normalized reference/definition/implementation entry. `file` is
// workspace-relative when the location is inside an open workspace
// folder, otherwise an absolute path (external dependency source such as
// `~/.cargo/registry/...` or `~/.nuget/packages/...`).
export interface NormalizedLocation {
    file: string;
    line: number;       // 1-based
    column: number;     // 1-based
    snippet: string;    // matched line + surrounding context, joined with \n
    source: 'workspace' | 'external';
    /** Present only when `includeAccessKind: true` was passed. */
    accessKind?: AccessKind;
}

export interface FindReferencesDetails {
    providerStatus: ProviderStatus;
    totalCount: number;
    truncated: boolean;
    results: NormalizedLocation[];
    languageId: string;
    /**
     * Hover-derived one-liner describing the symbol the language server
     * actually resolved at the requested position. Lets the agent
     * sanity-check that its column landed on the intended token (e.g.
     * `Player Core.Player { get; set; }` vs `attribute SerializeField`)
     * instead of guessing from snippet contents.
     */
    resolvedSymbol?: string;
    /**
     * The actual source line at the requested position, plus the 1-based
     * column the agent asked for. Renderable as line+caret to make any
     * tabs-vs-spaces / off-by-one mismatch immediately visible. The
     * agent reads this against `resolvedSymbol` to tell apart "I picked
     * the wrong column" from "the language server resolved this position
     * differently than I expected".
     */
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}

// Parameter schema. Two addressing modes:
//   (a) explicit position: file + line + column.
//   (b) symbol name: we resolve via executeWorkspaceSymbolProvider first
//       and, if exactly one match, use it. Multiple matches → return
//       candidate list and ask the agent to pass an explicit position.
//
// Both line and column are 1-based for ergonomics; we translate to LSP's
// 0-based Position internally.
export const FindReferencesParamsSchema = Type.Object({
    file: Type.Optional(
        Type.String({
            description:
                'Workspace-relative or absolute path to the file containing the symbol. Required together with line and column.',
        }),
    ),
    line: Type.Optional(
        Type.Number({
            description: '1-based line number of the symbol position.',
        }),
    ),
    column: Type.Optional(
        Type.Number({
            description: '1-based column number of the symbol position.',
        }),
    ),
    symbol: Type.Optional(
        Type.String({
            description:
                'Symbol name to find references to. Alternative to file/line/column. If multiple symbols match, the tool returns the candidate list and asks for an explicit position.',
        }),
    ),
    contextLines: Type.Optional(
        Type.Number({
            description:
                'Lines of surrounding context to include in each snippet (default 2).',
        }),
    ),
    maxResults: Type.Optional(
        Type.Number({
            description:
                'Maximum number of references to return (default 200; lower for popular framework symbols to keep payload size in check). When exceeded, `truncated: true` is set.',
        }),
    ),
    includeAccessKind: Type.Optional(
        Type.Boolean({
            description:
                'When true, each reference is tagged `accessKind: "read" | "write" | "text" | "unknown"` using the language server\'s document-highlight kind. Use this for queries like "where is the symbol assigned?" or "show me only reads". Costs N+1 LSP calls (one per file containing references), so leave off unless the read/write distinction is what you need.',
        }),
    ),
});

export type FindReferencesParams = Static<typeof FindReferencesParamsSchema>;

// `document_symbols` parameter schema. The only required input is the
// file path. We expose a `nameContains` filter so that an agent looking
// for a specific declaration (e.g. "the field named Player in Core.cs")
// does not have to scroll through a 200-line outline — common case on
// large source files.
export const DocumentSymbolsParamsSchema = Type.Object({
    file: Type.String({
        description:
            'Workspace-relative or absolute path to the file whose declarations should be listed.',
    }),
    nameContains: Type.Optional(
        Type.String({
            description:
                'Optional case-insensitive substring filter. When set, only symbols whose name contains this substring are returned. Useful for "find the declaration of X in Y" workflows.',
        }),
    ),
    maxResults: Type.Optional(
        Type.Number({
            description:
                'Maximum number of symbols to return (default 200). Outlines beyond this are truncated and `truncated: true` is set.',
        }),
    ),
});

export type DocumentSymbolsParams = Static<typeof DocumentSymbolsParamsSchema>;

/**
 * Normalized symbol entry for `document_symbols`. The agent's primary
 * use case is "give me the exact position of declaration X in file Y"
 * so it can pass that position to `find_references` / `goto_definition`
 * without hand-counting columns. `line` and `column` point at the
 * symbol's own identifier (LSP `selectionRange.start`), not the
 * enclosing block.
 *
 * `depth` is 0 for top-level declarations and increments for nested
 * members. Children of a class/struct/namespace are listed alongside
 * their parent with depth bumped — flatter to read than a tree and
 * lets the agent grep with a simple substring filter without losing
 * structural info.
 */
export interface NormalizedSymbol {
    name: string;
    kind: string;        // human-readable, e.g. "class" / "method" / "field"
    container: string;   // parent name(s) joined with ".", "" for top-level
    file: string;        // workspace-relative when possible
    line: number;        // 1-based, identifier start
    column: number;      // 1-based, identifier start
    depth: number;       // 0 = top-level, 1 = direct child, ...
}

export interface DocumentSymbolsDetails {
    providerStatus: ProviderStatus;
    file: string;
    languageId: string;
    totalCount: number;
    truncated: boolean;
    symbols: NormalizedSymbol[];
}

// `goto_definition` parameter schema. Same addressing modes as
// `find_references` (explicit position or symbol name with ambiguity
// fallback). Default `contextLines` is intentionally higher than
// references — when asking "where is X defined", the agent usually
// wants the signature + a few lines of body, not just the identifier.
export const GotoDefinitionParamsSchema = Type.Object({
    file: Type.Optional(
        Type.String({
            description:
                'Workspace-relative or absolute path to the file containing the symbol. Required together with line and column.',
        }),
    ),
    line: Type.Optional(
        Type.Number({
            description: '1-based line number of the symbol position.',
        }),
    ),
    column: Type.Optional(
        Type.Number({
            description: '1-based column number of the symbol position.',
        }),
    ),
    symbol: Type.Optional(
        Type.String({
            description:
                'Symbol name to jump to the definition of. Alternative to file/line/column. If multiple symbols match, the tool returns the candidate list and asks for an explicit position.',
        }),
    ),
    contextLines: Type.Optional(
        Type.Number({
            description:
                'Lines of surrounding context to include around the definition (default 4 — enough for a signature plus the start of the body in most cases).',
        }),
    ),
});

export type GotoDefinitionParams = Static<typeof GotoDefinitionParamsSchema>;

export interface GotoDefinitionDetails {
    providerStatus: ProviderStatus;
    totalCount: number;
    results: NormalizedLocation[];
    languageId: string;
    /** Hover-derived signature of the symbol at the requested position. */
    resolvedSymbol?: string;
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}

// `hover` parameter schema. Same two addressing modes as the rest of
// the LSP tools. No extra options — hover is intentionally minimal:
// you give a position, you get back signature + docs + inferred type
// in whatever markdown the language server produces.
export const HoverParamsSchema = Type.Object({
    file: Type.Optional(
        Type.String({
            description:
                'Workspace-relative or absolute path to the file containing the symbol. Required together with line and column.',
        }),
    ),
    line: Type.Optional(
        Type.Number({
            description: '1-based line number of the symbol position.',
        }),
    ),
    column: Type.Optional(
        Type.Number({
            description: '1-based column number of the symbol position.',
        }),
    ),
    symbol: Type.Optional(
        Type.String({
            description:
                'Symbol name to look up. Alternative to file/line/column. If multiple symbols match, the tool returns the candidate list and asks for an explicit position.',
        }),
    ),
});

export type HoverParams = Static<typeof HoverParamsSchema>;

export interface HoverDetails {
    providerStatus: ProviderStatus;
    languageId: string;
    /** Full hover content, as returned by the language server (markdown). */
    content: string;
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}

// `find_implementations` parameter schema. Same addressing modes as
// `find_references` / `goto_definition`. Default `contextLines` is
// generous because multi-site is the COMMON case here (every class
// implementing an interface returns its own line), and the agent
// usually needs to identify each implementation by its surrounding
// class context.
export const FindImplementationsParamsSchema = Type.Object({
    file: Type.Optional(
        Type.String({
            description:
                'Workspace-relative or absolute path to the file containing the symbol. Required together with line and column.',
        }),
    ),
    line: Type.Optional(
        Type.Number({
            description: '1-based line number of the symbol position.',
        }),
    ),
    column: Type.Optional(
        Type.Number({
            description: '1-based column number of the symbol position.',
        }),
    ),
    symbol: Type.Optional(
        Type.String({
            description:
                'Symbol name to find implementations of. Alternative to file/line/column. Ambiguous resolutions return the candidate list.',
        }),
    ),
    contextLines: Type.Optional(
        Type.Number({
            description:
                'Lines of surrounding context to include around each implementation (default 3 — enough to identify the implementing type without overwhelming the payload when there are many).',
        }),
    ),
    maxResults: Type.Optional(
        Type.Number({
            description:
                'Maximum number of implementations to return (default 100). When exceeded, `truncated: true` is set.',
        }),
    ),
});

export type FindImplementationsParams = Static<typeof FindImplementationsParamsSchema>;

export interface FindImplementationsDetails {
    providerStatus: ProviderStatus;
    totalCount: number;
    truncated: boolean;
    results: NormalizedLocation[];
    languageId: string;
    /** Hover-derived signature of the symbol at the requested position. */
    resolvedSymbol?: string;
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}

// `type_definition` parameter schema. Same addressing modes as the
// rest. Use case: agent has a variable / property / parameter and
// wants to navigate to its TYPE's declaration (the class / struct /
// interface), not the variable's own declaration. Common shortcut
// for "show me what type X has" without first reading hover and then
// looking up the type by name in a second call.
export const TypeDefinitionParamsSchema = Type.Object({
    file: Type.Optional(
        Type.String({
            description:
                'Workspace-relative or absolute path to the file containing the symbol. Required together with line and column.',
        }),
    ),
    line: Type.Optional(
        Type.Number({
            description: '1-based line number of the symbol position.',
        }),
    ),
    column: Type.Optional(
        Type.Number({
            description: '1-based column number of the symbol position.',
        }),
    ),
    symbol: Type.Optional(
        Type.String({
            description:
                'Symbol name to look up the type of. Alternative to file/line/column. Ambiguous resolutions return the candidate list.',
        }),
    ),
    contextLines: Type.Optional(
        Type.Number({
            description:
                'Lines of surrounding context to include around the type definition (default 4 — enough for a class / struct / interface declaration line plus the start of the body).',
        }),
    ),
});

export type TypeDefinitionParams = Static<typeof TypeDefinitionParamsSchema>;

export interface TypeDefinitionDetails {
    providerStatus: ProviderStatus;
    totalCount: number;
    results: NormalizedLocation[];
    languageId: string;
    /** Hover-derived signature of the symbol at the requested position. */
    resolvedSymbol?: string;
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}

// `workspace_symbols` parameter schema. Unlike the positional LSP
// tools, this one takes a free-form query string — the language
// server decides how to match (Roslyn uses CamelCase-segment matching;
// rust-analyzer uses substring; tsserver uses fuzzy). Optional
// `kindFilter` narrows by SymbolKind ("class", "method", "struct",
// "interface", ...) — useful when a short query like "Card" returns
// thousands of matches across kinds.
export const WorkspaceSymbolsParamsSchema = Type.Object({
    query: Type.String({
        description:
            'Search query. Server-specific matching rules apply: Roslyn favors CamelCase-segment matches (e.g. "PC" matches "PlayerController"); rust-analyzer / tsserver / Pylance use substring or fuzzy matching. Short queries can return thousands of results — combine with `kindFilter` to narrow by kind, or use a longer / more specific query.',
    }),
    kindFilter: Type.Optional(
        Type.Array(Type.String(), {
            description:
                'Restrict results to specific symbol kinds. Accepted values (case-insensitive): "class", "struct", "interface", "enum", "method", "function", "field", "property", "namespace", "module", "variable", "constant", "constructor", "event", "type-parameter". Empty / omitted means all kinds.',
        }),
    ),
    maxResults: Type.Optional(
        Type.Number({
            description:
                'Maximum number of symbols to return (default 50). Short queries on large projects can return hundreds; truncation is normal.',
        }),
    ),
});

export type WorkspaceSymbolsParams = Static<typeof WorkspaceSymbolsParamsSchema>;

export interface WorkspaceSymbolsDetails {
    providerStatus: ProviderStatus;
    query: string;
    totalCount: number;
    truncated: boolean;
    symbols: NormalizedSymbol[];
}

// `call_hierarchy_*` parameter schemas. Two tools (incoming + outgoing)
// share the exact same parameter shape — both anchor on a single
// callable position (the function whose callers / callees you want).
// Same two addressing modes as the other positional LSP tools: explicit
// (file, line, column) preferred when you have one, or `symbol` name
// with workspace-symbol resolution and ambiguity fallback.
//
// LSP itself splits these into two calls:
//
//   1. `prepareCallHierarchy(uri, pos)` → CallHierarchyItem (anchor)
//   2. `provideIncomingCalls(anchor)` → who calls anchor
//   2. `provideOutgoingCalls(anchor)` → what anchor calls
//
// Surface them as two tools because (a) the user/agent intent is
// genuinely different ("who calls me" vs "what do I call"), and (b) the
// LSP cost is paid per direction, so combining them would double the
// latency for the common case where only one direction is needed.
const callHierarchyBase = {
    file: Type.Optional(
        Type.String({
            description:
                'Workspace-relative or absolute path to the file containing the callable. Required together with line and column.',
        }),
    ),
    line: Type.Optional(
        Type.Number({
            description: '1-based line number of the callable\'s position.',
        }),
    ),
    column: Type.Optional(
        Type.Number({
            description: '1-based column number of the callable\'s position.',
        }),
    ),
    symbol: Type.Optional(
        Type.String({
            description:
                'Callable name (method / function / constructor). Alternative to file/line/column. Ambiguous resolutions return the candidate list.',
        }),
    ),
    contextLines: Type.Optional(
        Type.Number({
            description:
                'Lines of surrounding context to include around each call site (default 2).',
        }),
    ),
    maxResults: Type.Optional(
        Type.Number({
            description:
                'Maximum number of caller / callee entries to return (default 100). Hot functions can have hundreds of callers; tune down if the payload is overwhelming.',
        }),
    ),
};

export const CallHierarchyIncomingParamsSchema = Type.Object(callHierarchyBase);
export type CallHierarchyIncomingParams = Static<typeof CallHierarchyIncomingParamsSchema>;

export const CallHierarchyOutgoingParamsSchema = Type.Object(callHierarchyBase);
export type CallHierarchyOutgoingParams = Static<typeof CallHierarchyOutgoingParamsSchema>;

/**
 * One call site inside a caller (incoming) or inside the anchor function
 * (outgoing). Always points at the line where the call expression
 * occurs, with `contextLines` of surrounding code. 1-based line/column.
 */
export interface CallSite {
    line: number;
    column: number;
    snippet: string;
}

/**
 * One entry in a call-hierarchy result. For incoming calls, this is a
 * CALLER (the function that invokes the anchor); `callSites` are the
 * line(s) inside the caller's body where the call appears, and
 * `file/line/column` point at the caller's own declaration. For
 * outgoing calls, this is a CALLEE (a function invoked by the anchor);
 * `callSites` are the line(s) inside the ANCHOR's body where the
 * callee is invoked, and `file/line/column` point at the callee's
 * declaration.
 *
 * Either way, `file/line/column` is a position you can feed directly
 * into the next LSP tool (find_references, hover, document_symbols).
 */
export interface CallHierarchyEntry {
    name: string;
    kind: string;
    detail: string;     // signature line when the server provides one, otherwise ""
    file: string;       // declaration file, workspace-relative when possible
    line: number;       // 1-based, declaration position (selectionRange.start)
    column: number;
    source: 'workspace' | 'external';
    callSites: CallSite[];
}

export interface CallHierarchyIncomingDetails {
    providerStatus: ProviderStatus;
    languageId: string;
    totalCount: number;
    truncated: boolean;
    /** Each entry is a function that CALLS the anchor. */
    callers: CallHierarchyEntry[];
    /** Hover-derived signature of the symbol at the requested position. */
    resolvedSymbol?: string;
    /** Anchor identified by prepareCallHierarchy (echoed for transparency). */
    anchorName?: string;
    anchorKind?: string;
    anchorDetail?: string;
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}

export interface CallHierarchyOutgoingDetails {
    providerStatus: ProviderStatus;
    languageId: string;
    totalCount: number;
    truncated: boolean;
    /** Each entry is a function CALLED BY the anchor. */
    callees: CallHierarchyEntry[];
    /** Hover-derived signature of the symbol at the requested position. */
    resolvedSymbol?: string;
    /** Anchor identified by prepareCallHierarchy (echoed for transparency). */
    anchorName?: string;
    anchorKind?: string;
    anchorDetail?: string;
    queryFile?: string;
    queryLine?: number;
    queryColumn?: number;
    queryLineText?: string;
}
