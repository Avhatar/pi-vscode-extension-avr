# Chapter: file-change-tracking

Every time the agent invokes `edit` or `write`, Pi Code snapshots the file *before* the tool runs so the user can (a) see a parent edit inline, (b) review tracked parent or shared-workspace child changes in File Undo View, or (c) roll back to a checkpoint. [`DiffManager`](../../../../src/core/files/diff-manager.ts) is the portable per-tab tracker that manages this lifecycle; the Myers diff algorithm at [src/utils/diff.ts](../../../../src/utils/diff.ts) produces the unified-diff payloads that flow into `FileChangeInfo` and into the diff-presenter port.

## Article roster

- [file-change-tracking](file-change-tracking.md) — `DiffManager` per-tab tracker, `computeUnifiedDiff` Myers algorithm, `FileChangeInfo` payload shape, and integration with `CheckpointManager` at tool-start.

## Reader task

The reader arrives here to answer one of:

- "Where does the 'before' content get captured for the inline diff?"
- "When a tool call completes, how is the unified diff produced?"
- "What's the difference between the DiffManager and the CheckpointManager?"
- "How does the redo path preserve suspended changes across a rollback?"

## Neighborhood

- **The checkpoint state machine** — save / restore / redo — is the sibling chapter [checkpoint-rollback-redo](../checkpoint-rollback-redo/checkpoint-rollback-redo.md).
- **The diff presenter port** (which VS Code editor actually opens) is [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md); the concrete VS Code implementation is [Part IV § vscode-workspace-and-diff](../../04-platform-adapters/vscode-workspace-and-diff/vscode-workspace-and-diff.md).
- **`FileChangeInfo`** as a message payload is in [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md).

## Non-goals

- The visual diff editor itself (VS Code's `vscode.diff` command) is not implemented here — this chapter stops at producing the diff.
- Persistence of the pre-tool snapshots to disk is out of scope; the diff-manager keeps them in memory for the session lifetime.
- Language-aware diffing (structural / AST) — Pi Code uses plain textual Myers diff.
