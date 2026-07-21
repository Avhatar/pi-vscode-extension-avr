# Chapter: message-protocol

Every boundary in Pi Code speaks the same language: a discriminated union of typed messages defined in [src/shared/**.ts](../../../../src/shared/). The extension host and the webviews exchange them. The webview-side connection client emits them. The Electron IPC bridge for the standalone desktop app carries them. The Node process running an integration test speaks them. Adding a new UX affordance almost always begins by adding a new discriminator to one of these unions, and the compiler's exhaustiveness checks turn every downstream consumer into a follow-up TODO.

This chapter documents the vocabulary: what unions exist, what their discriminators are, where the payload shape is declared, and how the compatibility layers between them are meant to be understood.

## Article roster

- [message-protocol](message-protocol.md) — the client / server message unions, their splits (`agent-protocol`, `platform-protocol`, `vscode-protocol`, `raw-protocol`, `agent-control-protocol`), the top-level barrel in [src/shared/protocol.ts](../../../../src/shared/protocol.ts), and the settings / launcher / raw message trees hanging off it.

## Reader task

The reader arrives here to answer one of:

- "I want to add a new client message — where do I put it?"
- "What's the difference between `AgentClientMessage` and `PlatformClientMessage`?"
- "Which typed shape does the launcher exchange with the extension host?"
- "Why is `SettingsData` in the same file as `LauncherTabInfo`?"

## Neighborhood

- The **runtime validators** for these types (Typebox schemas, type guards, envelope checks) live in the next chapter [protocol-runtime](../protocol-runtime/protocol-runtime.md). That chapter enforces at runtime what this one declares at compile time.
- The **connection client** that carries envelopes over any transport lives in [agent-connection-client](../agent-connection-client/agent-connection-client.md).
- The **producers** of these messages sit throughout Parts I, III, V, VI — this chapter is the atlas that says "here is where the shape is declared", nothing more.

## Non-goals

- Semantics of individual messages (what happens when you dispatch `steer` mid-stream, how `queueMessage` interacts with `agent_settled`) belong to the domain chapters — see [Part VIII § steering](../../../index.md#part-viii--message-flow-discipline).
- Persistence of any of these types (which fields survive across `Reload Window`) is documented in the panels that serialize state — see [Part VI § chat-panel-provider](../../06-ui-surfaces-webview/chat-panel-provider/chat-panel-provider.md).
- Wire framing / envelope construction / request-response correlation is the job of the sibling chapter [protocol-runtime](../protocol-runtime/protocol-runtime.md) and the client chapter, not this one.
