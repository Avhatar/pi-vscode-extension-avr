# checkpoint-rollback-redo

## Stance

The state machine has three states. **Normal**: `_currentTurn` advances, `_checkpoints` accumulate per-turn `filesBefore` snapshots, `_suspended` is empty. **After restore**: `_rollbackPoint` is set to a message index, all turns after it have moved from `_checkpoints` to `_suspended` with both `filesBefore` and `filesAfter` captured. **After redo**: `_suspended` is empty again, `_rollbackPoint` is null, we're back to normal. Making a *new* edit while `_rollbackPoint` is set discards the suspended queue — you've chosen a different branch, redo is no longer offered. This branching-with-single-suspended-tail is deliberately simpler than a full undo tree: it matches the user model of "undo, then either redo or accept and move on".

## Role

[`CheckpointManager`](../../../../src/core/files/checkpoint-manager.ts#L13) — one per tab.

State:

- `_checkpoints: Map<messageIndex, { filesBefore: Map<absolutePath, content|null> }>` — one entry per user turn that touched files. `content = null` when the file was created by this turn (didn't exist before).
- `_suspended: Map<turnIndex, { filesBefore, filesAfter }>` — populated during restore; empty otherwise.
- `_currentTurn: number` — active message index; `-1` until `startTurn` is called for the first time.
- `_rollbackPoint: number | null` — after `restoreCheckpoint(N)` succeeds, this is `N`; cleared on `redoCheckpoint()` or `discardSuspended()` or on a new mutating turn.

Public methods:

- `startTurn(messageIndex)` [checkpoint-manager.ts:28](../../../../src/core/files/checkpoint-manager.ts#L28) — begins state capture for a new turn. If a prior rollback is still active, calls `discardSuspended()` first (the user is committing to the rolled-back state).
- `recordFileState(filePath, content)` [checkpoint-manager.ts:38](../../../../src/core/files/checkpoint-manager.ts#L38) — called by `DiffManager._onToolStart` on the first edit to a file this turn. Idempotent: subsequent edits to the same file in the same turn are no-ops.
- `restoreCheckpoint(messageIndex)` [checkpoint-manager.ts:50](../../../../src/core/files/checkpoint-manager.ts#L50) — for every turn after `messageIndex`, capture `filesAfter` (current content), move the checkpoint to `_suspended`, write `filesBefore` to disk. Sets `_rollbackPoint`. Returns the list of files touched.
- `redoCheckpoint()` [checkpoint-manager.ts:112](../../../../src/core/files/checkpoint-manager.ts#L112) — for every entry in `_suspended` in order, write `filesAfter` back to disk. Clears `_suspended` and `_rollbackPoint`.
- `discardSuspended()` [checkpoint-manager.ts:147](../../../../src/core/files/checkpoint-manager.ts#L147) — clears `_suspended` without applying. Called when the user starts a new edit after rollback.
- `clearAll()` [checkpoint-manager.ts:156](../../../../src/core/files/checkpoint-manager.ts#L156) — reset on new session.
- `rollbackPoint` getter — signals to the UI whether redo is available.

Integration:

- [`DiffManager._onToolStart` [diff-manager.ts:97](../../../../src/core/files/diff-manager.ts#L97)] calls `checkpoint.recordFileState(...)` after capturing pre-tool content. This establishes the rollback baseline for the current turn.
- [`ChatService`] exposes `startTurn(turnIndex)` and `discardSuspended()` through `FileHistoryTarget` [chat-service.ts:35](../../../../src/core/chat/chat-service.ts#L35). The chat controller calls these from the tab history UI.

## Keywords

**Types:**
- `CheckpointManager` — class [checkpoint-manager.ts:13](../../../../src/core/files/checkpoint-manager.ts#L13)
- `Checkpoint` — `{ filesBefore: Map<absolutePath, content|null> }`
- `SuspendedTurn` — `{ filesBefore, filesAfter }`
- `FileHistoryTarget` — chat-service interface [chat-service.ts:124](../../../../src/core/chat/chat-service.ts#L124); abstracts checkpoint+diff for the controller

**Methods — public:**
- `startTurn(messageIndex)` — [checkpoint-manager.ts:28](../../../../src/core/files/checkpoint-manager.ts#L28)
- `recordFileState(filePath, content)` — [checkpoint-manager.ts:38](../../../../src/core/files/checkpoint-manager.ts#L38)
- `restoreCheckpoint(messageIndex)` — [checkpoint-manager.ts:50](../../../../src/core/files/checkpoint-manager.ts#L50)
- `redoCheckpoint()` — [checkpoint-manager.ts:112](../../../../src/core/files/checkpoint-manager.ts#L112)
- `discardSuspended()` — [checkpoint-manager.ts:147](../../../../src/core/files/checkpoint-manager.ts#L147)
- `clearAll()` — [checkpoint-manager.ts:156](../../../../src/core/files/checkpoint-manager.ts#L156)
- `rollbackPoint` getter — [checkpoint-manager.ts:24](../../../../src/core/files/checkpoint-manager.ts#L24)

**Attributes / markers:**
- Content sentinel: `null` in `filesBefore` means "file did not exist"; on restore, the file is deleted rather than restored.
- Ordering: entries applied in ascending `turnIndex` order during redo — matters for cases where two turns touch the same file.
- Rollback disables redo *only* on a subsequent mutating turn: view-only actions do not clear `_suspended`.

**Namespaces:**
- [src/core/files/checkpoint-manager.ts](../../../../src/core/files/checkpoint-manager.ts)
- [src/providers/checkpoint.ts](../../../../src/providers/checkpoint.ts) — compat re-export

## Lifecycle edges

**Depends on:**
- [file-change-tracking](../file-change-tracking/file-change-tracking.md) — `recordFileState` is called from `DiffManager._onToolStart`; `DiffManager.suspendChangesAfter/redoChanges` mirror this state machine on the diff side.
- [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — `FileStatePort` for reads / writes.
- [Part III § chat-host-and-service](../../03-portable-chat-core/chat-host-and-service/chat-host-and-service.md) — the `FileHistoryTarget` interface routes user-initiated restore / redo.

**Used by:**
- [file-change-tracking](../file-change-tracking/file-change-tracking.md) — `CheckpointManager.recordFileState` is called from `_onToolStart` before diff capture.

## See also

- **Rule — a new mutating turn after rollback discards the suspended queue.** Starting a new turn calls `startTurn`, which observes `_rollbackPoint !== null` and calls `discardSuspended()`. Do not offer redo across a branch that already diverged.
- **Rule — `content = null` is a first-class value.** A file that did not exist before the turn is captured as `null`, not `''`. On restore, the file is deleted; on redo (of a delete), the file is recreated. Conflating null with empty string will silently corrupt undo.
- **Pattern — `restoreCheckpoint` captures `filesAfter` before writing `filesBefore`.** So the redo has something to apply. Order matters: read current content, then write prior content.
- **Pattern — `recordFileState` is idempotent per file per turn.** The first edit to a file within a turn is captured; subsequent edits are ignored, because the turn's baseline is the pre-first-edit state.
- **Pitfall — no cross-turn deduplication.** If turn 3 edits `foo.ts` and turn 5 also edits `foo.ts`, both `_checkpoints[3].filesBefore` and `_checkpoints[5].filesBefore` hold that file's content. Restoring to turn 4 writes `_checkpoints[5].filesBefore` (which is what `foo.ts` looked like at the end of turn 3+beginning of turn 5).
- **Pitfall — checkpoints do not survive a `Reload Window`.** Undo affordances vanish; the user gets the current disk state. This is intentional: persisting checkpoints reliably is a bigger design problem.
- **Pattern — the compat re-export at [src/providers/checkpoint.ts](../../../../src/providers/checkpoint.ts) exists for historical callers.** New code should import directly from the core module.
