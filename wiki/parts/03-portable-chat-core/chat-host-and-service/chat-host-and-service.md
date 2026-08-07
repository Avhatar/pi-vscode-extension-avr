# chat-host-and-service

## Stance

`ChatHost` is the application; `ChatService` is the reducer. The host owns every tab, mediates every dispatched intent, and calls into effects (persistence, focus, emit) that whatever platform it runs on injects. The service is stateless in the sense that it holds no tabs itself — it operates on a single `TabRuntime` passed in per call. That separation is deliberate: hosts differ per platform (VS Code, Electron, dev harness), but the reduction of an agent event stream into a `SerializedAgentState` is the same everywhere.

Nothing here imports `vscode`. Do not add such an import.

## Role

[`ChatHost<TTab>`](../../../../src/core/chat/chat-host.ts#L131) receives `ChatHostOptions<TTab>` at construction: a `TabRegistry`, a `ChatService`, a `ChatCommandService`, a per-tab factory, callbacks, a `stateContext`, `preferences`, `effects`, `eventEffects`. Its lifecycle surface is:

- [`createTab()`](../../../../src/core/chat/chat-host.ts#L158) — invokes factory, registers, calls `bindTab / persistTabs / tabsChanged / openTab` effects.
- [`restoreTabs(persisted, bootstrapTabId?)`](../../../../src/core/chat/chat-host.ts#L190) — batch restoration from serialized state.
- [`dropTab`](../../../../src/core/chat/chat-host.ts#L227), [`closeTab`](../../../../src/core/chat/chat-host.ts#L235), [`detachTab`](../../../../src/core/chat/chat-host.ts#L252) — three variants of removal (with / without minimum-size enforcement).
- [`activateTab`](../../../../src/core/chat/chat-host.ts#L244), [`switchTab`](../../../../src/core/chat/chat-host.ts#L258) — activation with different semantics.
- Feature toggles: [`setActiveTodoEnabled`](../../../../src/core/chat/chat-host.ts#L269), `setActiveSubagentsEnabled`, `setActivePlanModeEnabled`, `setActiveFileUndoViewEnabled`, `setActiveToolDisabled`, `setActiveToolsBulk`, `applyActiveToolSelection` (through [chat-host.ts:305](../../../../src/core/chat/chat-host.ts#L305)).
- [`getState(tabId?)`](../../../../src/core/chat/chat-host.ts#L358) — delegates to `chat.buildState`.
- [`dispatch(message, sourceTabId?)`](../../../../src/core/chat/chat-host.ts#L369) — routes through `ChatCommandService`, executes the returned intent through `_executeIntent` (host-owned side effects: model change, session load, tab lifecycle).
- [`handleEvent(tab, event)`](../../../../src/core/chat/chat-host.ts#L401) — the agent event bus; reduces via `ChatService`, applies chat-event-policy, dispatches queue, publishes state.

[`ChatService<TTab>`](../../../../src/core/chat/chat-service.ts#L164) is the reducer. Its main entry [`reduceEvent(tab, event)`](../../../../src/core/chat/chat-service.ts#L171) mutates the tab runtime on `agent_start`, `tool_execution_start / end`, `compaction_start / end`, `message_end`, `message_update`; streams thinking / text tokens on `stream_chunk`; and forwards to the turn-notification gate on `agent_end` / `agent_settled`.

Turn accounting is a three-step protocol: [`beginAgentEnd(tab, outcome)`](../../../../src/core/chat/chat-service.ts) records duration and arms the notification gate, [`completeAgentEnd(tab, projection, accounting?)`](../../../../src/core/chat/chat-service.ts) commits duration plus provider-specific Codex/DeepSeek message metadata and clears streaming state, and [`settleAgent(tab)`](../../../../src/core/chat/chat-service.ts) resolves the turn via `turnNotificationGate.onAgentSettled()`.

[`dispatchDirectPrompt(tab, request, callbacks)`](../../../../src/core/chat/chat-service.ts#L346) is the entry point for user prompts — parses `/compact` inline, increments `turnCounter`, arms the notification gate, invokes `_runUserPrompt`. Streaming controls flow through [`dispatchStreamingCommand`](../../../../src/core/chat/chat-service.ts#L383) (abort / steer / follow-up). Queue lifecycle is [`applyQueueControl(tab, command)`](../../../../src/core/chat/chat-service.ts#L402), [`reserveQueuedDispatch()`](../../../../src/core/chat/chat-service.ts#L443), [`dispatchNextQueued()`](../../../../src/core/chat/chat-service.ts#L449).

[`buildState(tab, context)`](../../../../src/core/chat/chat-service.ts) is the projection layer. It produces `SerializedAgentState`: compact model-context messages, a latest-page full-transcript projection, model, tools, streaming / compacting flags, session metadata, context usage, file changes, cache mode, controls (todos, subagents, tool selection, feature toggles), pending tools, streaming buffers, queued messages. Runtime timing and provider-cost metadata is aligned from the compact assistant tail onto matching newest transcript assistants. Every UI surface that needs "what does this tab look like right now?" calls it.

[`buildTranscriptPage`](../../../../src/core/chat/transcript-pagination.ts) pages any root-to-leaf entry sequence backwards by stable entry id. It counts projected entries rather than generated messages, skips metadata-only entries, never splits one entry's generated messages across pages, and marks a missing cursor so the client resets after a branch change.

## Role — files under src/core/chat

- [chat-host.ts](../../../../src/core/chat/chat-host.ts) — orchestrator
- [chat-service.ts](../../../../src/core/chat/chat-service.ts) — reducer + projection
- [chat-event-policy.ts](../../../../src/core/chat/chat-event-policy.ts) — see [chat-event-policy](../chat-event-policy/chat-event-policy.md)
- [chat-command-service.ts](../../../../src/core/chat/chat-command-service.ts) — see [chat-command-service](../chat-command-service/chat-command-service.md)
- [tab-registry.ts](../../../../src/core/chat/tab-registry.ts), [tab-runtime.ts](../../../../src/core/chat/tab-runtime.ts) — see [tab-registry-and-runtime](../tab-registry-and-runtime/tab-registry-and-runtime.md)
- [chat-application.ts](../../../../src/core/chat/chat-application.ts) — thin container coupling `TabRegistry` with per-tab dispose semantics
- [turn-notification-gate.ts](../../../../src/core/chat/turn-notification-gate.ts) — arms / clears the "session is done, notify" latch
- [chat-preferences.ts](../../../../src/core/chat/chat-preferences.ts) — user-preference bookkeeping across sessions
- [launcher-projection.ts](../../../../src/core/chat/launcher-projection.ts) — projects host state into `LauncherState` for the launcher webview
- [transcript-pagination.ts](../../../../src/core/chat/transcript-pagination.ts) — backwards current-branch transcript paging with stable entry cursors

## Keywords

**Types — orchestrator:**
- `ChatHost<TTab>` — [chat-host.ts:131](../../../../src/core/chat/chat-host.ts#L131)
- `ChatHostOptions<TTab>` — same file; DI bundle
- `ChatHostEffects`, `ChatHostEventEffects`, `ChatHostPreferencePort` — extension points

**Types — reducer:**
- `ChatService<TTab>` — [chat-service.ts:164](../../../../src/core/chat/chat-service.ts#L164)
- `ChatServiceTab` — structural constraint on the tab shape the reducer expects
- `AgentEndAccounting` — optional Codex account-window and DeepSeek monetary deltas committed to the last assistant message
- `TurnCompletionInfo` — result of `settleAgent`
- `TurnCompletionOutcome` — `'completed' | 'stopped' | 'failed' | 'truncated'` from [chat-event-policy](../chat-event-policy/chat-event-policy.md)
- `TranscriptPageItem<TMessage>`, `TranscriptPageSlice<TMessage>` — portable page records from [transcript-pagination.ts](../../../../src/core/chat/transcript-pagination.ts)

**Methods — dispatch:**
- `dispatch(message, sourceTabId?)` — [chat-host.ts:369](../../../../src/core/chat/chat-host.ts#L369)
- `handleEvent(tab, event)` — [chat-host.ts:401](../../../../src/core/chat/chat-host.ts#L401)
- `reduceEvent(tab, event)` — [chat-service.ts:171](../../../../src/core/chat/chat-service.ts#L171)
- `dispatchDirectPrompt(tab, request, cb)` — [chat-service.ts:346](../../../../src/core/chat/chat-service.ts#L346)
- `dispatchStreamingCommand(cmd, cb)` — [chat-service.ts:383](../../../../src/core/chat/chat-service.ts#L383)
- `applyQueueControl(tab, cmd)` — [chat-service.ts:402](../../../../src/core/chat/chat-service.ts#L402)
- `dispatchNextQueued()` — [chat-service.ts:449](../../../../src/core/chat/chat-service.ts#L449)
- `buildState(tab, ctx)` — [chat-service.ts](../../../../src/core/chat/chat-service.ts)
- `buildTranscriptPage(entries, project, options)` — [transcript-pagination.ts](../../../../src/core/chat/transcript-pagination.ts)

**Methods — feature toggles (host-side):**
- `setActiveTodoEnabled`, `setActiveSubagentsEnabled`, `setActivePlanModeEnabled`, `setActiveFileUndoViewEnabled` — [chat-host.ts:269](../../../../src/core/chat/chat-host.ts#L269)
- `setActiveToolDisabled`, `setActiveToolsBulk`, `applyActiveToolSelection` — [chat-host.ts:305](../../../../src/core/chat/chat-host.ts#L305)

**Attributes / markers:**
- `TurnNotificationGate` — arm/clear latch consumed by turn-lifecycle logic
- `stateContext` — DI bag passed to `buildState` so projections have host-provided data (tab list, session paths, favorites)

**Namespaces:**
- [src/core/chat/](../../../../src/core/chat/) — host-agnostic. No `vscode` imports allowed here.

## Lifecycle edges

**Depends on:**
- [chat-event-policy](../chat-event-policy/chat-event-policy.md) — reduce path applies classification (orphan sweeps, completion outcome).
- [chat-command-service](../chat-command-service/chat-command-service.md) — `dispatch` routes through the command service before executing intents.
- [tab-registry-and-runtime](../tab-registry-and-runtime/tab-registry-and-runtime.md) — the tab structures the host and service operate on.
- [platform-ports](../platform-ports/platform-ports.md) — the port surface `buildState` reads through and effects that persist / open / notify.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — every `dispatchDirectPrompt` bottoms out in a Pi session prompt.

**Used by:**
- [activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) — activation constructs the `ChatController` that owns the portable `ChatHost`.
- [chat-command-service](../chat-command-service/chat-command-service.md) — routes into `ChatService`; intents are then executed by `ChatHost._executeIntent`.
- [chat-panel-provider](../../06-ui-surfaces-webview/chat-panel-provider/chat-panel-provider.md) — the `ChatController` this panel registers with owns the tab / session state.
- [checkpoint-rollback-redo](../../07-safety-and-reversibility/checkpoint-rollback-redo/checkpoint-rollback-redo.md) — the `FileHistoryTarget` interface routes user-initiated restore / redo.
- [desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md) — the portable `ChatHost` this runtime wires up.
- [launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md) — `LauncherState` is a projection of ChatHost tabs / TabRegistry.
- [message-queuing](../../08-message-flow-discipline/message-queuing/message-queuing.md) — the reducer that owns the queue.
- [tab-registry-and-runtime](../tab-registry-and-runtime/tab-registry-and-runtime.md) — the host constructs and manages the registry and per-tab runtimes; the service reads / mutates them per event.

## See also

- **Rule — host-agnostic means host-agnostic.** No `import * as vscode from 'vscode'`. If the reducer needs UI capability (dialog, open editor, secret storage), add a port to [platform-ports](../platform-ports/platform-ports.md) and inject the adapter.
- **Pattern — three-phase turn accounting.** `beginAgentEnd → completeAgentEnd → settleAgent`. Do not collapse these; each phase has separate side effects (duration recording, projection commit, notification gate resolution).
- **Pattern — dispatch is routing + intent execution.** `ChatCommandService` translates a message into an intent (loadSession, setModel, createTab, …). `ChatHost._executeIntent` performs the host-side side effect. The service does not touch host state directly.
- **Pitfall — queue dispatch requires `agent_settled`, not `agent_end`.** The SDK still reports the session as busy until settlement; auto-dispatching earlier will be rejected. This is one of the load-bearing invariants from [AGENTS.md](../../../../AGENTS.md).
- **Pitfall — do not share tab state.** Each tab owns its own `PiSessionManager`, `DiffManager`, `CheckpointManager`. Never introduce a static shared cache; you will race across tabs.
- **Pattern — `buildState` is the single source of truth for UI.** Do not build ad-hoc partial projections in webviews. If a UI needs a value, add it to `SerializedAgentState`, thread it through `buildState`, and consume from there.
- **Pattern — transcript cursors survive compaction.** Paging reads the full SDK branch, not `AgentSession.state.messages`; a compact only adds a summary entry and therefore does not invalidate earlier-message cursors. A cursor missing after a branch change returns a reset page instead of mixing sibling histories.
- **Pattern — persisted auto names come from the full branch.** `ChatService.updateTabName` migrates an unnamed session from its first full-transcript user message into SDK `session_info`; compact context is never a title source.
