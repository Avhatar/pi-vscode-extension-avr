# Chapter: chat-host-and-service

The portable chat core is the largest subsystem in the repo that has no direct dependency on VS Code. Under `src/core/chat/`, a family of classes projects Pi agent events into per-tab state, orchestrates prompt / steer / follow-up dispatch, manages the message queue while streaming, and produces the `SerializedAgentState` shape that every UI surface renders.

This chapter introduces the two top-level orchestrators: `ChatHost` (per-application lifecycle) and `ChatService` (per-tab reduction). Their neighbors — the event policy that classifies agent output, the slash-command router, the tab registry — are covered in this Part's sibling chapters.

## Article roster

- [chat-host-and-service](chat-host-and-service.md) — `ChatHost` construction and its dispatch API, `ChatService`'s event reducer, streaming lifecycle, queue lifecycle, and the `buildState` projection that produces `SerializedAgentState`.

## Reader task

The reader arrives here to answer one of:

- "When a user prompt arrives, which class actually calls into the Pi SDK?"
- "How is per-tab state kept isolated when there are ten tabs streaming at once?"
- "Where do I plug in a new tool toggle so it propagates from a webview click to the running session?"
- "How does the queue know when to auto-dispatch the next queued prompt?"

## Neighborhood

- **Event classification** (orphan tool sweeps, assistant-turn issues, completion outcome) is [chat-event-policy](../chat-event-policy/chat-event-policy.md).
- **Slash-command parsing / intent routing** (`/name`, `/compact`, cancel, retry) is [chat-command-service](../chat-command-service/chat-command-service.md).
- **Tab membership and per-tab runtime state** are [tab-registry-and-runtime](../tab-registry-and-runtime/tab-registry-and-runtime.md).
- **The port surface** the whole subsystem talks to (workspace, file state, session platform) is [platform-ports](../platform-ports/platform-ports.md).

## Non-goals

- The Pi SDK session-lifecycle detail (what `session.prompt()` actually does inside) lives in [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md); the chat core is a consumer.
- Webview UI (how `SerializedAgentState` is rendered) is [Part VI](../../../index.md#part-vi--ui-surfaces-webview).
- File change tracking, diff presentation, checkpoint semantics are [Part VII](../../../index.md#part-vii--safety-and-reversibility); this chapter references `DiffManager` / `CheckpointManager` as *dependencies*.
