# Chapter: agent-registry-and-resolution

A subagent is a **named implementation hand** the parent conversation dispatches for a bounded task. Their definitions come from four disjoint sources, each with different trust and priority: project (`.agents/agents/*.md`), user (`~/.agents/agents/*.md`), bundled Pi packages (via their `pi.agents` manifest), and adapted Claude Code agent definitions. [`AgentRegistry`](../../../../src/pi/subagents/registry.ts) loads all four sources, deduplicates by name with a priority hierarchy, and exposes the resolved list to the resolver.

## Article roster

- [agent-registry-and-resolution](agent-registry-and-resolution.md) — sources, priority ordering, YAML frontmatter parsing, resolver that maps an invocation to a concrete run spec (model / tools / thinking-level).

## Reader task

The reader arrives here to answer one of:

- "Where does Pi look for agent definitions?"
- "If the same name is defined in a project and a user file, which wins?"
- "Can a subagent invoke another subagent?"
- "How is the child's tool list computed?"

## Neighborhood

- **Manager lifecycle** — foreground / background execution, queue, retention — is [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md).
- **Write isolation** for children that mutate files is [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md).
- **Extensibility policy** and gating are [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md).
- **Claude agent adaptation** intersects with [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md).

## Non-goals

- The Pi SDK's agent-definition schema is external — this chapter documents Pi Code's *consumption* of it.
- Marketplace / registry of shareable agents is out of scope; agents ship as files or bundled packages.
- Model matchmaking beyond what the resolver does (e.g., "smart routing based on cost") is not implemented.
