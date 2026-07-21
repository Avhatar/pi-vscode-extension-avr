# file-change-tracking

## Stance

Two rules matter. **Capture before the tool starts.** `DiffManager` subscribes to `tool_execution_start` and reads the pre-tool content synchronously through `FileStatePort.captureText` — synchronously, because the tool executes on the next tick and any delay opens a race. **Diff at tool end.** `tool_execution_end` fires; the manager reads the post-tool content, runs `computeUnifiedDiff`, produces a `FileChangeInfo`, hands it to listeners (the UI, the file-undo view, the checkpoint manager for its own bookkeeping). Everything is in-memory; nothing is persisted to disk beyond what the SDK's session-history JSONL already contains.

## Role

[`DiffManager`](../../../../src/core/files/diff-manager.ts#L25) — one per tab. Constructor subscribes to `tool_execution_start` [diff-manager.ts:41](../../../../src/core/files/diff-manager.ts#L41) and `tool_execution_end` [diff-manager.ts:44](../../../../src/core/files/diff-manager.ts#L44).

Public surface:

- `fileChanges` getter — accumulated `FileChangeInfo[]` for the current session.
- `setCurrentTurn(turn: number)` — records the current message index so `FileChangeInfo` entries carry a turn tag.
- `onFileChange(listener)` — subscription for downstream consumers (webview state, launcher badge, checkpoint bookkeeping).
- `getReview(filePath, toolCallId): DiffReviewRequest` — constructs the request handed to `DiffPresenterPort.openDiff` when the user clicks the inline diff.
- `suspendChangesAfter(turnIndex)` — used during rollback: everything after `turnIndex` is stashed off to the side so `redoChanges()` can bring it back.
- `redoChanges()` — inverse of `suspendChangesAfter`; re-attaches the stashed entries in order.
- `clearAll()` — invoked on session reset.

Internals:

- `_originalContents: Map<absolutePath, string>` — the pre-tool snapshot cache. Keyed by absolute path so consecutive edits to the same file within one turn only capture once. On undo (per-file), the entry is deleted so the next edit re-captures.
- `_onToolStart(event)` [diff-manager.ts:86](../../../../src/core/files/diff-manager.ts#L86) — filters for known write tools (edit, write, delete), calls `fileState.captureText`, stores in `_originalContents`, forwards to `CheckpointManager.recordFileState` for the current turn.
- `_onToolEnd(event)` [diff-manager.ts:113](../../../../src/core/files/diff-manager.ts#L113) — reads post-tool content, calls `computeUnifiedDiff(original, current, filePath)`, emits `FileChangeInfo` to listeners.

Myers diff at [src/utils/diff.ts](../../../../src/utils/diff.ts):

- `computeUnifiedDiff(oldText, newText, filePath, contextLines = 3)` [diff.ts:11](../../../../src/utils/diff.ts#L11) — returns `{ diff: string, stats: DiffStats }`. Splits into lines, calls `myersDiff`, groups the edit-op sequence into hunks with 3 lines of context.
- `myersDiff(a, b)` [diff.ts:51](../../../../src/utils/diff.ts#L51) — linear-time edit-distance implementation returning an `EditOp[]` (`eq | del | add`).

`FileChangeInfo` at [src/shared/agent-protocol.ts:85](../../../../src/shared/agent-protocol.ts#L85): `{ filePath, absolutePath, toolCallId, diff, linesAdded, linesRemoved, turn }`.

## Role — files under src/core/files

- [diff-manager.ts](../../../../src/core/files/diff-manager.ts) — this chapter
- [checkpoint-manager.ts](../../../../src/core/files/checkpoint-manager.ts) — sibling chapter [checkpoint-rollback-redo](../checkpoint-rollback-redo/checkpoint-rollback-redo.md)
- [file-mentions.ts](../../../../src/core/files/file-mentions.ts) — helpers for `@file` mention suggestions (not part of this chapter)

## Keywords

**Types:**
- `DiffManager` — class [diff-manager.ts:25](../../../../src/core/files/diff-manager.ts#L25)
- `FileChangeInfo` — [src/shared/agent-protocol.ts:85](../../../../src/shared/agent-protocol.ts#L85)
- `DiffReviewRequest` — port type [src/core/ports/file-state.ts](../../../../src/core/ports/file-state.ts)
- `DiffStats` — [src/utils/diff.ts](../../../../src/utils/diff.ts)
- `EditOp` — `'eq' | 'del' | 'add'`

**Methods — DiffManager:**
- `fileChanges` getter — [diff-manager.ts:50](../../../../src/core/files/diff-manager.ts#L50)
- `setCurrentTurn(turn)` — [diff-manager.ts:54](../../../../src/core/files/diff-manager.ts#L54)
- `onFileChange(listener)` — [diff-manager.ts:64](../../../../src/core/files/diff-manager.ts#L64)
- `getReview(filePath, toolCallId)` — [diff-manager.ts:72](../../../../src/core/files/diff-manager.ts#L72)
- `suspendChangesAfter(turnIndex)` — [diff-manager.ts:182](../../../../src/core/files/diff-manager.ts#L182)
- `redoChanges()` — [diff-manager.ts:200](../../../../src/core/files/diff-manager.ts#L200)
- `clearAll()` — [diff-manager.ts:216](../../../../src/core/files/diff-manager.ts#L216)

**Methods — Myers:**
- `computeUnifiedDiff(oldText, newText, filePath, contextLines?)` — [src/utils/diff.ts:11](../../../../src/utils/diff.ts#L11)
- `myersDiff(a, b)` — [src/utils/diff.ts:51](../../../../src/utils/diff.ts#L51)

**Methods — internal:**
- `_onToolStart(event)` — [diff-manager.ts:86](../../../../src/core/files/diff-manager.ts#L86); captures original content, forwards to CheckpointManager
- `_onToolEnd(event)` — [diff-manager.ts:113](../../../../src/core/files/diff-manager.ts#L113); reads current, computes diff, emits

**Attributes / markers:**
- Watched tool names: `edit`, `write`, `delete` — hardcoded filter in `_onToolStart`
- Default context lines: `3` — matches GNU diff convention
- `_originalContents` Map cleared per file on undo, not per turn

**Namespaces:**
- [src/core/files/diff-manager.ts](../../../../src/core/files/diff-manager.ts)
- [src/utils/diff.ts](../../../../src/utils/diff.ts)
- [src/providers/diff.ts](../../../../src/providers/diff.ts) — compat re-export

## Lifecycle edges

**Depends on:**
- [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — `FileStatePort.captureText`, `DiffPresenterPort.openDiff`.
- [checkpoint-rollback-redo](../checkpoint-rollback-redo/checkpoint-rollback-redo.md) — `CheckpointManager.recordFileState` is called from `_onToolStart` before diff capture.
- [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md) — subscribes to `tool_execution_start / end`.

**Used by:**
- [checkpoint-rollback-redo](../checkpoint-rollback-redo/checkpoint-rollback-redo.md) — `recordFileState` is called from `DiffManager._onToolStart`; `DiffManager.suspendChangesAfter/redoChanges` mirror this state machine on the diff side.
- [tab-registry-and-runtime](../../03-portable-chat-core/tab-registry-and-runtime/tab-registry-and-runtime.md) — `TabRuntime.diffManager` and `TabRuntime.checkpointManager` are declared there.

## See also

- **Rule — capture must be synchronous.** `FileStatePort.captureText` is sync so the pre-tool snapshot lands before the tool executes on the next tick. Never wrap it in a Promise; you will race the tool.
- **Rule — only known write tools are tracked.** The filter (`edit`, `write`, `delete`) is intentional; adding a new mutating tool must extend the filter, or its changes will not appear in the file-undo view.
- **Pattern — original content is per-file, not per-turn.** If the agent edits `foo.ts` three times in one turn, only the first `_onToolStart` captures the original; subsequent starts hit the cached entry. This is correct: the "before" for the whole turn is the state before the first edit.
- **Pattern — suspend / redo is symmetric.** `suspendChangesAfter(turnIndex)` moves entries out; `redoChanges()` moves them back. The order and content are preserved.
- **Pitfall — `_originalContents` deletion on undo is per-file.** When the user undoes a single file change, its cache entry is removed so a subsequent edit re-captures. Do not clear the whole cache; other files' edits are still tracked.
- **Pitfall — Myers is O(N × M).** For very large files (>10 MB), the diff can become slow. The current code has no size cap; if this becomes a problem, add a threshold in `computeUnifiedDiff` and return a truncated stub.
- **Pattern — the compat re-export at [src/providers/diff.ts](../../../../src/providers/diff.ts) exists for historical callers.** New code should import from `src/core/files/diff-manager.ts` directly.
