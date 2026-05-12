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
