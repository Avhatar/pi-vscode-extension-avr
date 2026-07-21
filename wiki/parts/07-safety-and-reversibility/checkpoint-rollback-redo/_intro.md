# Chapter: checkpoint-rollback-redo

The user needs three affordances beyond per-file undo: **restore** — "put the workspace back to how it was N turns ago"; **redo** — "actually, undo that undo"; **discard suspended** — "commit to the rollback, don't offer redo any more". [`CheckpointManager`](../../../../src/core/files/checkpoint-manager.ts) implements the state machine for these operations, tracking per-turn `filesBefore` snapshots and a suspended `filesAfter` queue during a rollback.

## Article roster

- [checkpoint-rollback-redo](checkpoint-rollback-redo.md) — `CheckpointManager` state machine, per-turn checkpoint capture, restore / redo semantics, integration with the assistant tool-call boundary.

## Reader task

The reader arrives here to answer one of:

- "What exactly is captured when the manager 'takes a checkpoint'?"
- "If I restore, then keep editing, then try to redo — what happens?"
- "How is the state machine different from a simple undo stack?"
- "Why is `filesBefore` per-turn and `filesAfter` only present during rollback?"

## Neighborhood

- **File snapshotting** at `tool_execution_start` — the input to this state machine — is [file-change-tracking](../file-change-tracking/file-change-tracking.md).
- **The workspace lock** that prevents concurrent hosts from mutating during rollback is [writable-session-lock](../writable-session-lock/writable-session-lock.md).
- **The `FileHistoryTarget` interface** the chat controller uses to invoke these methods is documented in [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md).

## Non-goals

- Git-based rollback (`git checkout .`) is not this system — Pi Code does its own bookkeeping so it works in non-git directories.
- The diff editor UI that surfaces "restore vs. redo" affordances is [Part VI § chat-panel-provider](../../06-ui-surfaces-webview/chat-panel-provider/chat-panel-provider.md).
- Persistence of checkpoints across `Reload Window` — the current design does not persist; checkpoints live only within a session.
