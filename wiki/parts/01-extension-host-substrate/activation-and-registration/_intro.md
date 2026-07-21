# Chapter: activation-and-registration

VS Code invokes the extension exactly once per window through the `activate()` entry point in [src/extension.ts](../../../../src/extension.ts). That single function is responsible for standing up every long-lived service the extension owns — chat controllers, session managers, subagent coordinators, launcher and settings providers, RawMode registry, secret-store bridges — and for registering every command, webview-view provider, and panel serializer that the rest of the extension depends on to be reachable from the VS Code UI.

This chapter treats activation as an integration seam rather than a piece of business logic. The extension host itself is a Node.js process; the code that ships with the VSIX is a mixture of portable Pi-agnostic core (`src/core/**`) and VS Code adapters (`src/adapters/vscode/**`). Activation is where those two worlds are wired together for the first time, and where the extension registers itself so that VS Code can call back into it later.

## Article roster

- [activation-and-registration](activation-and-registration.md) — the `activate()` entry point, command / provider / serializer registration, secret-change bridging, and the [`ChatController`](../../../../src/controllers/chat-controller.ts) that glues the portable core to VS Code effects.

## Reader task

The reader arrives at this chapter to answer one of:

- "Where does *this specific* command originate — who calls `registerCommand('pi-code.foo')`, and what does it dispatch into?"
- "What happens when the user stores an API key — how does that reach the running Pi session?"
- "Why does closing a chat panel not leak the underlying `PiSessionManager` — what disposes it?"
- "Where do I hook a new subscription that must fire at activation but be torn down cleanly on window close?"

By the end of the article, the reader should be able to trace any command palette entry back to a specific line in [src/extension.ts](../../../../src/extension.ts) and any VS Code lifecycle event (secret change, workspace-folder change, window reload) to the code that reacts to it.

## Neighborhood

- Configuration lookups (settings + secret prefixes) are documented in the sibling chapter [configuration-and-secrets](../configuration-and-secrets/configuration-and-secrets.md). This article stops at "activation reads the config" and defers detail there.
- Bundle boundaries (what activation is allowed to import — no webview code, no bundled webview CSS at compile time) are covered in [bundle-targets-and-esbuild](../bundle-targets-and-esbuild/bundle-targets-and-esbuild.md).
- The typed messages that flow between the extension host activated here and the webviews are documented in [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md).

## Non-goals

- Chat internals (`ChatHost`, `ChatService`, `TabRegistry`) are described in [Part III](../../03-portable-chat-core/chat-host-and-service/_intro.md). This chapter only covers how those objects are constructed and where their event streams are attached.
- Pi SDK bootstrap details — resource loader assembly, extension factories, session-lock acquisition — belong to [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
- Subagent-specific policies live in [Part IX](../../../index.md#part-ix--subagents) and are only mentioned here as owned disposables.
