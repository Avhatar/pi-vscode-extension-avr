# platform-ports

## Stance

Ports are interfaces owned by the portable core. Adapters live under `src/adapters/**` and implement them. There is exactly one legal shape of import: **core imports from `src/core/ports/`, adapters from `src/adapters/**`, and the extension host / desktop host wires them together**. No adapter imports another adapter. No core module imports an adapter. If a new capability blurs that line, the answer is to add a new port, not to relax the rule.

Ports are load-bearingly *synchronous* where the reducer requires deterministic ordering. `FileStatePort` methods are all sync because tool-event reduction depends on capturing before-content before the next session event fires. Anything that has to be async goes on a separate port (`DiffPresenterPort`).

## Role

Six ports cover the whole surface.

**`ChatPlatformPorts`** ([src/core/ports/chat-platform.ts:22](../../../../src/core/ports/chat-platform.ts#L22)) aggregates the three families used by the chat host:

- `state: ChatStatePorts` — the workspace + global `StateStore` pair used for persistence.
- `fileMentions: FileMentionsPort` — `isReady`, `ensureIndexed()`, `search(query, maxSuggestions?)`, `augmentPromptIfNeeded(text)`.
- `fileChanges: FileChangePlatformPorts` — bundles the next two.

**`FileChangePlatformPorts`** ([src/core/ports/file-state.ts:39](../../../../src/core/ports/file-state.ts#L39)):

- `fileState: FileStatePort` — synchronous file operations. `resolvePath(filePath, mode?)`, `captureText(absolutePath)` returning a discriminated `FileTextSnapshot` (`present | missing | unreadable`), `readText`, `exists`, `writeText(path, content, options?)`, `deleteFile`.
- `diffPresenter: DiffPresenterPort` — asynchronous UI capability. `openDiff(request: DiffReviewRequest)`.

**`SessionRuntimePorts`** ([src/core/ports/session-platform.ts:109](../../../../src/core/ports/session-platform.ts#L109)) covers everything a Pi session needs:

- `workspace: SessionWorkspacePort` — `getRoot()`, `isTrusted()`, `findFiles(root, include, exclude, maxResults)`.
- `settings: SessionSettingsPort` — `get<Key>(key, fallback)` typed against `SessionSettingValues`.
- `dialogs: SessionDialogPort` — `showWarning(message)`, `selectModel(models, placeHolder)`.
- `resources: SessionResourcePaths` — `bundledPiPackagePaths: string[]`.
- `extensions?: SessionExtensionPort` — `createLspExtension(enabled)`, `syncClaudeCodeMcpImport?(enabled)`.
- `codexUsage: SessionCodexUsagePort` — `updateFromHeaders(headers)`.
- `sessionLocks: SessionLockPort` — `acquire(sessionPath)`, `recoverStale(sessionPath, expectedOwnerId)` returning `SessionLockHandle` (`{ sessionPath, owner, release() }`); errors surface as `SessionLockConflictError` with a `SessionLockConflict` payload.

`DEFAULT_SESSION_RUNTIME_PORTS` supplies no-op stubs so tests can partially override.

**`RawStoragePort`** ([src/core/ports/raw-storage.ts:12](../../../../src/core/ports/raw-storage.ts#L12)) — the RawMode recorder interface: `append`, `readRange`, `getNextSeq`, `list`, `deleteSession`, `clearAll`, `getStorageDir`, optional `getSessionFile`.

**`Logger`** ([src/core/ports/logger.ts:8](../../../../src/core/ports/logger.ts#L8)) — one method, `appendLine(message)`, so the core can emit diagnostics without knowing whether the sink is `console.log` or a VS Code output channel.

**`ExternalUrlPort` / `ExternalUrlService`** ([src/core/ports/external-url.ts](../../../../src/core/ports/external-url.ts)) — the port is `openExternal(url) → Promise<boolean>`; the service wraps it with URL validation (HTTPS / HTTP only, throws on failure).

## Keywords

**Types — ports:**
- `ChatPlatformPorts`, `ChatStatePorts`, `FileMentionsPort` — [chat-platform.ts](../../../../src/core/ports/chat-platform.ts)
- `FileStatePort`, `FileTextSnapshot`, `DiffPresenterPort`, `DiffReviewRequest`, `FileChangePlatformPorts` — [file-state.ts](../../../../src/core/ports/file-state.ts)
- `SessionRuntimePorts`, `SessionWorkspacePort`, `SessionSettingsPort`, `SessionSettingValues`, `SessionDialogPort`, `SessionResourcePaths`, `SessionExtensionPort`, `SessionCodexUsagePort`, `SessionLockPort`, `SessionLockHandle`, `SessionLockOwner`, `SessionLockConflict`, `SessionLockConflictError` — [session-platform.ts](../../../../src/core/ports/session-platform.ts)
- `RawStoragePort`, `RawSessionSummary` (also declared in [raw-protocol.ts](../../../../src/shared/raw-protocol.ts)) — [raw-storage.ts](../../../../src/core/ports/raw-storage.ts)
- `Logger` — [logger.ts](../../../../src/core/ports/logger.ts)
- `ExternalUrlPort`, `ExternalUrlService` — [external-url.ts](../../../../src/core/ports/external-url.ts)

**Types — model selection:**
- `ModelSelection` — from `dialogs.selectModel`; used across settings panel, launcher, and Pi session

**Methods — file state:**
- `resolvePath(filePath, mode?): string` — sync
- `captureText(absolutePath): FileTextSnapshot` — sync; returns discriminated union
- `readText`, `exists`, `writeText`, `deleteFile` — all sync

**Methods — session:**
- `workspace.getRoot(): string | undefined`
- `workspace.isTrusted(): boolean`
- `workspace.findFiles(root, include, exclude, maxResults): Promise<string[]>`
- `settings.get<Key>(key, fallback)`
- `dialogs.showWarning(message)`, `dialogs.selectModel(models, placeHolder)`
- `sessionLocks.acquire(sessionPath)`, `sessionLocks.recoverStale(sessionPath, expectedOwnerId)`
- `codexUsage.updateFromHeaders(headers): boolean`

**Methods — raw storage:**
- `append(sessionPath, line)`
- `readRange(sessionPath, fromSeq, count)`
- `getNextSeq`, `list`, `deleteSession`, `clearAll`, `getStorageDir`

**Attributes / markers:**
- `mode?: 'workspace' | 'workspace-with-home'` — argument to `resolvePath`; controls tilde expansion policy
- `DEFAULT_SESSION_RUNTIME_PORTS` — no-op stubs for test scaffolding

**Namespaces:**
- [src/core/ports/](../../../../src/core/ports/) — the whole port surface. No `vscode` imports, no `fs`, no `path` beyond the type imports the interfaces need.

## Lifecycle edges

**Depends on:**
- [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md) — `DiffReviewRequest` and `RawSessionSummary` reference message-protocol types.

**Used by:**
- [chat-command-service](../chat-command-service/chat-command-service.md) — the `fileMentions` callback surface bottoms out in the `FileMentionsPort`.
- [chat-host-and-service](../chat-host-and-service/chat-host-and-service.md) — the port surface `buildState` reads through and effects that persist / open / notify.
- [checkpoint-rollback-redo](../../07-safety-and-reversibility/checkpoint-rollback-redo/checkpoint-rollback-redo.md) — `FileStatePort` for reads / writes.
- [file-change-tracking](../../07-safety-and-reversibility/file-change-tracking/file-change-tracking.md) — `FileStatePort.captureText`, `DiffPresenterPort.openDiff`.
- [node-platform-adapters](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md) — every class implements a port defined there.
- [raw-mode](../../11-auxiliary-systems/raw-mode/raw-mode.md) — `RawStoragePort` declaration.
- [session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — session platform ports (workspace, settings, dialogs, lock, extensions, codex usage) come from this surface.
- [vscode-session-platform](../../04-platform-adapters/vscode-session-platform/vscode-session-platform.md) — every class implements one of those interfaces.
- [vscode-workspace-and-diff](../../04-platform-adapters/vscode-workspace-and-diff/vscode-workspace-and-diff.md) — the port contracts these classes implement.
- [writable-session-lock](../../07-safety-and-reversibility/writable-session-lock/writable-session-lock.md) — the port surface.

## See also

- **Rule — synchronous where ordering matters.** `FileStatePort` is sync because tool-event reduction depends on capturing before-content before the next session event fires. Do not "promisify" for aesthetic reasons.
- **Rule — new capability = new port.** If the reducer needs "get workspace font size" or "show a toast", add a port; do not sneak a `vscode.window.showToast` into the core.
- **Pattern — sub-ports bundled.** `ChatPlatformPorts` collapses three families into one DI parameter. Callers get a single bag, injection sites stay tidy.
- **Pattern — discriminated snapshots for lossless file capture.** `FileTextSnapshot` is `{ kind: 'present', content } | { kind: 'missing' } | { kind: 'unreadable', error }`. Callers pattern-match; the reducer never conflates "empty file" with "file gone".
- **Pitfall — `sessionLocks` are host-shared.** Both VS Code and standalone desktop use the same sidecar `.pi-code.lock` file. Do not add adapter-local locking; concurrent access from the other host will race.
- **Pitfall — do not add a synchronous variant of `DiffPresenterPort.openDiff`.** UI presentation is inherently async on both hosts; forcing sync would deadlock the reducer.
- **Pattern — `ExternalUrlService` validates before delegating.** Callers should use the service, not the port, unless they have a strong reason to skip validation (e.g. an already-normalized URL).
