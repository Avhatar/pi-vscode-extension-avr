# Chapter: subagent-manager-and-lifecycle

Spawning a subagent is a *lifecycle*, not a function call. [`SubagentManager`](../../../../src/pi/subagents/manager.ts) creates a `SubagentRun` record, schedules it through a per-parent queue, checks the global [`SubagentCoordinator`](../../../../src/pi/subagents/coordinator.ts) concurrency slot, streams the child's events to the parent, and retains the terminal state for a bounded time so the launcher can show what just finished. Persistence goes through [`SubagentRunStore`](../../../../src/pi/subagents/persistence.ts) so a subagent run survives window reload.

## Article roster

- [subagent-manager-and-lifecycle](subagent-manager-and-lifecycle.md) — `SubagentManager`, `SubagentCoordinator`, `ChildSessionHandle`, terminal retention, mutation routing, persistence.

## Reader task

The reader arrives here to answer one of:

- "What's the default global concurrency limit — where is it configured?"
- "How does a background subagent's result reach the parent conversation?"
- "How long do terminated subagent runs stay visible in the launcher?"
- "Where does the child's transcript get persisted?"

## Neighborhood

- **Registry / resolver** — where the agent definition comes from — is [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md).
- **Write isolation** — worktree vs. shared-workspace lease — is [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md).
- **Extensibility / gating / model refs** are [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md).
- **Launcher rendering** of runs is [Part VI § launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md).

## Non-goals

- The Pi SDK's own child-session mechanics (how a subprocess is spawned, how messages are exchanged) are outside this chapter — see the SDK docs.
- Remote (over-network) subagents are gated but not runtime-enabled; see [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md).
- Cost / rate-limit accounting for child runs — not implemented at this layer.
