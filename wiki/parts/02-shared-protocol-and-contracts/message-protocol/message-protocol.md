# message-protocol

## Stance

There is one union of client messages and one union of server messages, and they are the *only* legitimate way to cross the extension-host / webview boundary. Not `postMessage(anyObject)`. Not "just check the type at the receiver". If a new UX feature needs an event or a request, the workflow is: add a discriminator to [src/shared/protocol.ts](../../../../src/shared/protocol.ts) (or one of the sub-partition files), let the compiler mark every reducer non-exhaustive, and follow the failures until every side handles the new case. This is deliberate: the extension has too many transports (VS Code postMessage, Electron IPC, dev harnesses) for informal type discipline to survive.

## Role

[src/shared/protocol.ts](../../../../src/shared/protocol.ts) is a barrel. It re-exports the three transport-partitioned message unions and adds the surfaces that don't cleanly belong to any single transport (settings, launcher, RawMode):

- `AgentClientMessage` / `AgentServerMessage` — agent-domain messages. Live in [src/shared/agent-protocol.ts](../../../../src/shared/agent-protocol.ts). Prompts, model choice, session lifecycle, tab naming, tool toggles, checkpoint / undo, file mentions, queue edits.
- `PlatformClientMessage` / `PlatformServerMessage` — host-capability requests. Live in [src/shared/platform-protocol.ts](../../../../src/shared/platform-protocol.ts). Two members total: `openFile`, `confirmAction`. `PlatformServerMessage` is `never`.
- `VsCodeClientMessage` / `VsCodeServerMessage` — VS Code-specific UI operations. Live in [src/shared/vscode-protocol.ts](../../../../src/shared/vscode-protocol.ts). `openDiff`, `openSettings`, `openKeybindings`, `openChangelog`, `openRawView`, and a single `{ type: 'ready' }` server-side lifecycle marker.

`ClientMessage` in [src/shared/protocol.ts:102](../../../../src/shared/protocol.ts#L102) is `AgentClientMessage | PlatformClientMessage | VsCodeClientMessage`. `ServerMessage` at [src/shared/protocol.ts:332](../../../../src/shared/protocol.ts#L332) mirrors it.

Alongside the top-level unions, this file declares surface-specific message trees that ride on the same transport but are addressed to a specific webview:

- **Launcher tree** — `LauncherClientMessage` [protocol.ts:278](../../../../src/shared/protocol.ts#L278) with 31 discriminators (tab / session CRUD, collapsed section state, tool toggles, settings open) and `LauncherServerMessage` [protocol.ts:312](../../../../src/shared/protocol.ts#L312) which publishes a single `launcherState` snapshot ([`LauncherState`](../../../../src/shared/protocol.ts#L229)).
- **Settings tree** — `SettingsClientMessage` [protocol.ts:316](../../../../src/shared/protocol.ts#L316) covers get / update / API key / OAuth / skill fetch; `SettingsServerMessage` [protocol.ts:335](../../../../src/shared/protocol.ts#L335) publishes `SettingsData` + skills + OAuth state + errors.
- **Raw tree** — see [src/shared/raw-protocol.ts](../../../../src/shared/raw-protocol.ts) for `RawClientMessage` / `RawServerMessage`, plus a Settings-panel-scoped `RawModeSettingsClientMessage`.
- **Control tree** — [src/shared/agent-control-protocol.ts](../../../../src/shared/agent-control-protocol.ts) defines `AgentTabControls`, the portable per-tab bundle carrying `TodoSnapshot`, tool selection, subagent state, and feature toggles.

The [src/shared/interrupted-turn.ts](../../../../src/shared/interrupted-turn.ts) module supplies helpers for detecting persisted turn tails that ended without an assistant response and would otherwise confuse "is this session mid-turn?" checks after a `Reload Window`.

## Keywords

**Types — top-level unions:**
- `ClientMessage` — [src/shared/protocol.ts:102](../../../../src/shared/protocol.ts#L102)
- `ServerMessage` — [src/shared/protocol.ts:332](../../../../src/shared/protocol.ts#L332)

**Types — transport partitions:**
- `AgentClientMessage`, `AgentServerMessage` — [src/shared/agent-protocol.ts:202](../../../../src/shared/agent-protocol.ts#L202)
- `PlatformClientMessage`, `PlatformServerMessage` — [src/shared/platform-protocol.ts:2](../../../../src/shared/platform-protocol.ts#L2)
- `VsCodeClientMessage`, `VsCodeServerMessage` — [src/shared/vscode-protocol.ts:2](../../../../src/shared/vscode-protocol.ts#L2)
- `RawClientMessage`, `RawServerMessage`, `RawModeSettingsClientMessage`, `RawModeSettingsServerMessage` — [src/shared/raw-protocol.ts](../../../../src/shared/raw-protocol.ts)

**Types — data payloads (agent-protocol.ts):**
- `SerializedAgentState` — canonical per-tab shape [agent-protocol.ts](../../../../src/shared/agent-protocol.ts) (compact model-context messages, latest full-transcript page, model, tools, streaming/compacting flags, session metadata, context usage, file changes, cache mode, interrupted-turn marker, controls, pending tools)
- `TranscriptItem`, `TranscriptPage` — stable SDK-entry identities, backwards cursor, full-branch turn count, and reset marker for lazy chat-history loading [agent-protocol.ts](../../../../src/shared/agent-protocol.ts)
- `TabInfo`, `CacheMode`, `CacheEffective` — [agent-protocol.ts:96](../../../../src/shared/agent-protocol.ts#L96)
- `PendingToolInfo` — [agent-protocol.ts:107](../../../../src/shared/agent-protocol.ts#L107)
- `ModelInfo`, `ImageAttachment`, `FileAttachment`, `SkillInfo`, `WorkspaceFileSuggestion`, `SessionInfo` — [agent-protocol.ts:153](../../../../src/shared/agent-protocol.ts#L153)
- `FileChangeInfo` — tracked edit/write payload with optional `subagentAgentId` provenance marker [agent-protocol.ts](../../../../src/shared/agent-protocol.ts)
- `ContextUsageInfo`, `CodexUsageWindow`, `CodexUsageCredits`, `CodexUsageBucket`, `CodexSpendControlLimit`, `CodexUsageSnapshot`, `CodexTurnWindowDelta`, `CodexTurnUsage` — [agent-protocol.ts](../../../../src/shared/agent-protocol.ts)
- `DeepSeekBalanceInfo`, `DeepSeekUsageSnapshot`, `DeepSeekTurnUsage` — DeepSeek account balance, local daily spend, and per-turn/session cost payloads in [agent-protocol.ts](../../../../src/shared/agent-protocol.ts)

**Types — control bundle:**
- `AgentTabControls` — [src/shared/agent-control-protocol.ts:1](../../../../src/shared/agent-control-protocol.ts#L1)
- `TodoSnapshot`, `TaskInfo`, `TaskStatus` — [src/shared/protocol.ts:135](../../../../src/shared/protocol.ts#L135)
- `RegisteredToolInfo`, `ToolSelectionSnapshot` — [protocol.ts:154](../../../../src/shared/protocol.ts#L154)
- `LauncherSubagentStatus`, `LauncherSubagentRun`, `LauncherSubagentSnapshot` — [protocol.ts:185](../../../../src/shared/protocol.ts#L185)

**Types — launcher tree:**
- `LauncherTabInfo`, `LauncherSessionInfo`, `LauncherState` — [protocol.ts:109](../../../../src/shared/protocol.ts#L109), [:120](../../../../src/shared/protocol.ts#L120), [:229](../../../../src/shared/protocol.ts#L229)
- `LauncherClientMessage`, `LauncherServerMessage` — [protocol.ts:278](../../../../src/shared/protocol.ts#L278), [:312](../../../../src/shared/protocol.ts#L312)

**Types — settings tree:**
- `SettingsData` — [protocol.ts:60](../../../../src/shared/protocol.ts#L60)
- `OAuthFlowState`, `OAuthProviderInfo` — [protocol.ts:89](../../../../src/shared/protocol.ts#L89)
- `SettingsClientMessage`, `SettingsServerMessage` — [protocol.ts:316](../../../../src/shared/protocol.ts#L316), [:335](../../../../src/shared/protocol.ts#L335)

**Types — raw tree:**
- `RawEntry`, `RawEntryKind`, `RAW_HARNESS_EVENT_KINDS`, `RAW_SESSION_ONLY_EVENT_KINDS`, `RawRecorderMetaPayload`, `RawSessionSummary`, `RawStorageStats` — [raw-protocol.ts:25](../../../../src/shared/raw-protocol.ts#L25)

**Methods — helpers:**
- `hasIncompleteTurnTail(messages)` — [interrupted-turn.ts:14](../../../../src/shared/interrupted-turn.ts#L14)
- `getLatestTurnLifecycleStatus(entries)` — [interrupted-turn.ts:46](../../../../src/shared/interrupted-turn.ts#L46)
- `hasInterruptedTurnLifecycle(entries)` — [interrupted-turn.ts:64](../../../../src/shared/interrupted-turn.ts#L64)

**Attributes / markers:**
- `TURN_LIFECYCLE_CUSTOM_TYPE = 'pi-code.turn-lifecycle'` — session-entry marker for durable turn lifecycle status [interrupted-turn.ts:1](../../../../src/shared/interrupted-turn.ts#L1)
- Every message type uses a mandatory `type` discriminator; nothing else may collide with it
- Client message `getTranscriptPage` — requests an older current-branch page by `sessionId` and SDK entry cursor; the correlated response carries `TranscriptPage`

**Namespaces:**
- [src/shared/protocol.ts](../../../../src/shared/protocol.ts) — barrel + surface-specific unions
- [src/shared/agent-protocol.ts](../../../../src/shared/agent-protocol.ts) — agent-domain payloads
- [src/shared/agent-control-protocol.ts](../../../../src/shared/agent-control-protocol.ts) — tab-control bundle
- [src/shared/platform-protocol.ts](../../../../src/shared/platform-protocol.ts) — host capability requests
- [src/shared/vscode-protocol.ts](../../../../src/shared/vscode-protocol.ts) — VS Code UI ops
- [src/shared/raw-protocol.ts](../../../../src/shared/raw-protocol.ts) — RawMode
- [src/shared/interrupted-turn.ts](../../../../src/shared/interrupted-turn.ts) — helpers

## Lifecycle edges

**Depends on:**
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `SettingsData` is one of the artefacts declared here and consumed there.

**Used by:**
- [activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) — every registered provider and serializer eventually posts `ServerMessage`s built from these types.
- [agent-connection-client](../agent-connection-client/agent-connection-client.md) — the client's request and event payloads are members of those unions.
- [configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — typed settings messages.
- [launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md) — 31 client messages + 1 server message.
- [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — `DiffReviewRequest` and `RawSessionSummary` reference message-protocol types.
- [protocol-runtime](../protocol-runtime/protocol-runtime.md) — schemas are declared against those message types; any drift is caught here at build time.
- [webview-architecture](../../06-ui-surfaces-webview/webview-architecture/webview-architecture.md) — everything on the wire is a typed union member.

## See also

- **Rule — declare before use.** A new event fired from the extension host must be declared as a `ServerMessage` member *before* wiring the emitter. The reverse ("emit first, add to the union later") skips the compiler's exhaustiveness check and produces reducers that silently ignore the case.
- **Rule — keep transport partitions honest.** `AgentClientMessage` covers agent-domain intent. `PlatformClientMessage` covers host-agnostic capabilities (open file, confirm action). `VsCodeClientMessage` is VS Code-specific. Do not put a "vscode.commands.executeCommand" request into `AgentClientMessage` just because the emitter is convenient — an alternative host will not know what to do with it.
- **Pitfall — the top-level `ClientMessage` re-exports the three partitions.** Do not re-declare a message in `protocol.ts` that already exists in an underlying file. Grep first.
- **Pattern — control state travels bundled.** `AgentTabControls` collapses todos, subagents, tool selection, feature toggles into one field on `SerializedAgentState.controls`. Reducer code never has to hand-roll six subscriptions; it consumes one bundle.
- **Pattern — model context and visible transcript are separate.** `SerializedAgentState.messages` remains the SDK's compact context, while `SerializedAgentState.transcript` carries only the latest page of the complete current branch. Older pages use correlated `getTranscriptPage` responses so compaction never erases user-visible history or forces multi-megabyte state snapshots.
- **Pattern — the interrupted-turn helpers exist because Pi tools may terminate a turn intentionally.** Durable lifecycle markers (`TURN_LIFECYCLE_CUSTOM_TYPE` entries) disambiguate "session was interrupted" from "tool decided to stop"; legacy tool tails without the marker do not activate the interruption UI.
- **Pitfall — do not import protocol files from webview and extension host asymmetrically.** Both sides must resolve to the same declaration; that's why the shared folder is under `src/shared/` and both bundle targets emit it.
