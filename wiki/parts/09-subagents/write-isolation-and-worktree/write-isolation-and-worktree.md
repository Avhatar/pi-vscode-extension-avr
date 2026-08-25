# write-isolation-and-worktree

## Stance

Two invariants hold. **Read-only children need no isolation.** If a child's tool list contains no write tools (`edit`, `write`), `WriteIsolationManager.prepare` does nothing — no lease, no worktree, no cleanup. **Write-capable background children require a worktree.** The manager throws otherwise; background = the parent isn't watching, and a shared-workspace race can silently corrupt files without any user seeing.

The distinction between shared-workspace and worktree is the safety envelope. Shared-workspace requires foreground execution + a single-writer lease. Worktree requires git + provides parallel isolation, but the parent must review and apply the diff manually — the child's writes do not automatically appear in the primary workspace.

## Role

[`WriteIsolationManager`](../../../../src/pi/subagents/write-isolation.ts#L16) — one per host.

`prepare(workspaceCwd, agentId, spec, options?): WriteExecutionLease` [write-isolation.ts:40](../../../../src/pi/subagents/write-isolation.ts#L40):

- `hasWrites(spec)` [write-isolation.ts:36](../../../../src/pi/subagents/write-isolation.ts#L36) — checks `spec.tools` for `'edit' | 'write'`. If none, returns a no-op lease.
- **Worktree mode**: creates `${storageRoot}/subagents/worktrees/{agentId}` via `git worktree add --force --detach`; returns a lease with `isolationPath = <worktree path>` and a `release()` that ultimately calls `cleanupWorktree`. `--force` is required because the preceding `fs.rm` deletes the directory without unregistering it, and git then rejects the path as *"missing but already registered"*. With `--detach` that is the only check being overridden — no branch is ever claimed from another worktree.
- **Worktree reattachment**: `options.reattachWorktreePath` reuses the child's existing worktree instead of creating one, which is what makes resume possible for a write-capable isolated child. See the reattachment rule below.
- **Shared-workspace mode**: acquires the single writer lease in `sharedLeases: Map<workspacePath, agentId>`; throws if another agent is holding it. `release()` clears the map entry.
- **Background write without worktree**: throws `"Background write-capable subagents require isolation=worktree"` [write-isolation.ts:73](../../../../src/pi/subagents/write-isolation.ts#L73).

Reattachment [write-isolation.ts:137](../../../../src/pi/subagents/write-isolation.ts#L137) is deliberately strict, and `assertReattachable` rejects four distinct cases: a path outside `worktreesRoot`, a path belonging to a different agent, a directory that no longer exists, and a directory git no longer lists as a registered worktree (or lists as `prunable`). None of them fall back to a fresh worktree, because the create path opens with `fs.rm` — a silent fallback would hand the child an empty tree indistinguishable from a child that did no work, and the parent would review an empty diff and conclude the run failed. Registration is read from `git worktree list --porcelain` [write-isolation.ts:165](../../../../src/pi/subagents/write-isolation.ts#L165) and compared on a normalized key, because git prints forward slashes and on Windows need not match our drive-letter case.

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
- `WriteIsolationManager` — class [write-isolation.ts:28](../../../../src/pi/subagents/write-isolation.ts#L28)
- `WriteExecutionLease` — [write-isolation.ts:10](../../../../src/pi/subagents/write-isolation.ts#L10); `cwd`, `isolationPath?`, `release()`
- `WritePrepareOptions` — [write-isolation.ts:16](../../../../src/pi/subagents/write-isolation.ts#L16); `reattachWorktreePath?`

**Methods:**
- `prepare(workspaceCwd, agentId, spec, options?)` — [write-isolation.ts:40](../../../../src/pi/subagents/write-isolation.ts#L40)
- `hasWrites(spec)` — [write-isolation.ts:36](../../../../src/pi/subagents/write-isolation.ts#L36)
- `getWorktreeDiff(worktreePath)` — [write-isolation.ts:93](../../../../src/pi/subagents/write-isolation.ts#L93)
- `applyWorktree(workspaceCwd, worktreePath)` — [write-isolation.ts:104](../../../../src/pi/subagents/write-isolation.ts#L104)
- `cleanupWorktree(workspaceCwd, worktreePath)` — [write-isolation.ts:116](../../../../src/pi/subagents/write-isolation.ts#L116)
- `isLeaseHeld(workspace)` — [write-isolation.ts:124](../../../../src/pi/subagents/write-isolation.ts#L124)
- `assertReattachable(gitRoot, expected, requested)` — [write-isolation.ts:137](../../../../src/pi/subagents/write-isolation.ts#L137); private, strict reattach gate
- `listWorktrees(gitRoot)` — [write-isolation.ts:165](../../../../src/pi/subagents/write-isolation.ts#L165); private, parses `git worktree list --porcelain`

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
- **Rule — resume reattaches, it never recreates.** A resumed write-capable worktree child must be given `reattachWorktreePath`, and reattachment must fail loudly when the worktree is unusable. The create path begins with `fs.rm` over the whole checkout, so any silent fallback destroys the accumulated work that resume exists to preserve. `PiChildSessionFactory.resume` passes the path the run recorded, and the manager reads it from `SubagentRun.isolationPath`; when nothing is recorded the child either was never isolated or had its worktree cleaned up, and a fresh worktree is then correct — the conversation is what resume reuses, the checkout is only where it works.
- **Rule — shared-workspace lease is exclusive.** The `sharedLeases` map holds one agentId per workspace path. Attempting to `prepare` a second write-capable child while the lease is held throws.
- **Pattern — `--intent-to-add` makes untracked files visible.** Without it, `git diff` skips untracked files, and a child that created a new file would produce an empty diff. Do not remove.
- **Pattern — worktrees share the object database.** Cheap to create, cheap to remove. Full clones would be ~10× slower. If a future need requires full isolation, add it as a third mode, don't repurpose worktree.
- **Pitfall — `--force` on `git worktree remove` deletes uncommitted work in the worktree.** The child's changes must be captured via `getWorktreeDiff` *before* cleanup, or they are lost. Order: diff → apply (maybe) → cleanup.
- **Pitfall — `git apply --index` fails on conflicts.** The current implementation surfaces the failure; the user must resolve manually. Do not swallow the error.
- **Pattern — `isolationPath` in the lease is the routing key.** [`routeSubagentMutation`](../../../../src/pi/subagents/mutations.ts#L1) inspects it: set → worktree (parent does not receive live child edits), unset → shared workspace (parent `DiffManager` tracks and marks them for review, while the chat omits per-child inline diff cards).
- **Rule — the worktree path must reach the parent in model-visible text.** A preserved worktree the parent cannot see is worse than no worktree: the child reports success, the edits are absent from the workspace, and the parent has no id to pass to `review`. [`describeSubagentResult`](../../../../src/pi/subagents/runtime.ts#L134) names both the `agentId` and the worktree in the result text, and `_deliverBackgroundSubagentNotification` repeats them for background children. Putting either fact only in `SubagentToolDetails` does not count — the chat UI renders those, the model does not read them.
- **Pitfall — a worktree path in the parent's context is an invitation to bypass the lifecycle.** `prepare` does not verify that a shared-workspace child's writes land outside `worktreesRoot`, so a parent that learns a sibling's worktree path can dispatch a writer straight into it, defeating the isolation and the review gate at once. The trailer and the tool's prompt guidelines both state that `review` / `apply` / `cleanup` are the only sanctioned access; there is no enforcement behind that instruction yet.
