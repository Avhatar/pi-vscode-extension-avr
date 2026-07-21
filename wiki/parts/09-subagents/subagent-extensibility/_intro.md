# Chapter: subagent-extensibility

Between "define an agent in a file" and "ship a general A2A protocol" is a lot of policy — model reference syntax, session-level enable/disable, child-safe tool factories, MCP tools exposed to children, phase-8 extensibility decisions. This chapter documents the smaller ancillary modules that add up to the subagents surface: gating, model refs, completion tool, child-tools registry, extensibility policy declarations, and smoke scenarios.

## Article roster

- [subagent-extensibility](subagent-extensibility.md) — extensibility policy phase-8 decisions, `SubagentCapabilityGate`, `ModelRef` parser/validator, `CompleteSubagentTool`, `ChildToolFactoryRegistry`, `PiChildSessionFactory`, and smoke scenarios.

## Reader task

The reader arrives here to answer one of:

- "How does the user disable subagents for a specific session?"
- "What's the string format for referencing a specific provider/model — is it `provider/id` or an object?"
- "How does a child call `complete_subagent` to terminate?"
- "Where's the whitelist of tools a child is allowed to invoke?"

## Neighborhood

- **Manager / coordinator** is [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md).
- **Agent definition sources** are [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md).
- **Write isolation** is [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md).

## Non-goals

- Remote-agent (A2A) protocols are deferred — the extensibility policy encodes this decision explicitly.
- Persistent agent memory / context forking are deferred — same source.
- Nested delegation is disabled by policy — see the phase-8 decisions.
