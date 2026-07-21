# subagent-extensibility

## Stance

Extensibility here means **more of what already exists**, not new axes. The phase-8 decisions in [extensibility-policy.ts:36](../../../../src/pi/subagents/extensibility-policy.ts#L36) name the choices deliberately deferred: persistent agent memory, remote A2A, context forking, nested delegation. Each is deferred with a reason, not "not yet built" — the reasons matter, and this chapter documents them so future contributors read the reasoning before lifting a policy.

## Role

Six pieces make up the extensibility surface.

**Extensibility policy** [extensibility-policy.ts:36](../../../../src/pi/subagents/extensibility-policy.ts#L36) — `PHASE_8_EXTENSIBILITY_DECISIONS`:

- `persistentAgentMemory: 'deferred-until-encrypted-scope-and-retention-policy'`
- `remoteA2A: 'gated-but-runtime-deferred'`
- `forkContext: 'deferred-to-avoid-parent-context-and-secret-leakage'`
- `nestedDelegation: 'disabled-max-depth-one'`

Plus `RemoteAgentConfiguration` [extensibility-policy.ts:1](../../../../src/pi/subagents/extensibility-policy.ts#L1) and `evaluateRemoteAgentGate()` — the gate checks: enabled + workspaceTrusted + endpoint (HTTPS or loopback) + authConfigured + protocolAdapterConfigured. All must be true; today `enabled` is always false.

**Capability gate** [gating.ts:6](../../../../src/pi/subagents/gating.ts#L6) — `SubagentCapabilityGate`:

- Storage key: `pi-code.subagentsEnabled.<sessionPath>`.
- `isEnabled()`, `setEnabled(value)` — per-session toggle.
- `composeDisabledTools(baseDisabledTools)` [gating.ts:35](../../../../src/pi/subagents/gating.ts#L35) — if not enabled, appends `'subagent'` to the disabled list; if enabled, removes it. This wiring is how the launcher's "Subagents" toggle actually reaches the running session's tool selection.

**Model reference** [model-ref.ts:5](../../../../src/pi/subagents/model-ref.ts#L5) — `parseModelRef(input)`:

- Accepts string `"provider/id"` or object `{provider, id}`.
- `validateModelRef(ref)` [model-ref.ts:20](../../../../src/pi/subagents/model-ref.ts#L20) — `provider` must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`; `id` must be non-empty without whitespace.
- `formatModelRef(ref)` — formats back to `"provider/id"`.
- `sameModelRef(a, b)` — equality helper.

**Completion tool** [completion-tool.ts:14](../../../../src/pi/subagents/completion-tool.ts#L14) — `createCompleteSubagentTool(options)`:

- The tool child agents call to terminate: `{ result, summary?, artifacts?[] }`.
- Fires `onComplete` callback into the manager so the child session shuts down.
- Optional `artifacts[]` carries file references for the parent to inspect.

**Child-tools registry** [child-tools.ts:19](../../../../src/pi/subagents/child-tools.ts#L19) — `ChildToolFactoryRegistry`:

- `register(factory)` — declares a factory (name + create function).
- `listNames()`, `listDiagnostics()`.
- `createTools(names, context)` — instantiates the requested tools for a given child session.
- Name validation: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`; duplicate / invalid names surface as diagnostics.
- `registerChildSafeMcpTool(server, tool)` [child-tools.ts:80](../../../../src/pi/subagents/child-tools.ts#L80) — normalizes hyphens to underscores; returns `{name, dispose}`.

**Pi child session factory** [pi-child-session.ts:23](../../../../src/pi/subagents/pi-child-session.ts#L23):

- Constants: `CHILD_SAFE_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write']`, `READ_ONLY_CHILD_TOOLS = ['read', 'grep', 'find', 'ls']`.
- `PiChildSessionFactory.create(spec)` [pi-child-session.ts:40](../../../../src/pi/subagents/pi-child-session.ts#L40) — prepares write lease, creates a `SessionManager` (persistent or in-memory), acquires session lock if persistent, wires up ChildSessionHandle.

**Smoke scenarios** [src/pi/subagents/smoke/scenarios/](../../../../src/pi/subagents/smoke/scenarios/):

- `registry-resolution` — project/user/package/runtime loading, priority shadowing, frontmatter errors.
- `tool-gating` — child tool availability, unavailable-tool diagnostics, hard-denied nested delegation.
- `foreground-cross-provider`, `background-concurrency` — execution paths.
- `write-worktree` — worktree isolation, lease enforcement, mutation routing.
- `launcher-lifecycle`, `persistence-control`, `compatibility-sources` — end-to-end integration.

## Keywords

**Types — policy:**
- `PHASE_8_EXTENSIBILITY_DECISIONS` — [extensibility-policy.ts:36](../../../../src/pi/subagents/extensibility-policy.ts#L36)
- `RemoteAgentConfiguration` — [extensibility-policy.ts:1](../../../../src/pi/subagents/extensibility-policy.ts#L1)
- `evaluateRemoteAgentGate` — same file

**Types — gate:**
- `SubagentCapabilityGate` — [gating.ts:6](../../../../src/pi/subagents/gating.ts#L6)

**Types — model ref:**
- `ModelRef` — `{provider, id}` [model-ref.ts:5](../../../../src/pi/subagents/model-ref.ts#L5)
- `parseModelRef`, `validateModelRef`, `formatModelRef`, `sameModelRef`

**Types — child tools:**
- `ChildToolFactory` — [child-tools.ts](../../../../src/pi/subagents/child-tools.ts)
- `ChildToolFactoryRegistry` — [child-tools.ts:19](../../../../src/pi/subagents/child-tools.ts#L19)
- `CHILD_SAFE_TOOLS`, `READ_ONLY_CHILD_TOOLS` — [pi-child-session.ts:23](../../../../src/pi/subagents/pi-child-session.ts#L23)

**Types — completion:**
- `createCompleteSubagentTool(options)` — [completion-tool.ts:14](../../../../src/pi/subagents/completion-tool.ts#L14)

**Types — child session:**
- `PiChildSessionFactory` — [pi-child-session.ts:40](../../../../src/pi/subagents/pi-child-session.ts#L40)

**Methods:**
- `SubagentCapabilityGate.composeDisabledTools` — [gating.ts:35](../../../../src/pi/subagents/gating.ts#L35)
- `ChildToolFactoryRegistry.createTools(names, ctx)` — [child-tools.ts](../../../../src/pi/subagents/child-tools.ts)
- `registerChildSafeMcpTool(server, tool)` — [child-tools.ts:80](../../../../src/pi/subagents/child-tools.ts#L80)

**Attributes / markers:**
- Gate storage key: `pi-code.subagentsEnabled.<sessionPath>`
- Hard-denied: `['subagent']` — enforces depth-1
- Model-ref format: `"provider/id"` or `{provider, id}`
- Name pattern: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`
- Phase-8 deferred decisions: persistentAgentMemory, remoteA2A, forkContext, nestedDelegation

**Namespaces:**
- [src/pi/subagents/extensibility-policy.ts](../../../../src/pi/subagents/extensibility-policy.ts)
- [src/pi/subagents/gating.ts](../../../../src/pi/subagents/gating.ts)
- [src/pi/subagents/model-ref.ts](../../../../src/pi/subagents/model-ref.ts)
- [src/pi/subagents/completion-tool.ts](../../../../src/pi/subagents/completion-tool.ts)
- [src/pi/subagents/child-tools.ts](../../../../src/pi/subagents/child-tools.ts)
- [src/pi/subagents/pi-child-session.ts](../../../../src/pi/subagents/pi-child-session.ts)
- [src/pi/subagents/smoke/](../../../../src/pi/subagents/smoke/)

## Lifecycle edges

**Depends on:**
- [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — the manager instantiates these pieces.
- [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md) — definitions carry model refs that this module validates.
- [write-isolation-and-worktree](../write-isolation-and-worktree/write-isolation-and-worktree.md) — `PiChildSessionFactory` calls the isolation manager before `SessionManager` creation.

**Used by:**
- [agent-registry-and-resolution](../agent-registry-and-resolution/agent-registry-and-resolution.md) — model refs / policy / child-tool factories.
- [subagent-manager-and-lifecycle](../subagent-manager-and-lifecycle/subagent-manager-and-lifecycle.md) — child tool factories, model refs, gating.

## See also

- **Rule — do not lift the deferred decisions without updating the policy file.** Removing `nestedDelegation: 'disabled-max-depth-one'` requires changes elsewhere (`resolveTools` hard-deny, gating). Update all three together.
- **Rule — child tools default to a safe subset.** `CHILD_SAFE_TOOLS` is the maximum reach for a general child; `READ_ONLY_CHILD_TOOLS` is the safer default. Do not expand the list without deliberation.
- **Pattern — the capability gate is the launcher toggle's back end.** UI toggles → `setEnabled` → `composeDisabledTools` at session-init. No other wire path.
- **Pattern — model refs are two-shape.** Accept either the string or the object; canonicalize to `{provider, id}` internally. UI code passes strings; programmatic API passes objects.
- **Pitfall — MCP tool names use hyphens; child-tools registry uses underscores.** `registerChildSafeMcpTool` normalizes. Direct registration without normalization produces a name that fails the validator.
- **Pitfall — smoke scenarios are the closest thing to end-to-end tests.** When touching the manager / registry / write-isolation, run them via the smoke runner ([src/pi/subagents/smoke/runner.ts](../../../../src/pi/subagents/smoke/runner.ts)). Unit tests do not cover the integration paths.
- **Pattern — completion tool artifacts carry file references.** The parent inspects them (e.g. to open a diff); children do not upload files, they just point at paths in their `cwd`.
