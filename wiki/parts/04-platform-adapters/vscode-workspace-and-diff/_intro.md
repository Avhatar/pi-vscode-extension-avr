# Chapter: vscode-workspace-and-diff

Two ports from the portable core touch files: [`FileStatePort`](../../../../src/core/ports/file-state.ts) for synchronous read / write / capture, and [`DiffPresenterPort`](../../../../src/core/ports/file-state.ts) for opening the built-in diff editor when a tool proposes an edit. This chapter documents the VS Code implementations of both — [`VsCodeWorkspaceFileState`](../../../../src/adapters/vscode/workspace-file-state.ts) and [`VsCodeDiffPresenter`](../../../../src/adapters/vscode/diff-presenter.ts) — including the virtual `pi-diff:` URI scheme that carries the "before" text into the diff editor.

## Article roster

- [vscode-workspace-and-diff](vscode-workspace-and-diff.md) — the VS Code file-state adapter, the `pi-diff:` `TextDocumentContentProvider`, and how `openDiff` invokes `vscode.diff` under the hood.

## Reader task

The reader arrives here to answer one of:

- "When the agent proposes an edit, how does the extension surface a side-by-side diff?"
- "Why does the file-state adapter subclass a Node adapter — what does the VS Code layer add?"
- "Where does the 'before' text live between the tool call and the moment the user opens the diff?"

## Neighborhood

- The **portable port** definitions (`FileStatePort`, `DiffPresenterPort`, `DiffReviewRequest`, `FileTextSnapshot`) are documented in [platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md).
- The **Node file-state adapter** this class extends is documented in [node-platform-adapters](../node-platform-adapters/node-platform-adapters.md).
- **File-change tracking** (which consumer of these adapters snapshots before-content, computes diffs, and orchestrates undo / redo) is [Part VII § file-change-tracking](../../07-safety-and-reversibility/file-change-tracking/file-change-tracking.md).

## Non-goals

- The actual diff algorithm (Myers) lives in [src/utils/diff.ts](../../../../src/utils/diff.ts); this adapter only presents pre-computed diffs.
- No settings, secrets, or dialogs are covered here — see [vscode-session-platform](../vscode-session-platform/vscode-session-platform.md).
- No workspace search — that's on the session platform's `SessionWorkspacePort`.
