# session-lifecycle

## Stance

The session manager is a coordinator, not the SDK. It owns the *shape* of a session — resource paths, extensions, tool selection, event router wiring, lock ownership — but delegates every actual agent operation to the SDK's `AgentSession`. The two invariants that dominate: **the SDK is externalized**, so every call site that touches it uses `await import('@earendil-works/pi-coding-agent')`; and **the session lock is acquired before the SDK opens the session file**, so a concurrent VS Code window (or standalone desktop) cannot double-mount the same session.

## Role

[`PiSessionManager`](../../../../src/pi/session.ts#L68) is one class per tab. Its main methods form the user-facing contract:

- [`initialize()`](../../../../src/pi/session.ts#L178) — creates the resource loader, opens or creates the SDK session, activates the runtime.
- [`prompt(text, images?, files?)`](../../../../src/pi/session.ts#L680) — SDK `session.prompt()`; marks turn started via `_turnLifecycleOpen = true`.
- [`steer(text, images?, files?)`](../../../../src/pi/session.ts#L692) — mid-turn steering; distinct from `prompt` in that the SDK routes it as an intra-turn signal rather than a new user message.
- [`followUp(text, images?, files?)`](../../../../src/pi/session.ts#L698) — sequential prompt that shares the turn lifecycle with the previous one.
- [`compact(customInstructions?)`](../../../../src/pi/session.ts#L719) — SDK compaction; marks completion when the SDK settles.
- [`abort()`](../../../../src/pi/session.ts#L731) — cancels the current stream.
- [`newSession()`](../../../../src/pi/session.ts#L757) / [`initializeFromPath(sessionPath)`](../../../../src/pi/session.ts#L774) / [`loadSession(sessionPath)`](../../../../src/pi/session.ts#L810) — fresh, restore-by-path, and replace-active variants.
- [`setModel(provider, modelId)`](../../../../src/pi/session.ts#L736), [`setThinkingLevel(level)`](../../../../src/pi/session.ts#L747) — runtime model / thinking control.
- [`applyToolSelection(disabled)`](../../../../src/pi/session.ts#L260) — per-tab tool denylist via `session.setActiveToolsByName()`.
- [`getSessions()`](../../../../src/pi/session.ts#L792) — lists sessions on disk (long-running; hence the 120 s timeout floor documented in [Part II § protocol-runtime](../../02-shared-protocol-and-contracts/protocol-runtime/protocol-runtime.md)).

Turn-lifecycle bookkeeping uses `markTurnStarted() / markTurnCompleted()` at [session.ts:912/918](../../../../src/pi/session.ts#L912); interruption detection consults `getLatestTurnLifecycleStatus` + `hasIncompleteTurnTail` from [interrupted-turn.ts](../../../../src/shared/interrupted-turn.ts).

`_buildResourceLoader()` [session.ts:465](../../../../src/pi/session.ts#L465) is where a session's *world* is assembled. It dynamically imports `DefaultResourceLoader` from the SDK, then supplies:

- `additionalExtensionPaths` — bundled Pi packages resolved via [`getBundledPiPackagePaths`](../../../../src/pi/bundled-packages.ts) (see [bundled-pi-packages](../bundled-pi-packages/bundled-pi-packages.md)).
- `additionalSkillPaths` — Agent Skills paths from [`getStandardSkillPaths()`](../../../../src/pi/standard-resources.ts#L6).
- Extension factories — todo, LSP (opt-in), codex-monitor, raw-recorder, tool-selection-guard, subagent, claude-compat. Factories are functions the SDK invokes at extension activation; each factory has access to session state.

The tool-selection-guard [`createToolSelectionGuard`](../../../../src/pi/tool-selection-guard.ts#L27) closes a subtle hole: even when a tool is on the denylist, the Pi `mcp` gateway would still be able to reach it via proxy. The guard intercepts `mcp` gateway calls and blocks disabled targets.

[`PiSessionRuntime`](../../../../src/pi/session-runtime.ts#L15) is the state-machine wrapper around a single `AgentSession`. It exposes `start<State>()`, `replace<State>()`, `clear()`, `dispose()`. `_install()` binds the listener and returns state; `_invalidateCurrent()` unbinds, disposes, and releases the session lock.

Process CWD is changed to the workspace root before resource discovery [session.ts:314](../../../../src/pi/session.ts#L314) so MCP adapters find `.mcp.json` files at the expected location.

## Keywords

**Types:**
- `PiSessionManager` — class [session.ts:68](../../../../src/pi/session.ts#L68)
- `PiSessionRuntime` — class [session-runtime.ts:15](../../../../src/pi/session-runtime.ts#L15)
- `AgentSession` — SDK type; not our declaration, imported dynamically
- `DefaultResourceLoader` — SDK class; instance built by `_buildResourceLoader`

**Methods — user-facing:**
- `initialize` — [session.ts:178](../../../../src/pi/session.ts#L178)
- `prompt`, `steer`, `followUp`, `compact`, `abort` — [session.ts:680–731](../../../../src/pi/session.ts#L680)
- `newSession`, `initializeFromPath`, `loadSession`, `getSessions` — [session.ts:757–810](../../../../src/pi/session.ts#L757)
- `setModel`, `setThinkingLevel`, `applyToolSelection`, `getRegisteredToolNames`, `getRegisteredToolsInfo` — [session.ts:221–747](../../../../src/pi/session.ts#L221)
- `markTurnStarted`, `markTurnCompleted` — [session.ts:912](../../../../src/pi/session.ts#L912)

**Methods — internal:**
- `_buildResourceLoader` — [session.ts:465](../../../../src/pi/session.ts#L465)
- `_createSessionRuntime` — bootstrap path
- `_activateSessionRuntime` — post-bootstrap binding
- `_install`, `_invalidateCurrent` (runtime) — [session-runtime.ts:115](../../../../src/pi/session-runtime.ts#L115)

**Methods — guards:**
- `createToolSelectionGuard()` — [tool-selection-guard.ts:27](../../../../src/pi/tool-selection-guard.ts#L27)

**Methods — resources:**
- `getStandardSkillPaths()` — [standard-resources.ts:6](../../../../src/pi/standard-resources.ts#L6)

**Attributes / markers:**
- `_turnLifecycleOpen` — internal flag toggled between prompt start and completion
- `additionalExtensionPaths` / `additionalSkillPaths` — resource loader options
- Process CWD change → happens before SDK session opens

**Namespaces:**
- [src/pi/session.ts](../../../../src/pi/session.ts) — `PiSessionManager`
- [src/pi/session-runtime.ts](../../../../src/pi/session-runtime.ts) — `PiSessionRuntime`
- [src/pi/standard-resources.ts](../../../../src/pi/standard-resources.ts) — Agent Skills paths
- [src/pi/tool-selection-guard.ts](../../../../src/pi/tool-selection-guard.ts) — MCP-proxy denylist guard

## Lifecycle edges

**Depends on:**
- [event-router](../event-router/event-router.md) — the manager owns an `EventRouter` and binds it into the SDK session listener.
- [models-and-auth](../models-and-auth/models-and-auth.md) — model resolution and `AuthStorage` bridge.
- [bundled-pi-packages](../bundled-pi-packages/bundled-pi-packages.md) — `additionalExtensionPaths` is fed from this list.
- [claude-sdk-compat](../claude-sdk-compat/claude-sdk-compat.md) — claude-compat extension is one of the factories.
- [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — session platform ports (workspace, settings, dialogs, lock, extensions, codex usage) come from this surface.
- [Part IV § vscode-session-platform](../../04-platform-adapters/vscode-session-platform/vscode-session-platform.md) — the concrete adapter that supplies those ports in the VS Code host.

**Used by:**
- [activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) — each new tab spawns a `PiSessionManager` whose bootstrap is documented there.
- [bundled-pi-packages](../bundled-pi-packages/bundled-pi-packages.md) — the resource loader that consumes the paths is built there.
- [chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — every `dispatchDirectPrompt` bottoms out in a Pi session prompt.
- [claude-sdk-compat](../claude-sdk-compat/claude-sdk-compat.md) — `createClaudeContextExtension` is registered as an ExtensionFactory during resource-loader construction.
- [desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md) — `PiSessionManager` instantiated per tab.
- [lsp-tools](../../11-auxiliary-systems/lsp-tools/lsp-tools.md) — the extension factory is one of the resource-loader factories.
- [models-and-auth](../models-and-auth/models-and-auth.md) — the session consults both singletons during model resolution.
- [plan-mode-and-todos](../../08-message-flow-discipline/plan-mode-and-todos/plan-mode-and-todos.md) — the ToDo extension is one of the factories handed to the resource loader.
- [raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md) — recorder is created / mounted / bound per session.
- [steering](../../08-message-flow-discipline/steering/steering.md) — `PiSessionManager` exposes the three SDK operations.
- [tab-registry-and-runtime](../../03-portable-chat-core/tab-registry-and-runtime/tab-registry-and-runtime.md) — `TabRuntime.session` is a `PiSessionManager` whose disposal semantics originate there.
- [writable-session-lock](../../07-safety-and-reversibility/writable-session-lock/writable-session-lock.md) — session acquisition / release call sites.

## See also

- **Rule — SDK imports are dynamic.** `await import('@earendil-works/pi-coding-agent')` inside async methods; never top-level import. The package is externalized in [esbuild.js](../../../../esbuild.js) and resolved by VS Code's module loader at runtime.
- **Rule — session lock before session open.** `_activateSessionRuntime` acquires the sidecar lock first; the SDK then opens the session file. Reversing the order opens a race with another host / window.
- **Pattern — resource loader is a description, not a build step.** Extension factories, skill paths, package paths are handed to the SDK; the SDK is responsible for validating and loading them.
- **Pattern — turn lifecycle is a marker on the session entry list.** Interrupted turns are detected by inspecting persisted entries (`getLatestTurnLifecycleStatus`) — not by looking at in-memory flags that reset on reload.
- **Pitfall — `process.cwd()` change is load-bearing.** MCP adapters expect to find `.mcp.json` at the workspace root; if the CWD isn't set correctly, they silently miss the file. Do not remove the `chdir` in `_buildResourceLoader`.
- **Pitfall — `applyToolSelection` alone is not enough.** The MCP gateway can proxy to any registered tool; the `tool-selection-guard` extension enforces the denylist at gateway level.
- **Pattern — `PiSessionRuntime.replace<State>()` is atomic.** It invalidates the current session (unbind, dispose, release lock) *before* installing the new one. Callers can rely on "at most one session bound at a time".
