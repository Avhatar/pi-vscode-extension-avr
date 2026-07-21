# lsp-tools

## Stance

The LSP tools are **wrappers around `vscode.commands.executeCommand('vscode.executeXProvider', ...)`**. They don't run a language server themselves; they ask VS Code's already-loaded language extensions to answer. Two normalizations matter: **locations get 1-based line/column** for the agent (VS Code uses 0-based `Position`), and **symbols are flattened to depth+dotted-container** even when the provider returns a hierarchical `DocumentSymbol[]` (Roslyn) or a flat `SymbolInformation[]` (rust-analyzer). Uniform output regardless of server means the agent's downstream logic doesn't have to fork on language.

## Role

Factory [extension.ts:25](../../../../src/pi/lsp/extension.ts#L25) — `createLspExtension({ enabled })` returns a no-op when disabled; otherwise registers all nine tools.

Types [types.ts:1](../../../../src/pi/lsp/types.ts#L1):

- `ProviderStatus = 'ok' | 'no-provider'` — distinguishes "empty result" from "language extension not installed"
- `AccessKind = 'read' | 'write' | 'text' | 'unknown'` — for `find_references`
- `NormalizedLocation` — `{ file, line, column, snippet, source: 'workspace' | 'external', accessKind? }`
- `NormalizedSymbol` — `{ name, kind, container, file, line, column, depth }`
- `CallSite`, `CallHierarchyEntry` — for call hierarchies

Nine tools, each exported as `register<ToolName>Tool(api)`:

1. **find_references** [find-references.ts:70](../../../../src/pi/lsp/tools/find-references.ts#L70) — wraps `vscode.executeReferenceProvider`; default `maxResults = 200`; `includeAccessKind` (optional) calls `vscode.executeDocumentHighlights` once per file to classify read/write (N+1 cost).
2. **goto_definition** [goto-definition.ts:63](../../../../src/pi/lsp/tools/goto-definition.ts#L63) — wraps `vscode.executeDefinitionProvider`; default 4 context lines; handles multi-site returns (overloads, partial classes).
3. **hover** [hover.ts:56](../../../../src/pi/lsp/tools/hover.ts#L56) — wraps `vscode.executeHoverProvider`; returns markdown; cheapest tool at ~10 ms.
4. **document_symbols** [document-symbols.ts](../../../../src/pi/lsp/tools/document-symbols.ts) — wraps `vscode.executeDocumentSymbolProvider`; flattens both `DocumentSymbol[]` (hierarchical) and `SymbolInformation[]` (flat) with `depth` + dotted `container`; optional `nameContains` filter.
5. **workspace_symbols** [workspace-symbols.ts](../../../../src/pi/lsp/tools/workspace-symbols.ts) — wraps `vscode.executeWorkspaceSymbolProvider`; free-form query; optional `kindFilter`.
6. **find_implementations** [find-implementations.ts](../../../../src/pi/lsp/tools/find-implementations.ts) — wraps `vscode.executeImplementationProvider`; default 3 context lines, 100 max results.
7. **type_definition** [type-definition.ts](../../../../src/pi/lsp/tools/type-definition.ts) — wraps `vscode.executeTypeDefinitionProvider`; navigates to the *type* of a variable, not the variable's own declaration.
8. **call_hierarchy_incoming** [call-hierarchy-incoming.ts](../../../../src/pi/lsp/tools/call-hierarchy-incoming.ts) — two-step: `vscode.prepareCallHierarchy` → `vscode.provideIncomingCalls`; returns callers with their `callSites`.
9. **call_hierarchy_outgoing** [call-hierarchy-outgoing.ts](../../../../src/pi/lsp/tools/call-hierarchy-outgoing.ts) — two-step: `vscode.prepareCallHierarchy` → `vscode.provideOutgoingCalls`; returns callees with their `callSites`.

Helpers [helpers.ts](../../../../src/pi/lsp/helpers.ts):

- `detectProviderStatus(languageId)` [helpers.ts:50](../../../../src/pi/lsp/helpers.ts#L50) — checks `vscode.extensions.all` against `KNOWN_LANGUAGE_EXTENSIONS`.
- `normalizeLocations(raw, { contextLines, includeAccessKind? })` [helpers.ts:73](../../../../src/pi/lsp/helpers.ts#L73) — flattens `Location | LocationLink` union, reads snippets, optionally classifies access.
- `classifyAccess(refs)` [helpers.ts:123](../../../../src/pi/lsp/helpers.ts#L123) — groups by file, calls `executeDocumentHighlights` per file to tag read/write.
- `resolveExplicitPosition(file, line, column)` [helpers.ts:396](../../../../src/pi/lsp/helpers.ts#L396) — 1-based → 0-based `Position` conversion.
- `resolveSymbol(name)` [helpers.ts:445](../../../../src/pi/lsp/helpers.ts#L445) — calls `executeWorkspaceSymbolProvider`; canonicalizes to ≤20 matches; returns single / multiple / none.
- `normalizeDocumentSymbols(raw, uri)` [helpers.ts:493](../../../../src/pi/lsp/helpers.ts#L493) — walks hierarchical trees, produces flat depth-tagged list.
- `symbolKindToString(kind)` [helpers.ts:622](../../../../src/pi/lsp/helpers.ts#L622) — 24-case switch mapping `vscode.SymbolKind` integers to words.

Two addressing modes on every tool:

- **Explicit**: `file`, `line` (1-based), `column` (1-based).
- **Symbol**: `symbol` name only; resolved via workspace symbol search with ambiguity fallback.

## Keywords

**Types — public:**
- `ProviderStatus`, `AccessKind` — [types.ts:1](../../../../src/pi/lsp/types.ts#L1)
- `NormalizedLocation` — same file
- `NormalizedSymbol` — same file
- `CallSite`, `CallHierarchyEntry` — same file

**Methods — extension:**
- `createLspExtension(opts)` — [extension.ts:25](../../../../src/pi/lsp/extension.ts#L25)

**Methods — tools (all `register*Tool(api)`):**
- `registerFindReferencesTool` — [find-references.ts:70](../../../../src/pi/lsp/tools/find-references.ts#L70)
- `registerGotoDefinitionTool` — [goto-definition.ts:63](../../../../src/pi/lsp/tools/goto-definition.ts#L63)
- `registerHoverTool` — [hover.ts:56](../../../../src/pi/lsp/tools/hover.ts#L56)
- `registerDocumentSymbolsTool`, `registerWorkspaceSymbolsTool`
- `registerFindImplementationsTool`, `registerTypeDefinitionTool`
- `registerCallHierarchyIncomingTool`, `registerCallHierarchyOutgoingTool`

**Methods — helpers:**
- `detectProviderStatus(languageId)` — [helpers.ts:50](../../../../src/pi/lsp/helpers.ts#L50)
- `normalizeLocations(raw, opts)` — [helpers.ts:73](../../../../src/pi/lsp/helpers.ts#L73)
- `classifyAccess(refs)` — [helpers.ts:123](../../../../src/pi/lsp/helpers.ts#L123)
- `resolveExplicitPosition(file, line, column)` — [helpers.ts:396](../../../../src/pi/lsp/helpers.ts#L396)
- `resolveSymbol(name)` — [helpers.ts:445](../../../../src/pi/lsp/helpers.ts#L445)
- `normalizeDocumentSymbols(raw, uri)` — [helpers.ts:493](../../../../src/pi/lsp/helpers.ts#L493)
- `symbolKindToString(kind)` — [helpers.ts:622](../../../../src/pi/lsp/helpers.ts#L622)

**Attributes / markers:**
- Setting gate: `pi-code.lsp.enabled` (default `false`)
- Coordinate system: **1-based** on the agent side; **0-based** in VS Code internals; conversion is one-way at the boundary
- Default max results: `find_references` 200, `find_implementations` 100
- Default context lines: `goto_definition` 4, `find_implementations` 3

**Namespaces:**
- [src/pi/lsp/extension.ts](../../../../src/pi/lsp/extension.ts) — factory
- [src/pi/lsp/types.ts](../../../../src/pi/lsp/types.ts) — types
- [src/pi/lsp/helpers.ts](../../../../src/pi/lsp/helpers.ts) — shared normalization
- [src/pi/lsp/tools/](../../../../src/pi/lsp/tools/) — 9 tool implementations

## Lifecycle edges

**Depends on:**
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — the extension factory is one of the resource-loader factories.
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `pi-code.lsp.enabled` setting.
- [Part IV § vscode-session-platform](../../04-platform-adapters/vscode-session-platform/vscode-session-platform.md) — `SessionExtensionPort.createLspExtension` calls this factory.
## See also

- **Rule — 1-based coordinates on the agent side.** LSP internally is 0-based; the boundary conversion is `helpers.resolveExplicitPosition`. Do not slip 0-based coordinates into tool inputs or outputs.
- **Rule — normalize before returning.** Both hierarchical and flat symbol returns must flatten to `NormalizedSymbol[]`. The agent must not have to sniff the shape.
- **Pattern — two addressing modes.** Explicit (`file+line+column`) is preferred when the position is known; symbol-name mode is the fallback with an "ambiguous?" return path. Do not conflate.
- **Pattern — `no-provider` is distinct from empty results.** `detectProviderStatus` checks whether a language extension is actually installed; agents can distinguish "no references found" from "language server missing" and give a useful message.
- **Pitfall — `includeAccessKind` is N+1.** `executeDocumentHighlights` is one call per file grouping. On large ref sets (100+ files), this dominates. Do not enable by default; document the cost in the tool schema.
- **Pitfall — call hierarchy is two-step.** `prepareCallHierarchy` must succeed before the `provide*Calls` call; a symbol that doesn't produce a call hierarchy item returns an empty list, not an error.
- **Pattern — the tool list is stable.** Adding a tenth tool means a new file under [src/pi/lsp/tools/](../../../../src/pi/lsp/tools/), a `register*Tool` factory, and a mention in the setting description.
