# LSP Integration — Semantic Code Navigation for the Agent

**Status:** Phase 1 read-only surface complete — `find_references`
(with optional read/write classification), `document_symbols`,
`goto_definition`, `hover`, `find_implementations`, `type_definition`,
`workspace_symbols`, `call_hierarchy_incoming`, and
`call_hierarchy_outgoing` shipped. All eight original Phase 1 tools
landed (call hierarchy split into two for clearer agent intent).
Setting `pi-code.lsp.enabled` defaults to **off** while we collect
real-world usage data.
**Owner:** —
**Scope:** expose Language Server Protocol primitives (find references, go to
definition, workspace/document symbols, etc.) as Pi tools, so the coding agent
gets semantically accurate cross-file information instead of relying on
grep + LLM inference.

## 0. Phase 1 status (current)

Implemented and live behind `pi-code.lsp.enabled`:

| Tool | Underlying VS Code command | Notes |
|---|---|---|
| `find_references` | `vscode.executeReferenceProvider` | Cross-file, includes external sources (`source: "external"`). Auto-probes `vscode.executeHoverProvider` for `resolvedSymbol` and echoes line + caret for the requested position so the agent can spot column/intent mismatches. Default `maxResults: 200`, `contextLines: 2`. |
| `find_references({includeAccessKind: true})` | + `vscode.executeDocumentHighlights` per file | Tags each result `read`/`write`/`text`/`unknown` using the language server's authoritative kind; header surfaces breakdown counts. Costs N+1 LSP calls (1 per file with references). Opt-in to keep default queries cheap. |
| `document_symbols` | `vscode.executeDocumentSymbolProvider` | Returns flat list of declarations with `name`, `kind`, `container`, `depth`, and authoritative `(line, column)` from the language server — so the agent can address symbols by name without hand-counting columns from raw `read` output. Optional case-insensitive `nameContains` filter. Handles both hierarchical `DocumentSymbol[]` (Roslyn) and flat `SymbolInformation[]` (rust-analyzer). |
| `goto_definition` | `vscode.executeDefinitionProvider` | Returns each definition site of the symbol at the requested position with file, line, column, and a snippet showing the signature plus surrounding context (default 4 lines). Handles legitimate multi-site results (partial classes, overloaded methods, re-exports). External dependency definitions annotated `[external]`. Same `(file,line,column)` or `symbol`-name addressing as `find_references`, with identical position-echo + resolved-symbol headers. |
| `hover` | `vscode.executeHoverProvider` | Returns the full hover payload (signature + inferred type + doc comments) at the requested position. Most info-dense LSP tool: ~10 ms per call, output is the language server's markdown. Same `(file,line,column)` or `symbol`-name addressing. Use BEFORE `goto_definition` when the agent only needs to understand a symbol, not navigate to it. |
| `find_implementations` | `vscode.executeImplementationProvider` | Returns every concrete implementation or override of the symbol at the requested position. Complements `goto_definition`: on an interface method, definition lands on the interface declaration, implementations returns each implementing class's method. Default `contextLines: 3`, `maxResults: 100`. External implementations annotated `[external]`. Same addressing modes as the other LSP tools. |
| `type_definition` | `vscode.executeTypeDefinitionProvider` | Jumps to the type declaration of a variable / property / parameter — not the variable's own declaration. For `var x = GetThing();`, `goto_definition` on `x` lands on the variable, `type_definition` lands on `class Thing`. Returns empty when called on a symbol that has no type (method, class name itself, keyword). Default `contextLines: 4`. Same gating and addressing as the other LSP tools. |
| `workspace_symbols` | `vscode.executeWorkspaceSymbolProvider` | Cross-file discovery: free-form query against the whole workspace. Returns flat list of matches with `name`, `kind`, `container`, and authoritative `(file, line, column)`. Optional `kindFilter` (e.g. `["class","interface"]`) narrows short queries. Default `maxResults: 50`. Documented caveat: Roslyn occasionally drops valid matches for some queries — empty result does not necessarily mean the symbol is missing; agent should grep before concluding. |
| `call_hierarchy_incoming` | `vscode.prepareCallHierarchy` + `vscode.provideIncomingCalls` | Two-step protocol: `prepareCallHierarchy(uri, pos)` resolves the callable anchor, `provideIncomingCalls` returns every function that invokes it. Strictly narrower than `find_references`: only true call sites are returned, not field reads, type refs, `nameof`, attribute uses. Each entry is one CALLER with its own declaration `(file, line, column)` and the call site line(s) inside the caller's body (each marked `>`). Default `contextLines: 2`, `maxResults: 100`. Server support: rust-analyzer, tsserver, Pylance, C# Dev Kit, gopls, clangd. The OmniSharp-only `ms-dotnettools.csharp` extension does NOT support call hierarchy — empty results on C# usually mean the user is on the wrong extension. |
| `call_hierarchy_outgoing` | `vscode.prepareCallHierarchy` + `vscode.provideOutgoingCalls` | Mirror direction: every function that the anchor CALLS. `fromRanges` are relative to the anchor's file, not the callee's; the tool reads the anchor source once and produces a snippet per call site. Useful for "summarize what X does" without reading the full body, and for walking the call graph downward. Same defaults, same provider caveats as the incoming variant. |

Verified against:
- **C#** via `ms-dotnettools.csharp` (Roslyn) on a large commercial Unity solution.
- **Rust** via `rust-lang.rust-analyzer` on a Bevy/Rust project.

### Defaults (rationale)

`pi-code.lsp.enabled` is **off** by default. Reasoning:

- Adds ~1.5–2 KB of tool descriptions + guidelines to the system prompt for
  every session, even sessions that never touch C# / Rust / TS. The cost is
  small but non-zero, and unused tools dilute attention.
- On simple counting / scope queries grep can be cheaper (~3K tokens
  delta observed in benchmark) and is good enough when name collisions
  aren't an issue. LSP wins on semantic accuracy + read/write
  classification, not on raw cost.
- We want explicit opt-in from users who actually work in those
  ecosystems and can confirm a language extension is installed.

Surface via VS Code Settings UI (`pi-code.lsp.enabled`) and our own
Settings Panel under "Tool Execution → Language Server tools".

### Empirical token-cost observations (single query: "count references to field Player in Core.cs")

| Mode | Total tokens | Notes |
|---|---|---|
| grep only | 19,683 | One turn, one ripgrep, manual count. |
| LSP, pre-fixes | 32,690 | Hit SerializeField quirk → retry → truncation @ 50 → retry → manual read/write classification. |
| LSP, after Phase 1 fixes | (pending re-measure) | `maxResults: 200` default + `document_symbols` + `includeAccessKind` should close most of the gap. |

The non-trivial gap with pre-fix LSP turned out to be fixable, not
architectural. Document-symbols removes column counting; access-kind
classification removes read/write grep verification; raised
`maxResults` removes truncation retries.

### Lessons captured in tool design (carried over from iterations)

- **Position echo + resolved symbol** in every `find_references` response.
  Agent sees `Position: ...`, `Line: |source`, `Column: |   ^`,
  `Resolved symbol at position: <hover signature>`. This single addition
  turned "agent loops on columns trying to find the right token" into
  "agent recognizes mismatch on first try".
- **Three-scenario playbook for position mismatch:** (1) caret + resolved
  agree → proceed. (2) caret on wrong token → adjust column. (3) caret
  right but resolved unrelated (Roslyn `[field: ...]` quirk) → switch
  to `{symbol: name}` form; if that also fails, only THEN grep.
- **Match-line marker `>`** in snippets with line numbers, so the agent
  doesn't try to infer which line in a 5-line context is the actual
  match.
- **`document_symbols` before `find_references`** for any "address symbol
  X in file Y" workflow — eliminates column counting from `read`
  output. Especially important on declarations like `public Player
  Player;` where type and field share a name.
- **`includeAccessKind`** is the answer to "where is X assigned?" — not
  heuristic regex over snippets (would be language-specific) but the
  language server's own document-highlight kind.

---

## 0.5. Prompt-engineering lessons (load-bearing, don't soften)

Iteration showed that the agent's tool-selection priors do NOT match the
optimal workflow unless we steer them explicitly. Soft hints ("preferred
when…") get ignored. Directive language ("DEFAULT TOOL FOR X", "BEFORE
calling, ask…", "DO NOT reach for Y for this question") works.

The patterns below cost real tokens every time they fail. Each one was
observed at least once in benchmark runs and fixed via prompt copy.

### Pattern 1 — agent forgets `document_symbols` is the entry point

Observed behavior: user asks "where is field X used in Y.cs". Agent
opens `read` on Y.cs, mentally counts columns to the identifier,
passes (line, column) to `find_references`. Column lands on the wrong
token (a keyword, an attribute, a same-named type) and the whole
chain derails.

Root cause: agent's default workflow is `read` → manual column → LSP
tool. We want `read` (optional) → `document_symbols` → LSP tool.

Mitigation in code: every LSP tool's first guideline now mentions
`document_symbols` by name as the way to get the authoritative
`(line, column)`. The `document_symbols` tool's own first guideline
says "Call this BEFORE find_references, goto_definition, or hover
whenever you know the target file and the target symbol name."

When extending: any new LSP tool that takes a `(file, line, column)`
must repeat this directive in its guidelines. Soft references like
"prefer when you have a position" are not enough — the agent will
ignore them and column-guess from `read`.

### Pattern 2 — agent picks `find_references` for "what is X?" questions

Observed behavior: user asks "what does field X do" or "what type is
X". Agent calls `find_references` and then tries to infer meaning
from the snippets at use sites. Three reasons this fails: (a)
find_references is the most expensive LSP tool, (b) snippets are
fragments, not signatures, (c) the agent ends up reading 5–10 files
anyway.

Root cause: model priors. Across LLMs `find_references` is the most
famous LSP operation, so it becomes the default reach for any
"investigate X" prompt regardless of whether navigation or
understanding is the actual goal.

Mitigation in code: `hover`'s description literally calls itself
"DEFAULT TOOL FOR UNDERSTANDING". Its guidelines explicitly enumerate
the user-question patterns it owns: "what is X?", "what does X do?",
"what type is X?", "what are the parameters of X?". `find_references`
and `goto_definition` descriptions counter-route: "USE THIS FOR
\"where is X used\" — NOT for \"what is X?\" (use hover)".

When extending: every new tool description must declare what
question class it owns AND what neighboring questions it does NOT
own (with the redirect). Without explicit anti-pattern guidance the
agent uses the closest-sounding tool name regardless of cost.

### Pattern 3 — agent counts columns when following a type reference

Observed behavior: hover returned `Player Core.Player { get; ... }`.
Agent wanted to inspect the `Player` class itself, manually
counted columns in `public Player Player;` to point at the type
token, landed on `public` keyword, got `No definition found`.

Root cause: no obvious LSP affordance for "follow a type mentioned
in another tool's output". Agent reaches for column-counting because
it's familiar.

Mitigation in code: `goto_definition` and `hover` both have a
guideline: "When you want to follow a TYPE mentioned in another
tool's output, pass `{symbol: TypeName}` rather than computing the
column of the type token in some source line."

When extending: any tool whose output references OTHER symbols by
name (e.g. hover signature mentions a type, find_references snippets
mention call targets) should remind the agent that follow-up
inspection uses `{symbol: ...}` form, not column arithmetic.

### Tool-routing decision table (the canonical orientation)

This table is the contract the system prompt collectively enforces.
If a new tool overlaps a row, it must explicitly defer to the
incumbent in its own description.

| User question shape | Tool to call FIRST |
|---|---|
| "What is X / what does X do / what type is X?" | `hover` |
| "Where is the TYPE of variable X declared?" | `type_definition` |
| "Where is X declared / defined?" | `goto_definition` |
| "Where is X used / called / written?" | `find_references` |
| "Where is X assigned vs read?" | `find_references({includeAccessKind: true})` |
| "What's in this file / does it have X?" | `document_symbols` |
| "I know file + symbol name, give me a position" | `document_symbols` (precondition for any positional LSP tool) |
| "Find class/method named X somewhere" | `workspace_symbols` |
| "All implementations of interface IFoo / overrides of method X" | `find_implementations` |

### Discoverability constraint

Pi tool registration has no "tool-group prefix" hook — each tool's
description and guidelines are independent and the agent sees them as
a flat list. We cannot factor the routing table into one shared
preamble. The duplication across tools (each one referencing
neighbors) is therefore deliberate and load-bearing — do not "DRY"
the routing copy by removing cross-references between tools.

---

## 0.6. Pickup notes (where to resume next session)

Last working session ended **2026-05-13**. State of the world:

- All shipped tools verified end-to-end on C# (Unity solution at
  `x:\Projects\TDNB_repo\TDNB_UnityProject\`) and Rust
  (`x:\Projects\Bevy\SpaceSystemSimulationBevyRust\`).
- Latest measured benchmark (query: "Что делает поле Player в
  Core.cs"): **~12,068 tokens** through the right workflow
  (`document_symbols` → `hover`). Down from 31,143 tokens in the
  prior iteration that used `find_references` incorrectly. Confirmed
  routing-prompt improvements are doing their job.
- Setting `pi-code.lsp.enabled` is **off** by default; tester
  manually enables it via Settings Panel → Tool Execution → Language
  Server tools.

**Next planned work, ordered by value:**

1. **Unit tests** for `normalizeLocations`,
   `normalizeDocumentSymbols`, `normalizeWorkspaceSymbols`,
   `classifyAccess`, `resolveSymbol`, and now
   `prepareCallHierarchyItem` / call-site rendering. Currently all the
   LSP code is behind manual smoke only — worth adding before the next
   refactor. With the two call-hierarchy tools landed there's a new
   shared seam (`loadFileLines`, `formatSnippetBlock`) that benefits
   from regression coverage.
2. **Benchmark re-run** for the "count references to Player"
   query with all fixes applied, to publish the final
   LSP-vs-grep cost number in §0.
3. **Smoke call hierarchy on C# Dev Kit + tsserver.** Verified
   behaviour during implementation on rust-analyzer (the design-doc
   "4 s for 32 callers" anchor still holds); the base `ms-dotnettools.csharp`
   path is confirmed unsupported. Need at least one positive C# Dev Kit
   run and one TypeScript run before declaring the tool stable across
   ecosystems.
4. **Test workspace_symbols on non-C# languages.** The Roslyn caveat
   is documented; rust-analyzer / Pylance / tsserver may behave
   differently. A short smoke pass on each would let us soften or
   sharpen the prompt copy per server.

**Hot files for the next session** (everything needed is here, no
context required from chat):

- [src/pi/lsp/extension.ts](../src/pi/lsp/extension.ts) — factory + tool
  registration; add new `registerXxxTool(pi)` line here.
- [src/pi/lsp/types.ts](../src/pi/lsp/types.ts) — TypeBox schemas + tool
  name/label constants + result-detail interfaces.
- [src/pi/lsp/helpers.ts](../src/pi/lsp/helpers.ts) — `resolveSymbol`,
  `normalizeLocations`, `probeResolvedSymbol`, `fetchHoverContent`,
  `detectProviderStatus`, `classifyAccess`,
  `normalizeDocumentSymbols`, `resolveExplicitPosition`,
  `symbolKindToString`. Reuse these in any new tool; don't rewrite.
- [src/pi/lsp/tools/goto-definition.ts](../src/pi/lsp/tools/goto-definition.ts)
  — cleanest template for a new positional LSP tool. Copy + adapt for
  `find_implementations` (`vscode.executeImplementationProvider`) and
  `type_definition` (`vscode.executeTypeDefinitionProvider`).
- [src/pi/lsp/tools/hover.ts](../src/pi/lsp/tools/hover.ts) — template for
  tools that return raw markdown rather than `NormalizedLocation[]`.
- [src/dev/lsp-smoke.ts](../src/dev/lsp-smoke.ts) — temporary diagnostic
  command, still wired. Useful for verifying a new provider's response
  shape on real projects before writing the tool.

**Workflow shortcut for adding a new positional LSP tool:**

1. Add `TOOL_X` + `LABEL_X` constants + `XParamsSchema` +
   `XDetails` in [types.ts](../src/pi/lsp/types.ts).
2. Copy [goto-definition.ts](../src/pi/lsp/tools/goto-definition.ts)
   to `tools/x.ts`, rename, swap the LSP command string, adjust
   `TOOL_DESCRIPTION` / `TOOL_PROMPT_GUIDELINES` (mind §0.5 patterns).
3. Add `registerXTool(pi)` to
   [extension.ts](../src/pi/lsp/extension.ts).
4. CHANGELOG entry + this doc's tool table + Phase 1 task list.
5. `npm run compile && npx tsc --noEmit` to verify.
6. Reload Dev Host → new chat (system prompt only refreshes on new
   sessions) → manual smoke.

---

## 1. Goal

Give the agent ground-truth answers to questions that grep cannot answer
reliably on a real codebase:

- "Who calls this method?" (call graph)
- "Where is this symbol defined?"
- "All implementations of this interface."
- "Find the class named X anywhere in the workspace."
- "What does this expression resolve to?" (hover)

These are the operations where an LLM with text-only tools (grep, read)
structurally underperforms: it produces false positives in comments,
strings, unrelated symbols with the same name, and cannot follow inheritance
or overrides without re-reading every candidate file.

The feature is language-agnostic by design (see §3): the same tools work for
C#, TypeScript, Python, Go, Rust, and any other language whose VS Code
extension registers standard providers.

## 2. Research summary

### 2.1 What "free" .NET / Roslyn tooling already covers

Before deciding to integrate ReSharper or Rider, we audited what the
standard .NET toolchain delivers without any JetBrains product installed:

| Capability                              | Already available via                                            |
| --------------------------------------- | ---------------------------------------------------------------- |
| Compile diagnostics with file:line      | `dotnet build` → structured output                               |
| Inspection rules (style, NRE, async)    | Roslyn analyzers (in-box + StyleCop/Sonar/Meziantou via NuGet)   |
| Formatting + style fixes                | `dotnet format`                                                  |
| Find references / definition            | OmniSharp / C# Dev Kit LSP servers                               |
| Safe rename                             | OmniSharp / C# Dev Kit                                           |
| Test execution                          | `dotnet test`                                                    |

Roughly 70–80 % of what "wiring ReSharper into the agent" sounded like it
would buy is actually delivered by the .NET SDK + Roslyn analyzers. The
JetBrains-only delta is narrower than first assumed:

- Unity-aware analyzers (depth not matched by community Roslyn analyzers)
- Solution-Wide Analysis (cross-project dead public API)
- Code duplication detection (semantic, not textual)
- External annotations for libraries without NRT

That delta belongs to a later phase (Rider MCP bridge). The first phase is
the universal LSP layer, which gives the biggest leverage and benefits every
language, not just C#.

### 2.2 Why the agent benefits from LSP primitives (vs. grep + LLM)

| LLM structural weakness                                              | LSP primitive that closes the gap     |
| -------------------------------------------------------------------- | ------------------------------------- |
| Cannot disambiguate symbols with the same name across types          | `findReferences` (filters by symbol)  |
| Cannot follow inheritance / overrides reliably                       | `findImplementations`, `goToDefinition` |
| Wastes tokens reading every candidate file to confirm a usage        | `findReferences` returns exact loci   |
| Grep produces false positives in strings/comments/`nameof`           | LSP results are semantic              |
| Cannot answer "where is class X" without scanning the tree           | `workspaceSymbols`                    |
| Cannot enumerate members of a type without reading it                | `documentSymbols`                     |
| Cannot reliably rename across solution (overrides, partials, XAML)   | `executeRenameProvider` (later phase) |

### 2.3 Architectural decision: **VS Code Provider API, not our own LSP**

Two options for getting LSP data:

**A. Spawn our own OmniSharp / Roslyn / pyright / etc. process per language.**
Rejected:

- 200 MB binary per language; bundle vs. lazy-download both painful.
- Stateful lifecycle (`initialize`, `didOpen`/`didChange`, indexing).
- First-call latency: tens of seconds to minutes on large solutions.
- Conflicts with any LSP the user already runs (C# Dev Kit, rust-analyzer,
  etc.) on file locks and CPU.
- Locks us to per-language implementations.

**B. Use VS Code's built-in command surface that dispatches to whichever
language extension is registered.** Chosen.

```ts
vscode.commands.executeCommand('vscode.executeReferenceProvider',     uri, position)
vscode.commands.executeCommand('vscode.executeDefinitionProvider',    uri, position)
vscode.commands.executeCommand('vscode.executeImplementationProvider',uri, position)
vscode.commands.executeCommand('vscode.executeTypeDefinitionProvider',uri, position)
vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)
vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri)
vscode.commands.executeCommand('vscode.executeHoverProvider',         uri, position)
vscode.commands.executeCommand('vscode.prepareCallHierarchy',         uri, position)
vscode.commands.executeCommand('vscode.executeRenameProvider',        uri, position, newName)
```

VS Code routes each call to the language extension registered under the
file's language id. Result: **one tool surface that works for every
language the user has set up.** Zero LSP server management on our side.

### 2.4 Tool registration approach

Pi extensions distributed as npm packages (the `pi-web-access` style — see
[src/pi/bundled-packages.ts](../src/pi/bundled-packages.ts)) cannot import
`vscode` — they run in Pi's runtime, not VS Code's extension host module
scope.

Instead, use the **in-tree extension factory** pattern already in the
codebase: see [createTodoExtension](../src/pi/todo/extension.ts) and how it
is mounted in [_buildResourceLoader](../src/pi/session.ts) (line ~223 in
the `factories` array). The factory callback runs inside the extension
host, so `import * as vscode from 'vscode'` works, and tools registered via
`api.registerTool({...})` (see [registerTodoTool](../src/pi/todo/tool.ts))
become first-class to the agent.

Planned location: `src/pi/lsp/` (extension.ts, tool.ts, helpers).

## 3. Initial tool surface (Phase 1 — read-only)

All read-only, safe to auto-approve (same risk profile as `read`/`grep`):

| Tool                  | Underlying provider command                  | Purpose                                                  |
| --------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `find_references`     | `vscode.executeReferenceProvider`            | Who reads/writes/calls this symbol                       |
| `goto_definition`     | `vscode.executeDefinitionProvider`           | Where is this symbol defined                             |
| `find_implementations`| `vscode.executeImplementationProvider`       | All concrete impls of an interface/abstract member       |
| `type_definition`     | `vscode.executeTypeDefinitionProvider`       | Type of an expression / variable                         |
| `workspace_symbols`   | `vscode.executeWorkspaceSymbolProvider`      | Fuzzy search for a symbol by name                        |
| `document_symbols`    | `vscode.executeDocumentSymbolProvider`       | Outline of a file (types, members)                       |
| `hover`               | `vscode.executeHoverProvider`                | Signature, doc comments, inferred type                   |
| `call_hierarchy`      | `vscode.prepareCallHierarchy` + incoming/outgoing | Multi-step callers / callees                        |

### Out of scope for Phase 1 (deferred)

- `rename_symbol` — needs `applyEdit` + integration with our `DiffManager` /
  `CheckpointManager` so the user sees a diff and can roll back. Deferred to
  Phase 2.
- `apply_code_action` — same story (mutating edits).
- `dotnet_build` / `dotnet_test` wrappers with structured diagnostics —
  related but independent feature; tracked separately.
- Rider MCP bridge for Unity-aware inspections — Phase 3.

## 4. Sub-problems

### 4.1 Symbol addressing (name → position)

Provider APIs require `(uri, Position)`. The agent typically has either:

- `{ file, line, column }` from a prior grep/read (use directly), or
- `{ symbol: "Namespace.Type.Member" }` from intent ("find references to
  Foo.Bar").

Strategy: each tool accepts **either** input shape. When given a symbol
name, internally call `executeWorkspaceSymbolProvider` first. If multiple
matches, return the candidate list and ask the agent to pick — do not
silently guess.

### 4.2 Document must be loaded

VS Code providers return empty results for documents the editor has not
seen. Before invoking a provider, call
`vscode.workspace.openTextDocument(uri)` (in-memory open, no UI). Cache
opened documents within a tool call to avoid repeated I/O.

### 4.3 Provider readiness

Right after startup, language servers are still indexing. First calls may
return `undefined` or empty. Strategy:

- Retry with exponential backoff up to ~30 s for the first call per
  workspace.
- On final timeout, return a structured error (`{error: 'language server
  not ready, retry'}`) — never block the agent silently.

### 4.4 Result normalization

Providers return raw `Location[]` = `{uri, range}`. Useless to the agent
without snippets. The tool layer must:

- Read each location's source file (cached).
- Extract the matching line + N lines of context (default 2).
- Emit a flat list: `{ file, line, column, snippet, kind }`.
- Truncate at N results (default 50) and flag `truncated: true`.

This converts one LSP call into a ready-to-reason structured payload, so
the agent doesn't have to spend follow-up `read` calls just to see what
each location contains.

### 4.5 Cancellation

Provider commands accept a `CancellationToken`. Forward Pi's
`AbortSignal` from the tool's `execute()` parameters into the command call.

### 4.6 System prompt budget

Eight tools at once adds non-trivial copy to the system prompt for every
session, including non-coding ones. Gate registration behind a setting:

- `pi-code.lsp.enabled` (boolean, default `true`).
- When `false`, the factory does not call `registerTool` at all — the
  agent sees nothing.

### 4.7 Provider availability per language

Not every language extension implements every provider. Pre-flight
confirmed that base `ms-dotnettools.csharp` returns `count=0` in 0 ms for
`prepareCallHierarchy` — i.e. no provider registered. Two options:

- **Static:** register all eight tools; if a provider returns undefined,
  surface a clean "not supported by the active language extension" error.
- **Dynamic:** introspect provider registration at session start and
  register only available tools.

Lean static for v1 — fewer moving parts, error path is clear enough.

### 4.8 Distinguishing "no results" from "no provider" (added after pre-flight)

VS Code does **not** throw when a provider is not registered — it silently
returns `[]` (or `null` for some providers). Pre-flight reproduced this
twice: (a) with no C# extension installed all eight calls returned `[]`
in 1–9 ms; (b) `prepareCallHierarchy` on the base C# extension returned
`count=0` in 0 ms.

If we just forward those results to the agent, it gets "0 references" and
draws the wrong conclusion. We need a reliable signal. Options:

- **Extension presence check.** At tool call time, scan
  `vscode.extensions.all` for known language extension ids per languageId
  and emit a structured warning when none is present/active. Brittle —
  requires a maintained id list — but cheap.
- **Timing heuristic.** Calls below a per-provider threshold (~10 ms) on
  an empty result are almost certainly "no provider". Fragile on fast
  machines but easy to tune. Probably best as a secondary signal.
- **`vscode.languages.match`.** Tells us whether the language is
  registered, not whether a *specific provider* is registered. Useful as
  a coarse pre-check.

Plan for v1: combine extension presence + timing heuristic. Encode the
result in the tool response envelope as `{ providerStatus:
"ok" | "no-provider" | "indexing", results: [...] }` so the agent has
explicit signal instead of guessing from an empty array.

### 4.9 DocumentSymbol traversal (added after pre-flight)

Pre-flight showed Roslyn returns hierarchical `DocumentSymbol[]` (with
`children`), not flat `SymbolInformation[]`. Production normalization
must recursively walk `children` and emit either a flat list with depth
indicators or preserve the tree shape. The smoke tool reported only
top-level roots — fine for diagnostics, not for the agent-facing tool.

## 5. Pre-flight verifications (before writing the integration)

These are unknowns that should be settled by a 30-minute smoke test, not
by writing the full integration and discovering issues at the end.

Smoke tooling: see [src/dev/lsp-smoke.ts](../src/dev/lsp-smoke.ts), runs
via Command Palette → "Pi Code: LSP Smoke Test (cursor)" in the Extension
Development Host. Remove once Phase 1 lands.

- [x] **Confirmed: providers work for C# via `ms-dotnettools.csharp`
      (Roslyn LSP).** Tested on a large commercial Unity solution
      (`CardGameController.cs`, cursor on `InitContext`):
      - `executeDefinitionProvider` — 18 ms, 1 Location.
      - `executeImplementationProvider` — 23 ms, 1 Location.
      - `executeReferenceProvider` — **529 ms**, 2 Locations (decl +
        usage). First real Roslyn call after warm-up.
      - `executeHoverProvider` — 5 ms, returned full signature with
        parameter types (`void CardGameController.InitContext(...)`).
        Excellent low-cost summary primitive for the agent.
      - `executeDocumentSymbolProvider` — 1 ms, returned hierarchical
        `DocumentSymbol[]`. (Smoke tool only counted root nodes; see
        §4.4 note.)
- [x] **Important finding: providers silently return `[]` when no
      language extension is registered.** Reproduced with no C# extension
      installed: all calls returned empty arrays in 1–9 ms. VS Code does
      not throw a "provider not found" error. **Design implication:** we
      MUST distinguish "no results" from "no provider" before reporting
      to the agent — see §4.8.
- [x] **Important finding: command IDs require the `vscode.` prefix.**
      `vscode.executeReferenceProvider`, not `executeReferenceProvider`.
      Missing the prefix yields `command not found`.
- [x] **`executeTypeDefinitionProvider` on a method returns empty.**
      Semantically correct (methods have no "type"). The tool's
      description must steer the agent to call it on variables /
      expressions, not on members.
- [x] **`prepareCallHierarchy` not registered by base C# extension.**
      Returned `count=0` in 0 ms — same pattern as "no provider". May be
      available under C# Dev Kit; treat call hierarchy as optional in
      Phase 1.
- [ ] **Re-test with C# Dev Kit (`ms-dotnettools.csdevkit`).** Confirm
      whether it adds `prepareCallHierarchy`, improves
      `executeWorkspaceSymbolProvider` (see below), and whether its
      results differ from the base extension. Licensing nuance for
      commercial use.
- [ ] **`executeWorkspaceSymbolProvider` returned 0 results for an
      existing symbol** (`"InitContext"` on a Unity solution, 12 ms).
      Possible causes: (a) solution not finished indexing — Unity
      projects are large; (b) Roslyn workspace-symbol matching rules
      differ from fuzzy expectation; (c) needs longer prefix / different
      query. Retest after `Project loaded` shows in the C# extension
      status bar.
- [ ] **Same smoke on TypeScript** (built-in language features) — verify
      cross-language parity.
- [ ] **Same smoke on Python** (Pylance / Pyright) — verify third-language
      parity.
- [x] **Cross-file references confirmed without `openTextDocument`.**
      Public property `Core.Player` returned **72 cross-file references
      across 8+ files** in 507 ms, with `Documents auto-opened: 0`.
      Roslyn maintains its index independently of editor state — §4.2
      simplifies to "no workaround needed for indexed languages."
- [x] **`executeWorkspaceSymbolProvider` works but is query-sensitive.**
      `"Player"` returned 119 results across classes/methods/fields in
      24 ms. `"CoreData"` and `"InitContext"` returned 0 in 11–12 ms
      against a fully-indexed solution. Pattern looks like
      camelCase-segment / token-based matching that drops some valid
      names. Ship the tool but document the caveat in the prompt, and
      recommend the agent fall back to `grep` when the query returns
      empty against expected-present symbols.
- [x] **`executeTypeDefinitionProvider` works on typed properties.**
      Cursor on `Core.Player` (property of type `Player`) navigated to
      `Player.cs:17`. Earlier empty result was on a method name, which
      is semantically correct (methods have no type). Tool description
      must steer the agent to use it on variables / properties /
      parameters.
- [x] **Cross-language parity confirmed via rust-analyzer smoke.** Same
      eight providers tested on a Bevy/Rust project (`src/main.rs`,
      cursor on `Commands::spawn`):
      - All eight providers returned real data, including
        `prepareCallHierarchy` (17 ms, 1 item) and
        `provideIncomingCalls` (4053 ms, 32 callers across workspace
        and external crates).
      - `executeWorkspaceSymbolProvider("spawn")` — 25 matches in 356 ms.
        Workspace symbol search works reliably on rust-analyzer.
      - Hover returned markdown signature
        `bevy_ecs::system::commands::Commands` + impl block — perfect
        agent-facing summary.
      - References returned 45 locations across local files **and**
        external crate sources (`~/.cargo/registry/...`). Confirms
        external dependencies are included by default.
      - 0 source documents auto-opened by VS Code. Same architectural
        conclusion as C#.
- [x] **Shape differences across language servers (drives normalizer):**
      - Definition / type-definition: Roslyn returns `Location[]`;
        rust-analyzer returns `LocationLink[]`. Normalizer must accept
        both.
      - Document symbols: Roslyn returns hierarchical `DocumentSymbol[]`
        (root namespace + nested children); rust-analyzer returns flat
        `SymbolInformation[]`. Normalizer must traverse the first and
        pass through the second.
      - `SymbolKind` integer values are protocol-standard but the
        *which kind for which language construct* varies (e.g. rust
        struct = kind 22, C# namespace = kind 2, C# class = kind 4,
        C# method = kind 5, Rust function = kind 11). Normalizer
        should map LSP `SymbolKind` to human-readable strings.
- [x] **External dependency sources surface by default.** Rust smoke
      returned references in `~/.cargo/registry/.../bevy_ecs-*/src/...`.
      Same will be true for NuGet / decompiled assemblies (C#) and
      `node_modules` (TS). Policy: keep them in results but annotate
      `source: "external"` so the agent can decide whether to follow.
- [x] **`prepareCallHierarchy` IS supported by rust-analyzer.**
      Earlier "no provider" result was specific to base
      `ms-dotnettools.csharp`. Phase 1 should register call hierarchy
      tools but gracefully report `provider not available` for languages
      whose server doesn't implement it.
- [x] **Call hierarchy is genuinely expensive.** 4 seconds for 32
      incoming calls on a popular function. Tool must surface a
      cancellable progress signal and document a recommended timeout
      (~30 s) so the agent treats it as a heavy operation.
- [x] **Hover content is Markdown** (code fences, multi-line, language
      hints). Normalizer must preserve markdown structure — agent reads
      it as structured signature, not as a one-liner.

## 6. Implementation plan (Phase 1)

Once pre-flight is green:

1. **Scaffold** `src/pi/lsp/extension.ts` (factory) and
   `src/pi/lsp/tool.ts` (per-tool registration), mirroring
   [src/pi/todo/](../src/pi/todo/) layout.
2. **Wire factory** into the `factories` array in
   [_buildResourceLoader](../src/pi/session.ts).
3. **Shared helpers** in `src/pi/lsp/helpers.ts`:
   - `resolveSymbol(input) → Position | Position[]`
   - `ensureOpen(uri)` with document cache
   - `withReadyRetry(fn, timeoutMs)`
   - `normalizeLocations(locations, opts) → NormalizedResult[]`
4. **Tools** (one file each or grouped): `find_references`,
   `goto_definition`, `find_implementations`, `type_definition`,
   `workspace_symbols`, `document_symbols`, `hover`, `call_hierarchy`.
5. **Setting** `pi-code.lsp.enabled` in
   [package.json](../package.json) `contributes.configuration` and the
   `SettingsData` interface in
   [src/shared/protocol.ts](../src/shared/protocol.ts). Surface it in the
   settings panel.
6. **Tests**: unit tests for `normalizeLocations`, `resolveSymbol`
   disambiguation. Integration test stub against a known fixture project.
7. **Manual smoke**: real C# + real TS + real Python projects, all eight
   tools, with the dev host (F5).
8. **CHANGELOG** + version bump (minor — additive feature).

## 7. Task list

Legend: `TODO` (not started) · `WIP` (in progress) · `DONE` · `BLOCKED`
· `DEFERRED` (intentionally postponed).

### Phase 0 — pre-flight

- [x] **DONE** — Smoke `executeReferenceProvider` against base
      `ms-dotnettools.csharp` on a commercial Unity solution. Result: 529 ms
      for first real call, 2 Locations on a method symbol. See §5 for
      full provider matrix.
- [x] **DONE** — Confirm `vscode.` prefix requirement on provider
      command IDs.
- [x] **DONE** — Confirm silent-empty behavior when no language
      extension is installed. Drives §4.8 design.
- [x] **DONE** — Cross-file reference smoke. 72 refs across 8+ files,
      no `openTextDocument` needed.
- [x] **DONE** — Retest `executeWorkspaceSymbolProvider` after indexing.
      Works for some queries (`"Player"` → 119 results), empty for
      others (`"CoreData"`, `"InitContext"`). Treated as known
      limitation — see §5 entry.
- [x] **DONE** — Cross-language parity verified on rust-analyzer
      (Bevy/Rust project). All 9 providers return real data including
      call hierarchy. Confirms language-agnostic API ambition is
      realistic; shape differences are isolated to the normalizer
      layer.
- [x] **DONE** — External dependency source handling decided: keep
      results, annotate `source: "external"` so the agent can choose
      whether to dig into them.
- [ ] **TODO (low priority)** — Retest with `ms-dotnettools.csdevkit`:
      does it add `prepareCallHierarchy`, does it improve workspace
      symbols? Deferred — base extension is sufficient for v1, and
      Dev Kit's licensing complicates commercial use.
- [ ] **TODO (low priority)** — Smoke same providers against built-in
      TypeScript. Optional — Rust + C# already give two-language
      parity signal.
- [ ] **TODO (low priority)** — Smoke same providers against Pylance /
      Pyright. Optional.
- [ ] **TODO (low priority)** — Measure provider readiness latency on a
      fresh window open (current smoke ran after warm-up).

### Phase 1 — read-only tools

- [x] **DONE** — Scaffold `src/pi/lsp/` (extension factory + tool module)
- [x] **DONE** — Wire factory into `_buildResourceLoader`
- [x] **DONE** — Shared helpers: `resolveSymbol`, `normalizeLocations`,
      `normalizeDocumentSymbols`, `probeResolvedSymbol`, `classifyAccess`,
      `detectProviderStatus`, `symbolKindToString`.
- [x] **DONE** — `find_references` shipped, with `resolvedSymbol` probe,
      position echo (`Line:|...`, `Column:|^`), `>` match marker on
      snippet lines, `source: "workspace" | "external"` annotation,
      `maxResults: 200` / `contextLines: 2` defaults.
- [x] **DONE** — `find_references` `includeAccessKind` mode: per-result
      `read`/`write`/`text`/`unknown` tag via
      `executeDocumentHighlights`; header breakdown counts. Closes
      "where is X assigned?" workflow without language-specific
      heuristics.
- [x] **DONE** — `document_symbols` shipped, handles both
      `DocumentSymbol[]` (hierarchical, Roslyn) and `SymbolInformation[]`
      (flat, rust-analyzer), with `nameContains` filter.
- [x] **DONE** — `pi-code.lsp.enabled` setting (package.json + `SettingsData`
      + Settings Panel toggle). **Defaults to OFF** — opt-in feature.
- [x] **DONE** — `goto_definition` shipped. Same plumbing pattern as
      `find_references` (position echo + resolved-symbol probe + workspace/external
      annotation). Default `contextLines: 4` to surface the signature plus the
      start of the body. Handles legitimate multi-site results (partial classes,
      overloaded methods).
- [x] **DONE** — `find_implementations` shipped. Wraps
      `vscode.executeImplementationProvider`. Same plumbing as
      `goto_definition` (position echo + resolved-symbol probe,
      workspace/external annotation, two addressing modes). Default
      `contextLines: 3`, `maxResults: 100`. Closes the OOP refactoring
      triad (declaration + implementations + references).
- [x] **DONE** — `type_definition` shipped. Wraps
      `vscode.executeTypeDefinitionProvider`. Same plumbing as
      `goto_definition`. Returns empty (with a helpful message) when
      called on a symbol that has no separate type to jump to (method
      names, class names themselves, keywords).
- [x] **DONE** — `workspace_symbols` shipped. Wraps
      `vscode.executeWorkspaceSymbolProvider`. Free-form query, flat
      result with `(file,line,column)` ready for follow-up LSP calls.
      Optional `kindFilter`. Honestly surfaces the Roslyn-empty-match
      caveat in both description and the empty-result message so the
      agent escalates to grep when appropriate (no silent fallback).
- [x] **DONE** — `hover` standalone tool shipped. Wraps
      `vscode.executeHoverProvider` and renders the full markdown
      payload (signature + inferred type + doc comments). Shares the
      same `(file,line,column)` / `symbol` addressing as the other LSP
      tools. The internal `probeResolvedSymbol` helper still feeds the
      one-liner used in `find_references` / `goto_definition` headers.
- [x] **DONE** — `call_hierarchy_incoming` and
      `call_hierarchy_outgoing` shipped as two separate tools (per
      pickup-note recommendation). Both anchor via
      `vscode.prepareCallHierarchy`; incoming reads `from.uri` for each
      caller's body, outgoing reads the anchor's URI once for all
      callees' snippets (`fromRanges` are relative to the anchor's
      file, not the callee's). Defaults: `contextLines: 2`,
      `maxResults: 100`. Honest provider-support notes in description
      and empty-result text: base `ms-dotnettools.csharp` does NOT
      implement call hierarchy, only C# Dev Kit / rust-analyzer /
      tsserver / Pylance / gopls / clangd do. Shared snippet rendering
      via the newly exported `loadFileLines` and `formatSnippetBlock`
      helpers (previously private to `normalizeLocations`).
- [ ] **TODO** — Unit tests for `normalizeLocations`,
      `normalizeDocumentSymbols`, `classifyAccess`, `resolveSymbol`
      disambiguation.
- [ ] **TODO** — Repeat the "count references" benchmark with
      `document_symbols` + `maxResults: 200` to confirm the LSP/grep
      cost gap closed.
- [ ] **TODO** — Manual smoke on real TS and Python projects (deferred
      from Phase 0 as low-priority once C# + Rust validated the
      architecture).
- [ ] **TODO** — Minor version bump when remaining Phase 1 tools land.

### Phase 2 — mutating operations

- [ ] **DEFERRED** — `rename_symbol` integrated with `DiffManager` /
      `CheckpointManager`
- [ ] **DEFERRED** — `apply_code_action` (Roslyn quick fixes)

### Phase 3 — JetBrains augmentation (separate spike)

- [ ] **DEFERRED** — Rider MCP bridge for Unity-aware inspections, SWEA,
      dupfinder

### Related but independent (not part of this feature)

- [ ] **DEFERRED** — `dotnet_build` / `dotnet_test` wrappers with
      structured diagnostics. Belongs to a separate "build-loop tools"
      feature; LSP integration is shippable without it.

## 8. Open questions

- Do we want a single combined tool with a `kind: 'references' | 'definition' | ...`
  argument, instead of eight named tools? Smaller prompt footprint vs.
  worse discoverability for the agent. Leaning **named tools** for now —
  the agent picks them up faster from short descriptions.
- Should `workspace_symbols` results respect the active editor's language,
  or always return all matches across the workspace? Defaulting to **all
  languages** since the agent often hops between files in different
  languages.
- How aggressive should the result truncation be? 50 is a guess; will tune
  after the first real sessions show actual call-site counts in the wild.
