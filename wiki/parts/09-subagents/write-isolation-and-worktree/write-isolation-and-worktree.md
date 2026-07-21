# write-isolation-and-worktree

## Stance

Two invariants hold. **Read-only children need no isolation.** If a child's tool list contains no write tools (`edit`, `write`), `WriteIsolationManager.prepare` does nothing — no lease, no worktree, no cleanup. **Write-capable background children require a worktree.** The manager throws otherwise; background = the parent isn't watching, and a shared-workspace race can silently corrupt files without any user seeing.

The distinction between shared-workspace and worktree is the safety envelope. Shared-workspace requires foreground execution + a single-writer lease. Worktree requires git + provides parallel isolation, but the parent must review and apply the diff manually — the child's writes do not automatically appear in the primary workspace.

## Role

[`WriteIsolationManager`](../../../../src/pi/subagents/write-isolation.ts#L16) — one per host.

`prepare(spec, agentId): WriteExecutionLease` [write-isolation.ts:16](../../../../src/pi/subagents/write-isolation.ts#L16):

- `hasWrites(spec)` [write-isolation.ts:24](../../../../src/pi/subagents/write-isolation.ts#L24) — checks `spec.tools` for `'edit' | 'write'`. If none, returns a no-op lease.
- **Worktree mode**: creates `${storageRoot}/subagents/worktrees/{agentId}` via `git worktree add --detach`; returns a lease with `isolationPath = <worktree path>` and a `release()` that ultimately calls `cleanupWorktree`.
- **Shared-workspace mode**: acquires the single writer lease in `sharedLeases: Map<workspacePath, agentId>`; throws if another agent is holding it. `release()` clears the map entry.
- **Background write without worktree**: throws `"Background write-capable subagents require isolation=worktree"` [write-isolation.ts:45](../../../../src/pi/subagents/write-isolation.ts#L45).

Worktree operations:

- `getWorktreeDiff(agentId)` [write-isolation.ts:65](../../../../src/pi/subagents/write-isolation.ts#L65) — runs `git add --intent-to-add .` (so untracked files show up), then `git diff --binary HEAD`. Returns the patch string.
- `applyWorktree(agentId)` [write-isolation.ts:76](../../../../src/pi/subagents/write-isolation.ts#L76) — writes the diff to a temp patch, runs `git apply --index` in the primary workspace, deletes the patch.
- `cleanupWorktree(agentId)` [write-isolation.ts:88](../../../../src/pi/subagents/write-isolation.ts#L88) — `git worktree remove --force` + recursive `rm`.

`isLeaseHeld(workspace)` [write-isolation.ts:96](../../../../src/pi/subagents/write-isolation.ts#L96) — introspection.

`WriteExecutionLease`:

- `cwd` — the directory the child will run in (primary workspace for shared-workspace, worktree path for worktree).
- `isolationPath?` — set only in worktree mode; used by `routeSubagentMutation` to gate parent-level event handling.
- `release()` — cleanup callback.

## Keywords

**Types:**
- `WriteIsolationManager` — class [write-isolation.ts:16](../../../../src/pi/subagents/write-isolation.ts#L16)
- `WriteExecutionLease` — [write-isolation.ts:17](../../../../src/pi/subagents/write-isolation.ts#L17); `cwd`, `isolationPath?`, `release()`

**Methods:**
- `prepare(spec, agentId)` — [write-isolation.ts:16](../../../../src/pi/subagents/write-isolation.ts#L16)
- `hasWrites(spec)` — [write-isolation.ts:24](../../../../src/pi/subagents/write-isolation.ts#L24)
- `getWorktreeDiff(agentId)` — [write-isolation.ts:65](../../../../src/pi/subagents/write-isolation.ts#L65)
- `applyWorktree(agentId)` — [write-isolation.ts:76](../../../../src/pi/subagents/write-isolation.ts#L76)
- `cleanupWorktree(agentId)` — [write-isolation.ts:88](../../../../src/pi/subagents/write-isolation.ts#L88)
- `isLeaseHeld(workspace)` — [write-isolation.ts:96](../../../../src/pi/subagents/write-isolation.ts#L96)

**Attributes / markers:**
- Worktree path pattern: `${storageRoot}/subagents/worktrees/{agentId}`
- Write tools that trigger isolation: `edit`, `write`
- Diff produced by: `git diff --binary HEAD` after `git add --intent-to-add .`
- Apply command: `git apply --index`
- Background write without worktree = error, not silent fallback

**Namespaces:**
- [src/pi/subagents/write-isolation.ts](../../../../src/pi/subagents/write-isolation.ts)
- [src/pi/subagents/mutations.ts](../../../../src/pi/subagents/mutations.ts) — consumes `isolationPath`

## Lifecycle edges

**Depends on:**
- [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — `prepare()` is called before child creation; `release()` is called on child settlement.
- [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md) — the definition's `isolation` field controls the mode.

**Used by:**
- [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md) — `PiChildSessionFactory` calls the isolation manager before `SessionManager` creation.
- [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — write lease is prepared before child creation.

## See also

- **Rule — worktree required for background writes.** Never lift this. Background = parent isn't watching; racing the shared workspace corrupts silently.
- **Rule — shared-workspace lease is exclusive.** The `sharedLeases` map holds one agentId per workspace path. Attempting to `prepare` a second write-capable child while the lease is held throws.
- **Pattern — `--intent-to-add` makes untracked files visible.** Without it, `git diff` skips untracked files, and a child that created a new file would produce an empty diff. Do not remove.
- **Pattern — worktrees share the object database.** Cheap to create, cheap to remove. Full clones would be ~10× slower. If a future need requires full isolation, add it as a third mode, don't repurpose worktree.
- **Pitfall — `--force` on `git worktree remove` deletes uncommitted work in the worktree.** The child's changes must be captured via `getWorktreeDiff` *before* cleanup, or they are lost. Order: diff → apply (maybe) → cleanup.
- **Pitfall — `git apply --index` fails on conflicts.** The current implementation surfaces the failure; the user must resolve manually. Do not swallow the error.
- **Pattern — `isolationPath` in the lease is the routing key.** [`routeSubagentMutation`](../../../../src/pi/subagents/mutations.ts#L1) inspects it: set → worktree (parent doesn't see child edits), unset → shared-workspace (parent DiffManager sees edits normally).
