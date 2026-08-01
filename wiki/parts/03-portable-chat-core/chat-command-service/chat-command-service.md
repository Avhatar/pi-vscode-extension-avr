# chat-command-service

## Stance

Two things happen when a client message hits the chat core. First, `ChatCommandService.dispatch` decides whether the message is *directly executable* (queue add, file mentions search, undo) or whether it needs to become an *intent* (change model, load session, create tab) that the host resolves. Second, it does slash-command parsing on prompts before they cross into `dispatchDirectPrompt`, catching `/name` and reserving `/compact` for the reducer to expand. The pattern is deliberate: the reducer would rather receive one uniform `dispatchDirectPrompt(text)` than have to sniff slash prefixes; the host would rather receive typed intents than raw messages.

## Role

[`ChatCommandService`](../../../../src/core/chat/chat-command-service.ts#L71) wraps a `ChatService`. Its main method [`dispatch(tab, message, callbacks)`](../../../../src/core/chat/chat-command-service.ts#L74) routes messages by `type`:

- **Prompt commands** (`prompt`, `steer`, `followUp`, `abort`) — first call [`parseNameCommand(text)`](../../../../src/core/chat/chat-command-service.ts#L62) to catch `/name`, then delegate to `chat.dispatchDirectPrompt` or `chat.dispatchStreamingCommand`.
- **Queue controls** (`queueMessage`, `editQueuedMessage`, `removeQueuedMessage`, `cancelQueue`) — call `chat.applyQueueControl`, then `callbacks.publishState()` so the webview sees the new queue.
- **Model / thinking / favorites** (`getModels`, `setModel`, `toggleFavorite`, `setThinkingLevel`) — emit through `callbacks.emit` for read requests, return an intent for writes.
- **Session lifecycle** (`newSession`, `loadSession`, `getSessions`) — return an intent or emit sessions via `callbacks.emit`.
- **Tool toggles** (`setTodoEnabled`, `setSubagentsEnabled`, `setPlanModeEnabled`, `setFileUndoViewEnabled`, `setToolDisabled`, `setToolsBulk`) — return an intent.
- **State queries** (`getState`) — call `callbacks.publishState()`.
- **Tab naming** (`renameTab`) — translate the typed toolbar action into the same `/name` path used by prompt commands, then call `callbacks.handleName` without dispatching a model prompt.
- **File mentions** (`searchWorkspaceFiles`) — call `fileMentions.ensureIndexed`, then emit `workspaceFileSuggestions`.
- **File history** (`undoFileChange`, `restoreCheckpoint`, `redoCheckpoint`) — await the corresponding `chat` method, call `callbacks.notifyFileHistory`, publish state.
- **Tab lifecycle** (`createTab`, `closeTab`, `switchTab`) — return an intent.

The intent taxonomy in [chat-command-service.ts:26](../../../../src/core/chat/chat-command-service.ts#L26) is a discriminated union: `setCacheMode`, `setModel`, `setThinkingLevel`, `toggleFavorite`, `newSession`, `loadSession`, `createTab`, `closeTab`, `switchTab`, and the tool-toggle variants. `ChatHost._executeIntent` is the sole matching switch.

`ChatCommandTab` is a structural type constraint: the tab must satisfy `ChatServiceTab & FileHistoryTarget & session compliance`. That means the service can be reused for hosts with different concrete tab types, as long as they carry the fields the service reads.

The callback surface (`directPrompt`, `streaming`, `fileMentions`, `getFavorites`, `handleName`, `publishState`, `emit`, `notifyFileHistory`) is the host-injection seam. VS Code, Electron, and dev harnesses all wire different implementations of these callbacks.

## Keywords

**Types — service:**
- `ChatCommandService` — class [chat-command-service.ts:71](../../../../src/core/chat/chat-command-service.ts#L71)
- `ChatCommandTab` — [chat-command-service.ts:58](../../../../src/core/chat/chat-command-service.ts#L58); tab structural constraint
- `ChatCommandCallbacks` — [chat-command-service.ts:43](../../../../src/core/chat/chat-command-service.ts#L43)

**Types — intents:**
- `ChatCommandIntent` — discriminated union [chat-command-service.ts:26](../../../../src/core/chat/chat-command-service.ts#L26)
  - `setCacheMode`, `setModel`, `setThinkingLevel`, `toggleFavorite`
  - `newSession`, `loadSession`
  - `createTab`, `closeTab`, `switchTab`
  - `setTodoEnabled`, `setSubagentsEnabled`, `setPlanModeEnabled`, `setFileUndoViewEnabled`, `setToolDisabled`, `setToolsBulk`

**Methods:**
- `dispatch(tab, message, callbacks)` — [chat-command-service.ts:74](../../../../src/core/chat/chat-command-service.ts#L74)
- `parseNameCommand(text)` — static [chat-command-service.ts:62](../../../../src/core/chat/chat-command-service.ts#L62); returns trimmed name (60 char max) or undefined

**Attributes / markers:**
- Slash prefix `/name` — reserved for tab renaming; parsed before prompt dispatch
- Client message `renameTab` — toolbar-native rename intent routed through the same `handleName` callback as `/name`
- Slash prefix `/compact` — reserved; parsed inside `ChatService.dispatchDirectPrompt`

**Namespaces:**
- [src/core/chat/chat-command-service.ts](../../../../src/core/chat/chat-command-service.ts) — the router
- Consumers: [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md), tab controllers in Parts IV / V

## Lifecycle edges

**Depends on:**
- [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — routes into `ChatService`; intents are then executed by `ChatHost._executeIntent`.
- [platform-ports](../platform-ports/platform-ports.md) — the `fileMentions` callback surface bottoms out in the `FileMentionsPort`.

**Used by:**
- [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — `dispatch` routes through the command service before executing intents.
- [message-queuing](../../08-message-flow-discipline/message-queuing/message-queuing.md) — routes user messages into queue commands.
- [slash-commands-and-skills-menu](../../06-ui-surfaces-webview/slash-commands-and-skills-menu/slash-commands-and-skills-menu.md) — `/name` and `/compact` are parsed there when the prompt actually dispatches.
- [steering](../../08-message-flow-discipline/steering/steering.md) — the router that picks which operation to invoke.

## See also

- **Rule — new message types add either a callback branch or an intent variant, not both.** If the host reacts to it, it's an intent. If the reducer handles it end-to-end, it's a callback dispatch.
- **Rule — slash-command parsing lives here.** Do not sniff prefixes in webviews before sending the message; the service is the single point of parsing so the same rule holds across every transport.
- **Pattern — intents are host-agnostic.** `ChatCommandIntent` carries no `vscode.TextEditor` or Electron `WebContents`. The host resolves the intent by looking at its own state and doing the platform-specific side effect (open a panel, execute a VS Code command, focus a window).
- **Pitfall — do not call `publishState()` inside `applyQueueControl`.** The reducer returns; the service publishes. Mixing the two adds a hidden double publish for queue writes.
- **Pattern — `handleName` callback exists because renaming has visual side effects on the host.** The service tells the host "the user wants the tab called X"; the host decides whether that also focuses the tab, updates the launcher, and so on.
- **Pitfall — `getModels` emits from the *service*, not returns.** Model lists can be large; asynchronous emission avoids a `Promise<ModelInfo[]>` return type that would push the caller into `await` semantics.
