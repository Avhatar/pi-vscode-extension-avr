# Chapter: lsp-tools

VS Code embeds language servers for every mainstream language — C#, TypeScript, Rust, Python, Go, C++, Java, Kotlin, Swift. Their capabilities are exposed as `vscode.executeXProvider` commands. [src/pi/lsp/](../../../../src/pi/lsp/) wraps nine of these commands as **Pi tools** the agent can call: `find_references`, `hover`, `goto_definition`, `find_implementations`, `type_definition`, `document_symbols`, `workspace_symbols`, `call_hierarchy_incoming`, `call_hierarchy_outgoing`. All gated by the `pi-code.lsp.enabled` setting (default off).

## Article roster

- [lsp-tools](lsp-tools.md) — the extension factory, the 9 tools, `helpers.ts` normalization (locations, symbols, access-kind classification), and the two addressing modes (`file+line+column` or `symbol`).

## Reader task

The reader arrives here to answer one of:

- "Which language server does Pi actually call — or does it call the extension directly?"
- "How does `find_references` decide whether a reference is a read or a write?"
- "Why is `document_symbols` returning a flat list when VS Code returns a tree?"
- "How is the symbol name resolved to a specific file+line?"

## Neighborhood

- **Gating** — the `pi-code.lsp.enabled` setting — is [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md).
- **The extension factory** is registered as one of the resource-loader factories in [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
- **`vscode.executeXProvider` commands** are VS Code APIs — the wiki documents *our* wrapping, not their internal behavior.

## Non-goals

- Language-server-specific quirks (rust-analyzer substring match vs. Roslyn CamelCase) are described where they affect our wrapping; deeper server internals are external.
- Refactoring tools (`rename`, `code_action`) are not yet exposed as Pi tools.
- LSP protocol itself — this chapter documents the VS Code command surface, not the JSON-RPC underneath.
