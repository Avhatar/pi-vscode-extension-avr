# Chapter: write-isolation-and-worktree

Two children editing the same file races their writes; two children editing in the same shared workspace also race the diff manager's snapshot capture. [`WriteIsolationManager`](../../../../src/pi/subagents/write-isolation.ts) enforces one of two modes: **shared-workspace lease** (only one write-capable child at a time in the primary workspace) or **worktree isolation** (git worktree per child; parent reviews and applies the diff).

## Article roster

- [write-isolation-and-worktree](write-isolation-and-worktree.md) — `WriteIsolationManager.prepare` API, lease semantics, git worktree lifecycle, and the review / apply / cleanup flow.

## Reader task

The reader arrives here to answer one of:

- "How does Pi Code prevent two subagents from writing the same file?"
- "What's inside a worktree — is it a full clone?"
- "How does the parent apply a child's worktree changes back?"
- "Why can't a background subagent write to the shared workspace?"

## Neighborhood

- **Manager lifecycle** invoking `prepare()` before creating a child session is [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md).
- **Mutation routing** — how the diff / checkpoint manager consumes worktree vs. shared-workspace tool events — is documented alongside the manager chapter (`routeSubagentMutation`).
- **Agent definition `isolation` field** — where the choice is expressed — is [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md).

## Non-goals

- Full-clone isolation (separate `git clone`) is not implemented — worktrees share the object database with the primary checkout, which is faster and cheaper.
- Merge conflict resolution when applying a worktree back — the current implementation surfaces the conflict; automatic resolution is out of scope.
- Non-git workspaces cannot use worktree isolation; the manager refuses to run background writes there.
