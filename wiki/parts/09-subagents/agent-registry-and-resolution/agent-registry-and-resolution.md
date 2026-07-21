# agent-registry-and-resolution

## Stance

Discovery is **priority-ordered but content-authoritative** — the priority determines who wins the name, but the winner's definition is used verbatim. Runtime > project > claude-compat (project scope) > user > claude-compat (user scope) > package. This ordering exists so a repo can override any name from any source by defining it locally, and so bundled defaults never quietly shadow user intent.

Resolution is **strictly filtering**, not creation. `resolveAgentSpec` takes an invocation, applies the definition's defaults, then filters through invocation constraints, then through policy constraints; it does not invent tools or models. If the invocation asks for a model the policy forbids, the resolver returns a diagnostic — it does not pick something similar.

## Role

[`AgentRegistry`](../../../../src/pi/subagents/registry.ts#L83) loads agent definitions from five sources:

- **Runtime** — programmatically registered (tests, dev scenarios).
- **Project** — `.agents/agents/**/*.md` and `.pi/agents/**/*.md` from the workspace.
- **Claude-compat project** — `.claude/agents/**/*.md` from the workspace, adapted through [`indexClaudeAgents`](../../../../src/pi/subagents/claude-agents.ts#L27).
- **User** — `~/.agents/agents/**/*.md` and `~/.pi/agent/agents/**/*.md`.
- **Claude-compat user** — `~/.claude/agents/**/*.md`.
- **Package** — every dependency whose `package.json` declares `pi.agents` [package-agents.ts:18](../../../../src/pi/subagents/package-agents.ts#L18); paths are validated to stay inside the package root.

Priority [registry.ts:37](../../../../src/pi/subagents/registry.ts#L37): `runtime(0)`, `project(10)`, `claude-compat project(20)`, `user(30)`, `claude-compat user(35)`, `package(40)`. Lower number wins.

Parsing [registry.ts:158](../../../../src/pi/subagents/registry.ts#L158) — YAML frontmatter fields:

- `name` — must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
- `description` — free-form, used by the parent for routing.
- `model` — `'inherit'`, or a `{provider, id}` ref, or a string `'provider/id'`.
- `tools` — allowlist (subset of `activeTools`).
- `disallowedTools` — denylist.
- `maxTurns`, `timeoutMinutes`, `background`, `isolation` (`'shared-workspace' | 'worktree'`), `contextMode`.

Discovery hygiene: `discoverMarkdownFiles` [registry.ts:343](../../../../src/pi/subagents/registry.ts#L343) rejects symlinks and canonicalizes via `realpath` before parsing, so a malicious symlink cannot exfiltrate paths outside the trust boundary.

Selection [registry.ts:290](../../../../src/pi/subagents/registry.ts#L290) — for each name, the lowest-priority source wins; duplicates from other sources become `shadowed-definition` diagnostics.

Diagnostics [types.ts:43](../../../../src/pi/subagents/types.ts#L43): `read-error`, `frontmatter-error`, `invalid-definition`, `duplicate-name`, `shadowed-definition`, `untrusted-project`. Surfaced to the parent agent (and to the launcher) so users can see what got adapted / shadowed / rejected.

Resolver [resolver.ts:30](../../../../src/pi/subagents/resolver.ts#L30) — `resolveAgentSpec(invocation, definition, policy)`:

1. `resolveModel(invocation, definition, policy)` [resolver.ts:91](../../../../src/pi/subagents/resolver.ts#L91) — priority: `policy.forced > invocation.model > definition.model > policy.default > policy.parent`. Rejects if the result violates `policy.allowedModels`.
2. `resolveTools(invocation, definition, policy)` [resolver.ts:168](../../../../src/pi/subagents/resolver.ts#L168) — starts from `policy.childSafeTools`, filters by `definition.tools` allowlist, then `invocation.tools`, subtracts `definition.disallowedTools`, `invocation.disallowedTools`, `policy.hardDeniedTools = ['subagent']`. The `'subagent'` denial enforces depth-1: children cannot spawn children.
3. `resolveThinkingLevel(...)` [resolver.ts:238](../../../../src/pi/subagents/resolver.ts#L238) — invocation > definition > policy.defaultThinkingLevel > policy.parentThinkingLevel.

`ToolResolutionTrace` [types.ts:125](../../../../src/pi/subagents/types.ts#L125) is the audit trail: `{ registered, active, childSafe, definitionAllowlist, invocationAllowlist, denied, effective }`. Surfaced to the parent for diagnostics.

## Keywords

**Types — registry:**
- `AgentRegistry` — class [registry.ts:83](../../../../src/pi/subagents/registry.ts#L83)
- `AgentDefinition` — [types.ts:10](../../../../src/pi/subagents/types.ts#L10)
- `AgentSource` — `'runtime' | 'project' | 'user' | 'package' | 'claude-compat'`
- `SOURCE_PRIORITY` — [registry.ts:37](../../../../src/pi/subagents/registry.ts#L37)

**Types — resolver:**
- `SubagentInvocation` — [types.ts:71](../../../../src/pi/subagents/types.ts#L71)
- `SubagentResolutionPolicy` — [types.ts:88](../../../../src/pi/subagents/types.ts#L88)
- `ToolResolutionTrace` — [types.ts:125](../../../../src/pi/subagents/types.ts#L125)
- `RemoteAgentConfiguration` — [extensibility-policy.ts:1](../../../../src/pi/subagents/extensibility-policy.ts#L1); gated future feature

**Types — diagnostics:**
- `SubagentDiagnostic` — union [types.ts:43](../../../../src/pi/subagents/types.ts#L43)

**Methods — registry:**
- `parseAgentFile(path, source, scope)` — [registry.ts:158](../../../../src/pi/subagents/registry.ts#L158)
- `discoverMarkdownFiles(root)` — [registry.ts:343](../../../../src/pi/subagents/registry.ts#L343); rejects symlinks
- `selectDefinitions(...)` — [registry.ts:290](../../../../src/pi/subagents/registry.ts#L290); priority + duplicates

**Methods — resolver:**
- `resolveAgentSpec(invocation, definition, policy)` — [resolver.ts:30](../../../../src/pi/subagents/resolver.ts#L30)
- `resolveModel`, `resolveTools`, `resolveThinkingLevel` — same file

**Methods — sources:**
- `indexPackageAgents(packageRoot)` — [package-agents.ts:18](../../../../src/pi/subagents/package-agents.ts#L18)
- `indexClaudeAgents(homeDir, workspaceDir)` — [claude-agents.ts:27](../../../../src/pi/subagents/claude-agents.ts#L27)
- `parseClaudeAgentFile(path, scope)` — [claude-agents.ts:60](../../../../src/pi/subagents/claude-agents.ts#L60)

**Attributes / markers:**
- Directory conventions (in priority order):
  - Project: `.agents/agents/**/*.md`, `.pi/agents/**/*.md`
  - Claude project: `.claude/agents/**/*.md`
  - User: `~/.agents/agents/**/*.md`, `~/.pi/agent/agents/**/*.md`
  - Claude user: `~/.claude/agents/**/*.md`
- Hard denial: `['subagent']` — children cannot spawn children
- Name pattern: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`

**Namespaces:**
- [src/pi/subagents/registry.ts](../../../../src/pi/subagents/registry.ts)
- [src/pi/subagents/resolver.ts](../../../../src/pi/subagents/resolver.ts)
- [src/pi/subagents/types.ts](../../../../src/pi/subagents/types.ts)
- [src/pi/subagents/package-agents.ts](../../../../src/pi/subagents/package-agents.ts)
- [src/pi/subagents/claude-agents.ts](../../../../src/pi/subagents/claude-agents.ts)

## Lifecycle edges

**Depends on:**
- [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md) — Claude agent adaptation uses the tool-compat and boundary wrappers there.
- [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — the consumer of `resolveAgentSpec` output.
- [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md) — model refs / policy / child-tool factories.

**Used by:**
- [subagent-extensibility](../subagent-extensibility/subagent-extensibility.md) — definitions carry model refs that this module validates.
- [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — spec resolution feeds the manager.
- [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md) — the definition's `isolation` field controls the mode.

## See also

- **Rule — depth is 1.** `'subagent'` is in `hardDeniedTools`. Never remove it. If nested delegation is ever needed, design a separate mechanism; do not lift the ban silently.
- **Rule — symlinks are rejected during discovery.** `discoverMarkdownFiles` refuses symlinks so a malicious project cannot claim to define agents at arbitrary paths. Any new source must maintain the invariant.
- **Pattern — priority is stable and named.** `SOURCE_PRIORITY` is a small const table; do not scatter priority numbers through the code. Adding a new source means adding to the table and choosing where it sits.
- **Pattern — the resolver only filters.** It does not fall back to alternatives. If the requested model is unavailable, return a diagnostic; the parent decides what to do. This makes behavior predictable and auditable.
- **Pitfall — `duplicate-name` and `shadowed-definition` are different.** Duplicate = same name in the same source (unrecoverable error). Shadowed = same name in a different source (informational; the winner is deterministic).
- **Pitfall — `untrusted-project` blocks project sources when workspace is untrusted.** VS Code marks the workspace untrusted on first open; project agents don't load until the user grants trust. Do not silently upgrade to "trusted" from within registry code.
- **Pattern — Claude-compat adaptation uses tool-compat.** Claude tool names get mapped via [`resolveClaudeToolReference`](../../../../src/pi/claude-compat/tool-compat.ts); the wrapped body carries the standard boundary preamble.
