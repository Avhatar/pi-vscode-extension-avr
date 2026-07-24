# desktop-host-lifecycle

> **Retired.** Documents the Electron standalone host removed from the working
> tree on 2026-07-22.

## Stance

Three invariants shape the desktop host. **Process-scoped data isolation.** Every launched process gets its own data directory (`sharedDataRoot/processes/<processIdentity>/session-data`) so two concurrently running desktop apps do not collide on shared state. **Workspace trust before session bind.** The user explicitly grants trust per workspace before `ChatHost.initialize()` runs; untrusted workspaces get a confirm dialog and refuse-on-no. **Deadline-coordinated shutdown.** A single `DesktopShutdownCoordinator` bounded at 5 seconds unwinds activation, runtime shutdown, and cleanup — nothing hangs the quit path forever.

## Role

Main entry [main.ts:36](../../../../standalone/desktop/src/main.ts#L36):

- Module state: `mainWindow`, `runtime: DesktopChatRuntime | undefined`, `launchState: DesktopShellState`, `globalState: JsonStateStore`, `workspaceStore: DesktopWorkspaceStore`, `secrets: SafeStorageSecretStore`.
- App identity [main.ts:57](../../../../standalone/desktop/src/main.ts#L57): `${process.pid}-${randomUUID()}` — used as the process identifier for data isolation.
- Lifecycle [main.ts:64](../../../../standalone/desktop/src/main.ts#L64): `before-quit → shutdown`; `window-all-closed → quit`; startup error → `showStartupFailure`.
- Shutdown coordinator [main.ts:73](../../../../standalone/desktop/src/main.ts#L73): 5 s timeout; waits for `activationPromise`; calls cleanup with process-path deletion.
- Startup [main.ts:85](../../../../standalone/desktop/src/main.ts#L85): app ready → menu → JsonStateStore open → DesktopWorkspaceStore init → SafeStorageSecretStore init → shell host + IPC → window.

Workspace activation:

- `activateWorkspace(path)` [main.ts:124](../../../../standalone/desktop/src/main.ts#L124) — deduplicates via `activationPromise`.
- `activateWorkspaceOnce(path)` [main.ts:133](../../../../standalone/desktop/src/main.ts#L133) — realpath canonicalization → trust confirmation → `DesktopChatRuntime` construction → wire emit callback → shell transitions `opening → ready` (or `error`).
- `selectWorkspace()` [main.ts:215](../../../../standalone/desktop/src/main.ts#L215) — `dialog.showOpenDialog` with `createDirectory` permission.
- `confirmWorkspaceTrust(path)` [main.ts:224](../../../../standalone/desktop/src/main.ts#L224) — checks `DesktopWorkspaceStore.isTrusted`; if not, prompts user; on success, calls `trustAndRecordOpened`.

Workspace store [desktop-state.ts:33](../../../../standalone/desktop/src/desktop-state.ts#L33):

- Keyed by SHA256 of canonical workspace path → `pi-code.desktop.workspace.<digest>` in `JsonStateStore`.
- `isTrusted(path)`, `trustAndRecordOpened(path)`, `recordOpened(path)`, `revokeTrust(path)`, `listRecent()` (limit 20, sorted by lastOpenedAt).

Session settings [desktop-state.ts:118](../../../../standalone/desktop/src/desktop-state.ts#L118) — `DesktopSessionSettings` reads/writes with `pi-code.desktop.setting.<key>` prefix; forced values for locked settings (`lsp.enabled: false`, `mcp.importClaudeCode: false` — the desktop app deliberately doesn't expose VS Code-only features).

Secrets [safe-storage-secrets.ts:32](../../../../standalone/desktop/src/safe-storage-secrets.ts#L32) — `SafeStorageSecretStore` wraps Electron's `safeStorage` API; ciphertext stored base64 in `JsonStateStore`. `isSafeStorageCapabilityUsable()` [safe-storage-secrets.ts:70](../../../../standalone/desktop/src/safe-storage-secrets.ts#L70) — verifies encryption backend ≠ `'basic_text'`.

Runtime [host.ts:106](../../../../standalone/desktop/src/host.ts#L106) — `DesktopChatRuntime` implements `DesktopAgentBackend`:

- Owns `ChatHost<DesktopTab>`, TabRegistry, ChatService, caches `cacheMode` / `favorites` in globalState.
- ChatHost construction [host.ts:136](../../../../standalone/desktop/src/host.ts#L136): `factory` → `createTabState`, `commandCallbacks` → directPrompt/steer/compact/prompt, `stateContext` → cache/fileUndo/controls, preferences + effects/eventEffects wiring.
- `initialize()` [host.ts:254](../../../../standalone/desktop/src/host.ts#L254) — loads persisted tabs from `TABS_STATE_KEY`, `host.restoreTabs()`, creates default tab if empty.
- `dispatch()`, `getState()` — pass-through to `host` with shutting-down check.
- `shutdown()` [host.ts:281](../../../../standalone/desktop/src/host.ts#L281) — waits for all session shutdowns, tab dispose, `disposeDependencies` callback.
- `createTabState()` [host.ts:324](../../../../standalone/desktop/src/host.ts#L324) — instantiates `PiSessionManager`, `CheckpointManager`, `DiffManager`.
- `bindTab()` [host.ts:353](../../../../standalone/desktop/src/host.ts#L353) — subscribes to session events, diff changes, todo, subagents.

Window [main.ts:183](../../../../standalone/desktop/src/main.ts#L183) — `BrowserWindow` 1280×820, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, blocks external navigation via `setWindowOpenHandler` (allows only `https://` externally) and `will-navigate` (blocks all in-window navigation).

Process paths [process-paths.ts:12](../../../../standalone/desktop/src/process-paths.ts#L12):

- `resolveDesktopProcessPaths(sharedRoot, processIdentity)` — validates identity as alphanumeric/underscore/dash, returns `sharedDataRoot/processes/<identity>/session-data`.
- `cleanupDesktopProcessPaths(paths)` — recursive removal on shutdown.

Process launcher [process-launcher.ts:28](../../../../standalone/desktop/src/process-launcher.ts#L28) — `launchDesktopProcess()` spawns a new Electron instance detached with `stdio: 'ignore'`; unref-safe.

Shutdown [shutdown.ts:19](../../../../standalone/desktop/src/shutdown.ts#L19) — `DesktopShutdownCoordinator`: deadline-based, bounded stages `waitForActivation → runtime.shutdown() → cleanup`, timeout propagated to each stage.

Build [build.mjs:6](../../../../standalone/desktop/build.mjs#L6):

- Fails fast if `renderer/assets/VT323-Regular.ttf` missing (private submodule).
- Main process bundle: `src/main.ts` → ESM, `node22` target, externals: electron + pi-agent-core + pi-coding-agent + pi-mcp-adapter + pi-web-access.
- Preload bundle: `src/preload.ts` → CJS (Electron requires CJS for preload), `node22`, external `electron`.
- Renderer bundle: `renderer/app.ts` → IIFE, `browser`, `es2022`, no externals.
- Copies `index.html`, `styles.css`, `renderer/assets/` to `dist/`.

## Keywords

**Types — main:**
- `DesktopChatRuntime` — class [host.ts:106](../../../../standalone/desktop/src/host.ts#L106); implements `DesktopAgentBackend`
- `DesktopTab` — tab shape

**Types — state:**
- `DesktopWorkspaceStore` — [desktop-state.ts:33](../../../../standalone/desktop/src/desktop-state.ts#L33)
- `DesktopSessionSettings` — [desktop-state.ts:118](../../../../standalone/desktop/src/desktop-state.ts#L118)
- `SafeStorageSecretStore` — [safe-storage-secrets.ts:32](../../../../standalone/desktop/src/safe-storage-secrets.ts#L32)

**Types — infra:**
- `DesktopShutdownCoordinator` — [shutdown.ts:19](../../../../standalone/desktop/src/shutdown.ts#L19)
- `DesktopShellState` — from IPC contract; drives shell UI

**Methods — activation:**
- `activateWorkspace(path)`, `activateWorkspaceOnce(path)` — [main.ts:124](../../../../standalone/desktop/src/main.ts#L124), [main.ts:133](../../../../standalone/desktop/src/main.ts#L133)
- `selectWorkspace()` — [main.ts:215](../../../../standalone/desktop/src/main.ts#L215)
- `confirmWorkspaceTrust(path)` — [main.ts:224](../../../../standalone/desktop/src/main.ts#L224)

**Methods — runtime:**
- `initialize()` — [host.ts:254](../../../../standalone/desktop/src/host.ts#L254)
- `shutdown()` — [host.ts:281](../../../../standalone/desktop/src/host.ts#L281)
- `createTabState()` — [host.ts:324](../../../../standalone/desktop/src/host.ts#L324)
- `bindTab()` — [host.ts:353](../../../../standalone/desktop/src/host.ts#L353)

**Methods — process paths:**
- `resolveDesktopProcessPaths(root, identity)` — [process-paths.ts:12](../../../../standalone/desktop/src/process-paths.ts#L12)
- `cleanupDesktopProcessPaths(paths)` — [process-paths.ts:31](../../../../standalone/desktop/src/process-paths.ts#L31)
- `launchDesktopProcess()` — [process-launcher.ts:28](../../../../standalone/desktop/src/process-launcher.ts#L28)

**Attributes / markers:**
- Process identity: `${process.pid}-${randomUUID()}`
- Data isolation: `sharedRoot/processes/<identity>/session-data`
- Shutdown deadline: 5 seconds
- Locked settings: `lsp.enabled: false`, `mcp.importClaudeCode: false` (desktop policy)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`
- Preload MUST be CJS (Electron requirement); main can be ESM; renderer is IIFE

**Namespaces:**
- [standalone/desktop/src/main.ts](../../../../standalone/desktop/src/main.ts)
- [standalone/desktop/src/host.ts](../../../../standalone/desktop/src/host.ts)
- [standalone/desktop/src/desktop-state.ts](../../../../standalone/desktop/src/desktop-state.ts)
- [standalone/desktop/src/safe-storage-secrets.ts](../../../../standalone/desktop/src/safe-storage-secrets.ts)
- [standalone/desktop/src/shutdown.ts](../../../../standalone/desktop/src/shutdown.ts)
- [standalone/desktop/src/process-paths.ts](../../../../standalone/desktop/src/process-paths.ts)
- [standalone/desktop/src/process-launcher.ts](../../../../standalone/desktop/src/process-launcher.ts)
- [standalone/desktop/build.mjs](../../../../standalone/desktop/build.mjs)

## Lifecycle edges

**Depends on:**
- [desktop-ipc-contract](../desktop-ipc-contract/desktop-ipc-contract.md) — the IPC layer that renders in the window this host creates.
- [Part IV § node-platform-adapters](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md) — reused verbatim: `NodeSessionLock`, `JsonStateStore`, `NodeSessionWorkspace`, `NodeFileMentions`, `NodeLogger`.
- [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — the portable `ChatHost` this runtime wires up.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — `PiSessionManager` instantiated per tab.
- [Part VII § writable-session-lock](../../07-safety-and-reversibility/writable-session-lock/writable-session-lock.md) — the shared lock semantics prevent this host from racing a VS Code window on the same session file.

**Used by:**
- [desktop-ipc-contract](../desktop-ipc-contract/desktop-ipc-contract.md) — the main-process runtime the host talks to.
- [packaging-and-release](../../11-auxiliary-systems/packaging-and-release/packaging-and-release.md) — the standalone desktop is a *separate* build; the boundary verifier ensures it doesn't leak into the VSIX.

## See also

- **Rule — trust before initialize.** `activateWorkspaceOnce` runs `confirmWorkspaceTrust` *before* constructing `DesktopChatRuntime`. Refusing trust cancels activation cleanly.
- **Rule — process-scoped data.** Every launched process gets its own directory; do not add global state that outlives one process. The two-instance concurrency test would catch a violation.
- **Pattern — the desktop locks features the extension exposes.** `lsp.enabled` and `mcp.importClaudeCode` are forced to `false` in `DesktopSessionSettings`. The desktop is intentionally a smaller surface; do not expose these without a design pass.
- **Pattern — SafeStorage vs. VS Code SecretStorage.** The desktop's `SafeStorageSecretStore` and VS Code's `context.secrets` are both `SecretStore` implementations. `AuthStorage` sees a uniform interface — no host-specific code in the auth bridge.
- **Pitfall — `contextIsolation: true` is non-negotiable.** Turn it off and any renderer XSS becomes RCE via Node access. Do not disable.
- **Pitfall — the `sandbox: false` decision is deliberate.** With sandboxing on, the preload cannot `require('electron')` — some IPC patterns break. The current implementation uses `contextIsolation` + preload as the safety boundary.
- **Pattern — build.mjs fails on missing assets.** The `VT323-Regular.ttf` check catches "you forgot to clone the submodule" early. Do not remove this guard.
- **Pattern — deadlines everywhere.** Shutdown, activation, subagent execution — all bounded. If a new stage is added, propagate the deadline into it; do not introduce unbounded waits.
