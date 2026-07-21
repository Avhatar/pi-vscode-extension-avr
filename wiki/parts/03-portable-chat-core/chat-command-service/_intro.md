# Chapter: chat-command-service

Between the raw `AgentClientMessage` that arrives from a webview and the mutation on a `TabRuntime` sits one router: [`ChatCommandService`](../../../../src/core/chat/chat-command-service.ts). Every message either translates into an *intent* (an object describing "please switch model X on tab Y", "please open session Z") which the host will execute in a side-effectful way, or it fans out into a `ChatService` call directly (queue edits, prompt dispatch, file mentions) with no further routing.

The service also carries slash-command parsing: `/name`, `/compact`, and the queue-management commands that don't map onto SDK primitives.

## Article roster

- [chat-command-service](chat-command-service.md) — the `dispatch()` router, the intent type family, `/name` handling, and how host callbacks let the same service work across different host implementations.

## Reader task

The reader arrives here to answer one of:

- "How does typing `/name My chat` in the input actually rename the tab?"
- "When the webview sends `setModel`, which class updates the SDK session vs. persists the choice vs. refreshes the picker?"
- "How would I add a new client message that doesn't map to an existing intent?"

## Neighborhood

- **Producers of messages**: every webview and the extension host itself.
- **Consumers of intents**: [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — specifically the `_executeIntent` switch in `ChatHost`.
- **Prompt / queue / file-history dispatch**: `ChatService` from the same chapter.

## Non-goals

- Slash-command *rendering* (the menu that pops up on `/`) is [Part VI § slash-commands-and-skills-menu](../../06-ui-surfaces-webview/slash-commands-and-skills-menu/slash-commands-and-skills-menu.md).
- Skill execution (once a slash command dispatches into a Pi skill) is a Pi SDK detail described in [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
