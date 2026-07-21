# vscode-workspace-and-diff

## Stance

Two adapters, two shapes. `VsCodeWorkspaceFileState` extends the Node adapter and just supplies the VS Code-specific workspace root / home directory — everything else (`fs.readFileSync`, `fs.writeFileSync`, path normalization) is inherited. That inheritance is deliberate: the standalone desktop host reuses the same Node code path, and VS Code has no filesystem API worth wrapping (its `vscode.workspace.fs` is async-only, unfit for the sync `FileStatePort` contract).

`VsCodeDiffPresenter` is the opposite pattern: it wraps a `TextDocumentContentProvider` registered under the custom `pi-diff:` scheme, stores "before" text there in memory, and invokes `vscode.diff` with a `pi-diff:` URI on the left and the real `file:` URI on the right. Nothing about the before-text is persisted; if the user closes the diff and reopens it later, they get whatever the file is at that moment, not the historical snapshot.

## Role

[`VsCodeDiffPresenter`](../../../../src/adapters/vscode/diff-presenter.ts#L17) implements `DiffPresenterPort`:

- Constructor takes a `DiffContentProvider` (the shared instance registered with VS Code once at activation).
- `openDiff(request: DiffReviewRequest)` handles two cases:
  1. `originalContent` present → stores it in the provider under the URI `pi-diff:${filePath}?before=${toolCallId}` and runs `vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true })`.
  2. `originalContent` absent (the tool deleted the file) → best-effort `openTextDocument` on the real path; catches errors silently since there is nothing meaningful to show.

[`DiffContentProvider`](../../../../src/adapters/vscode/diff-presenter.ts#L5) is a `TextDocumentContentProvider` with an internal `Map<uriString, content>`. Registered once at activation with `vscode.workspace.registerTextDocumentContentProvider('pi-diff', provider)`. The URI's `?before=<toolCallId>` disambiguates repeated edits to the same file — each tool call gets its own before-snapshot cached under a distinct URI.

[`VsCodeWorkspaceFileState`](../../../../src/adapters/vscode/workspace-file-state.ts#L10) extends `NodeWorkspaceFileState`. Its constructor accepts `VsCodeWorkspaceFileStateOptions` (currently empty, extending the Node options). At construction it resolves:

- `workspaceRoot` from `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`. Left undefined when no folder is open — the core handles that case.
- `homeDirectory` from `process.env.HOME ?? process.env.USERPROFILE`.

Every method (`resolvePath`, `captureText`, `readText`, `exists`, `writeText`, `deleteFile`) is inherited unchanged from the Node adapter.

## Role — files under src/adapters/vscode

- [diff-presenter.ts](../../../../src/adapters/vscode/diff-presenter.ts) — this chapter
- [workspace-file-state.ts](../../../../src/adapters/vscode/workspace-file-state.ts) — this chapter
- [session-platform.ts](../../../../src/adapters/vscode/session-platform.ts) — see [vscode-session-platform](../vscode-session-platform/vscode-session-platform.md)
- [output-channel-logger.ts](../../../../src/adapters/vscode/output-channel-logger.ts) — VS Code `OutputChannel` logger
- [raw-storage.ts](../../../../src/adapters/vscode/raw-storage.ts) — RawMode JSONL storage
- [external-url.ts](../../../../src/adapters/vscode/external-url.ts) — `env.openExternal` wrapper
- [chat-platform.ts](../../../../src/adapters/vscode/chat-platform.ts) — `ChatPlatformPorts` factory (Memento-backed state stores)

## Keywords

**Types — file state:**
- `VsCodeWorkspaceFileState` — class [workspace-file-state.ts:10](../../../../src/adapters/vscode/workspace-file-state.ts#L10); extends `NodeWorkspaceFileState`
- `VsCodeWorkspaceFileStateOptions` — same file

**Types — diff:**
- `VsCodeDiffPresenter` — class [diff-presenter.ts:17](../../../../src/adapters/vscode/diff-presenter.ts#L17)
- `DiffContentProvider` — class [diff-presenter.ts:5](../../../../src/adapters/vscode/diff-presenter.ts#L5)
- `DiffReviewRequest` — port type from [file-state.ts](../../../../src/core/ports/file-state.ts); carries `filePath`, `absolutePath`, `toolCallId`, `originalContent`

**Methods:**
- `openDiff(request)` — [diff-presenter.ts:17](../../../../src/adapters/vscode/diff-presenter.ts#L17)
- `provideTextDocumentContent(uri)` — VS Code API contract
- `setContent(uri, content)` — [diff-presenter.ts:5](../../../../src/adapters/vscode/diff-presenter.ts#L5); stores before-content in memory

**Attributes / markers:**
- `pi-diff:` — custom URI scheme; registered once at activation
- `?before=<toolCallId>` — query param on the URI, disambiguates repeated edits to the same file
- `{ preview: true }` — VS Code diff option: opens in preview mode (not pinned to the tab bar) so repeated diffs don't clog the editor stack

**Namespaces:**
- [src/adapters/vscode/diff-presenter.ts](../../../../src/adapters/vscode/diff-presenter.ts)
- [src/adapters/vscode/workspace-file-state.ts](../../../../src/adapters/vscode/workspace-file-state.ts)

## Lifecycle edges

**Depends on:**
- [node-platform-adapters](../node-platform-adapters/node-platform-adapters.md) — `VsCodeWorkspaceFileState` extends `NodeWorkspaceFileState`; every file operation is inherited.
- [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — the port contracts these classes implement.
- [Part I § activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) — `DiffContentProvider` is registered once from `activate()` with `vscode.workspace.registerTextDocumentContentProvider`.
## See also

- **Rule — `pi-diff:` content is in-memory only.** Do not persist it to disk. Do not attempt to restore it after `Reload Window`. If the user needs the historical snapshot after a reload, [Part VII § checkpoint-rollback-redo](../../07-safety-and-reversibility/checkpoint-rollback-redo/checkpoint-rollback-redo.md) is the persistent side.
- **Rule — one `TextDocumentContentProvider` registration per scheme, at activation.** Registering more than once produces overlapping providers and undefined content resolution.
- **Pattern — subclass Node adapter for VS Code-supplied paths.** Save code, save divergence. The only VS Code-specific behavior at file-state level is *where* the workspace root comes from; the actual `fs` calls are identical.
- **Pattern — `?before=<toolCallId>` disambiguates.** If a tool edits the same file twice in one turn, each call gets its own snapshot URI. Without the query param, the second edit would overwrite the first's before-content in the provider map.
- **Pitfall — `openDiff` for a deleted file is best-effort.** VS Code can't diff against nothing. The current code opens the real (missing) file and swallows the error; callers should not treat a rejection here as a failure.
- **Pitfall — `workspaceRoot` may be undefined.** No workspace open, single-file editing, etc. The core handles `undefined` explicitly; do not add a fallback that guesses a directory.
