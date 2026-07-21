# node-platform-adapters

## Stance

The Node adapters are the "no VS Code" implementation of the same ports. Two properties matter. **Every piece of state that could conflict with another host uses the shared sidecar lock file** — session locks, JSON state store, both — because the standalone desktop app and a VS Code window running against the same repository must not race. **Every adapter is fully DI-testable**: `NodeSessionWorkspace` accepts a callable trust source, `CallbackSessionDialogs` accepts explicit callbacks for warning / model selection, `NodeLogger` accepts an injected sink. There is no ambient globals, no environment sniffing.

## Role

Nine classes / factories cover the surface.

**[`NodeWorkspaceFileState`](../../../../src/adapters/node/workspace-file-state.ts#L18)** — synchronous `FileStatePort` implementation using `fs.readFileSync`, `fs.writeFileSync`, `fs.existsSync`, `fs.unlinkSync`. `resolvePath(filePath, mode?)` handles workspace-relative and home-relative paths; `mode === 'workspace-with-home'` expands `~`. `captureText` returns a `FileTextSnapshot` discriminated union, distinguishing missing (via ENOENT), unreadable (any other error), and present. Constructor accepts callable thunks for `workspaceRoot`, `cwd`, `homeDirectory` so subclasses (like `VsCodeWorkspaceFileState`) can supply platform-specific sources.

**[`NodeLogger`](../../../../src/adapters/node/logger.ts#L6)** — `Logger` implementation with an injectable sink (defaults to `console.log`).

**[`NodeSessionWorkspace`](../../../../src/adapters/node/session-platform.ts#L27)** — `SessionWorkspacePort`. Constructor takes an explicit workspace root and canonicalizes with `fs.realpathSync.native`. `findFiles` is a tree walker using `minimatch`: recursive traversal with symlink exclusion, sorted directory entries for deterministic ordering, glob include / exclude, case-insensitivity on Windows. This is deliberately custom because there is no `vscode.workspace.findFiles` to lean on.

**[`ObjectSessionSettings`](../../../../src/adapters/node/session-platform.ts#L57)** — `SessionSettingsPort` backed by a plain object. `get(key, fallback)` returns the object's value or the fallback.

**[`CallbackSessionDialogs`](../../../../src/adapters/node/session-platform.ts#L77)** — `SessionDialogPort` with injectable callbacks: `warning?(message)`, `selectModel?(models, placeHolder)`.

**[`createNodeSessionRuntimePorts`](../../../../src/adapters/node/session-platform.ts#L101)** — factory taking `NodeSessionRuntimePortOptions` (required: `workspace`; optional: `settings`, `dialogs`, `bundledPiPackagePaths`, `codexUsage`, `sessionLocks`). Assembles a `SessionRuntimePorts`; defaults `applicationId` in the session lock to `'pi-code-node'`.

**[`NodeSessionLock`](../../../../src/adapters/node/session-lock.ts#L35)** — `SessionLockPort` shared between hosts. Lock file: `${sessionPath}.pi-code.lock`, written with mode `0o600`. `acquire(sessionPath)` uses O_EXCL semantics via `fs.openSync(path, 'wx')`; throws `SessionLockConflictError` with the current owner payload on EEXIST. `recoverStale(sessionPath, expectedOwnerId)` reads the current lock, checks liveness of `processId` on `hostname`, and, if the process is gone plus `staleAfterMs` has elapsed, replaces the file. Lock payload version 1: `{ version: 1, owner: SessionLockOwner }` where owner has `ownerId`, `applicationId`, `processId`, `hostname`, `acquiredAt`.

**[`NodeFileMentions`](../../../../src/adapters/node/file-mentions.ts#L43)** — `FileMentionsPort` with a watched, debounced file index. `ensureIndexed()` walks once, records paths. `search(query, maxSuggestions?)` runs fuzzy match. `augmentPromptIfNeeded(text)` scans for `@mention` patterns and inlines file contents. Watcher rebuilds are debounced (250 ms default) so a `git checkout` doesn't produce a rebuild storm.

**[`JsonStateStore`](../../../../src/adapters/node/json-state-store.ts#L28)** — `StateStore` for `ChatStatePorts`. Backing file: versioned JSON `{ version: 1, values: Record<string, unknown> }`. `open(filePath, options?)` is a static async factory. `get(key, fallback?)` is synchronous against an in-memory snapshot; `update`, `mutate`, `flush` are async and serialized through a write queue. Files larger than 50 MB use a line-by-line reader to bound memory. Optional session lock arg allows concurrent-host safety by claiming the lock before flush.

## Role — Node adapter files

- [workspace-file-state.ts](../../../../src/adapters/node/workspace-file-state.ts) — `NodeWorkspaceFileState`
- [logger.ts](../../../../src/adapters/node/logger.ts) — `NodeLogger`
- [session-platform.ts](../../../../src/adapters/node/session-platform.ts) — session ports + factory
- [session-lock.ts](../../../../src/adapters/node/session-lock.ts) — `NodeSessionLock`
- [file-mentions.ts](../../../../src/adapters/node/file-mentions.ts) — `NodeFileMentions`
- [json-state-store.ts](../../../../src/adapters/node/json-state-store.ts) — `JsonStateStore`
- [chat-platform.ts](../../../../src/adapters/node/chat-platform.ts) — composite factory for `ChatPlatformPorts`

## Keywords

**Types — file state:**
- `NodeWorkspaceFileState` — [workspace-file-state.ts:18](../../../../src/adapters/node/workspace-file-state.ts#L18)
- `NodeWorkspaceFileStateOptions` — same file

**Types — session platform:**
- `NodeSessionWorkspace` — [session-platform.ts:27](../../../../src/adapters/node/session-platform.ts#L27)
- `ObjectSessionSettings` — [session-platform.ts:57](../../../../src/adapters/node/session-platform.ts#L57)
- `CallbackSessionDialogs` — [session-platform.ts:77](../../../../src/adapters/node/session-platform.ts#L77)
- `NodeSessionRuntimePortOptions` — [session-platform.ts:101](../../../../src/adapters/node/session-platform.ts#L101)

**Types — lock:**
- `NodeSessionLock` — [session-lock.ts:35](../../../../src/adapters/node/session-lock.ts#L35)
- `NodeSessionLockOptions` — same file
- `SessionLockOwner`, `SessionLockConflict`, `SessionLockConflictError` — from [core/ports/session-platform.ts](../../../../src/core/ports/session-platform.ts)

**Types — file mentions:**
- `NodeFileMentions` — [file-mentions.ts:43](../../../../src/adapters/node/file-mentions.ts#L43)
- `NodeFileMentionsOptions` — same file

**Types — state store:**
- `JsonStateStore` — [json-state-store.ts:28](../../../../src/adapters/node/json-state-store.ts#L28)

**Types — logger:**
- `NodeLogger` — [logger.ts:6](../../../../src/adapters/node/logger.ts#L6)
- `NodeLogSink` — [logger.ts](../../../../src/adapters/node/logger.ts); default `console.log`

**Methods — factories:**
- `createNodeSessionRuntimePorts(options)` — [session-platform.ts:101](../../../../src/adapters/node/session-platform.ts#L101)

**Attributes / markers:**
- Lock filename convention: `${sessionPath}.pi-code.lock`
- Lock version constant: `1` — bump only when the payload shape changes incompatibly
- State-store version constant: `1` — same rule
- `JsonStateStore` streaming threshold: 50 MB
- `applicationId` for Node-created locks: `'pi-code-node'`

**Namespaces:**
- [src/adapters/node/](../../../../src/adapters/node/) — no `vscode` imports allowed here

## Lifecycle edges

**Depends on:**
- [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — every class implements a port defined there.

**Used by:**
- [desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md) — reused verbatim: `NodeSessionLock`, `JsonStateStore`, `NodeSessionWorkspace`, `NodeFileMentions`, `NodeLogger`.
- [vscode-session-platform](../vscode-session-platform/vscode-session-platform.md) — `NodeSessionLock` is used verbatim (only `applicationId` differs).
- [vscode-workspace-and-diff](../vscode-workspace-and-diff/vscode-workspace-and-diff.md) — `VsCodeWorkspaceFileState` extends `NodeWorkspaceFileState`; every file operation is inherited.
- [writable-session-lock](../../07-safety-and-reversibility/writable-session-lock/writable-session-lock.md) — where `NodeSessionLock` lives.

## See also

- **Rule — no `vscode` imports here.** The Node adapters are the "runs anywhere Node runs" tree. Even a type-only `vscode` import breaks the standalone desktop bundle.
- **Rule — session locks are cross-host.** Both VS Code and Node factories use `NodeSessionLock` against the same file naming rule. Do not add a "faster" host-local lock that skips the sidecar file; you will race the other host.
- **Pattern — DI everywhere.** `NodeSessionWorkspace` takes an explicit root (canonicalized), `NodeLogger` takes a sink, `CallbackSessionDialogs` takes callbacks. Adapters do not read environment variables or globals.
- **Pattern — stream large state files.** `JsonStateStore` switches to line-by-line reading above 50 MB. Do not `JSON.parse(fs.readFileSync(...))` unconditionally — you will OOM on large workspaces.
- **Pitfall — `acquire` may throw `SessionLockConflictError`.** Callers must catch and offer recovery via `recoverStale(expectedOwnerId)` rather than retrying blindly.
- **Pitfall — `NodeFileMentions` watches recursively.** On very large workspaces the watch can be expensive; the debounce buffers bursts, but there is no exclusion list beyond symlinks. If a workspace has directories that should never be indexed, exclude them at a higher level.
- **Pattern — Windows case-insensitivity is explicit.** `NodeSessionWorkspace.findFiles` handles case-fold on Windows, case-sensitive on macOS/Linux. VS Code's own findFiles does the same; the Node adapter mirrors the behavior deliberately.
- **Pattern — factory hardcodes `applicationId`.** `createNodeSessionRuntimePorts` uses `'pi-code-node'`. If a new host emerges, do not reuse this suffix; invent a new one so session-lock owner identity remains diagnostic.
