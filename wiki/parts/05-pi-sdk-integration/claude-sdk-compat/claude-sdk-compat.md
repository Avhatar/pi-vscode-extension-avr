# claude-sdk-compat

## Stance

Two rules govern the bridge. **Pi remains Pi**: every Claude-authored resource that reaches the agent is wrapped in a boundary preamble that explicitly frames it as "provider-agnostic guidance surfaced through Pi", not as a Claude instruction that overrides identity. **Migration wins**: if `CLAUDE.md` only redirects to `AGENTS.md` (a "shim") the bridge collapses it — Pi already loads `AGENTS.md` natively; re-injecting would double the guidance. Both rules are enforced in code, not by convention.

## Role

Fifteen files under [src/pi/claude-compat/](../../../../src/pi/claude-compat/) split the responsibility:

**Detection.** [`detectClaudeInfrastructure(cwd, options)`](../../../../src/pi/claude-compat/detect.ts#L147) walks the workspace for markers: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/skills/**`, `.claude/commands/**`, `.claude/agents/**`, `.claude/rules/**`, `.claude-plugin/plugin.json`. Nested search is bounded by the host's `workspace.findFiles`. Shim collapse ([detect.ts:175](../../../../src/pi/claude-compat/detect.ts#L175)): if `CLAUDE.md` at root only redirects to `AGENTS.md`, the marker is recorded but does not activate the bridge.

**Discovery rules.** [`discovery.ts`](../../../../src/pi/claude-compat/discovery.ts) exposes `CLAUDE_NESTED_SEARCH_EXCLUDE` (`.git`, `node_modules`, `dist`, `bin`, `build`, `obj`, `out`, `Temp`, `Library`, `Logs`, `.vs`) and `isExcludedClaudeDiscoveryPath` for use by callers.

**Root / nested context.** [`getRootClaudeFiles(cwd)`](../../../../src/pi/claude-compat/context.ts#L32) walks ancestry collecting root files. [`buildRootInstructions(cwd, preloadedPaths)`](../../../../src/pi/claude-compat/context.ts#L64) expands @imports and formats. [`buildPathInstructions(cwd, targetPaths)`](../../../../src/pi/claude-compat/context.ts#L78) collects nested CLAUDE.md files for tool-touched paths — the "cd into a subdir, get the subdir's guidance" flow. [`createClaudeContextExtension()`](../../../../src/pi/claude-compat/context-extension.ts#L312) constructs the ExtensionFactory handed to the SDK; it hooks `beforeAgentStart` (root instructions), `afterToolCall` (path-scoped instructions from file references), `beforeToolCall` (injects applicable rules as context).

**Resources.** [`indexClaudeResources(cwd, options)`](../../../../src/pi/claude-compat/resources.ts#L341) discovers skills at `.claude/skills/**/SKILL.md` and commands at `.claude/commands/**/*.md`, parses frontmatter, detects collisions, returns `ClaudeResourceIndex { skills[], commands[], diagnostics[] }`. [`renderClaudeInvocableResource()`](../../../../src/pi/claude-compat/resources.ts#L458) substitutes `$ARGUMENTS`, `$CLAUDE_PROJECT_DIR`, and wraps the body in a `<skill>` tag.

**Rules.** [`indexClaudeRules(cwd, options)`](../../../../src/pi/claude-compat/rules.ts#L245) discovers `.claude/rules/**/*.md`, parses path patterns. [`ruleMatchesPath()`](../../../../src/pi/claude-compat/rules.ts#L271) does the minimatch.

**Tool compatibility.** [`extractClaudeToolReferences()`](../../../../src/pi/claude-compat/tool-compat.ts#L27) finds Claude tool names + `mcp__server__tool` patterns in text. [`resolveClaudeToolReference()`](../../../../src/pi/claude-compat/tool-compat.ts#L59) maps them to Pi tools: MCP refs try direct (e.g. `mcp__claude_ai_Linear__foo` → `claude_ai_Linear_foo`), fallback to `mcp` proxy. Claude tools map to Pi equivalents (`Read → read`, `Write → write`, `Bash → bash`, `Grep → grep`, `Glob → find`, etc.). Status: `native | mapped | proxy | unavailable | deferred-agent | runtime-only`. [`formatClaudeToolCompatibility()`](../../../../src/pi/claude-compat/tool-compat.ts#L118) produces a markdown reference table.

**Boundary preamble.** [`CLAUDE_COMPATIBILITY_BOUNDARY`](../../../../src/pi/claude-compat/boundary.ts#L3) is a static string explaining Pi identity preservation. [`wrapClaudeCompatibilityContent()`](../../../../src/pi/claude-compat/boundary.ts#L29) frames any Claude resource with it before the agent sees the content.

**Shim.** [`isClaudeMdShim()`](../../../../src/pi/claude-compat/shim.ts#L27) detects `CLAUDE.md` that only redirects to `AGENTS.md`.

**Session state.** [`wasClaudeContextDelivered(fingerprint)`](../../../../src/pi/claude-compat/session-state.ts#L18), [`filterUnappliedInstructions()`](../../../../src/pi/claude-compat/session-state.ts#L40), [`filterUnappliedNestedSkills()`](../../../../src/pi/claude-compat/session-state.ts#L48), [`getRuleApplicationState()`](../../../../src/pi/claude-compat/session-state.ts#L70) — all deduplicate instruction / skill / rule injection using a fingerprint recorded in a custom session entry (`CLAUDE_INSTRUCTION_APPLIED_ENTRY` at [session-state.ts:7](../../../../src/pi/claude-compat/session-state.ts#L7)).

**Path scope / imports / markdown.** Utility modules: [`path-scope.ts`](../../../../src/pi/claude-compat/path-scope.ts) canonicalizes paths, [`imports.ts`](../../../../src/pi/claude-compat/imports.ts) expands `@import` directives, [`markdown.ts`](../../../../src/pi/claude-compat/markdown.ts) strips HTML comments, [`settings.ts`](../../../../src/pi/claude-compat/settings.ts) loads `.claude/settings.json` exclusions.

## Keywords

**Types — detection:**
- `ClaudeInfrastructure`, `ClaudeActivationReason` — [types.ts:20](../../../../src/pi/claude-compat/types.ts#L20)
- `ClaudeResourceIndex`, `ClaudeSkill`, `ClaudeCommand`, `ClaudeRule` — [types.ts](../../../../src/pi/claude-compat/types.ts)

**Methods — detection / discovery:**
- `detectClaudeInfrastructure(cwd, options)` — [detect.ts:147](../../../../src/pi/claude-compat/detect.ts#L147)
- `isExcludedClaudeDiscoveryPath(path)` — [discovery.ts:25](../../../../src/pi/claude-compat/discovery.ts#L25)
- `isClaudeMdShim(path, content)` — [shim.ts:27](../../../../src/pi/claude-compat/shim.ts#L27)

**Methods — context:**
- `getRootClaudeFiles(cwd)` — [context.ts:32](../../../../src/pi/claude-compat/context.ts#L32)
- `buildRootInstructions(cwd, preloadedPaths)` — [context.ts:64](../../../../src/pi/claude-compat/context.ts#L64)
- `buildPathInstructions(cwd, targetPaths)` — [context.ts:78](../../../../src/pi/claude-compat/context.ts#L78)
- `createClaudeContextExtension()` — [context-extension.ts:312](../../../../src/pi/claude-compat/context-extension.ts#L312)

**Methods — resources / rules:**
- `indexClaudeResources(cwd, options)` — [resources.ts:341](../../../../src/pi/claude-compat/resources.ts#L341)
- `renderClaudeInvocableResource(...)` — [resources.ts:458](../../../../src/pi/claude-compat/resources.ts#L458)
- `indexClaudeRules(cwd, options)` — [rules.ts:245](../../../../src/pi/claude-compat/rules.ts#L245)
- `ruleMatchesPath(rule, path)` — [rules.ts:271](../../../../src/pi/claude-compat/rules.ts#L271)

**Methods — tools:**
- `extractClaudeToolReferences(text)` — [tool-compat.ts:27](../../../../src/pi/claude-compat/tool-compat.ts#L27)
- `resolveClaudeToolReference(ref, catalog)` — [tool-compat.ts:59](../../../../src/pi/claude-compat/tool-compat.ts#L59)
- `formatClaudeToolCompatibility(resolutions)` — [tool-compat.ts:118](../../../../src/pi/claude-compat/tool-compat.ts#L118)

**Methods — boundary / session state:**
- `wrapClaudeCompatibilityContent(kind, source, body)` — [boundary.ts:29](../../../../src/pi/claude-compat/boundary.ts#L29)
- `wasClaudeContextDelivered(entries, fingerprint)` — [session-state.ts:18](../../../../src/pi/claude-compat/session-state.ts#L18)
- `filterUnappliedInstructions(entries, files)` — [session-state.ts:40](../../../../src/pi/claude-compat/session-state.ts#L40)
- `filterUnappliedNestedSkills(entries, skills)` — [session-state.ts:48](../../../../src/pi/claude-compat/session-state.ts#L48)
- `getRuleApplicationState(entries, turnId)` — [session-state.ts:70](../../../../src/pi/claude-compat/session-state.ts#L70)

**Attributes / markers:**
- `CLAUDE_COMPATIBILITY_BOUNDARY` — [boundary.ts:3](../../../../src/pi/claude-compat/boundary.ts#L3)
- `CLAUDE_INSTRUCTION_APPLIED_ENTRY` — [session-state.ts:7](../../../../src/pi/claude-compat/session-state.ts#L7); custom entry type recording injection fingerprints

**Namespaces:**
- [src/pi/claude-compat/](../../../../src/pi/claude-compat/) — the whole subsystem; 15 files

## Lifecycle edges

**Depends on:**
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — `createClaudeContextExtension` is registered as an ExtensionFactory during resource-loader construction.
- [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md) — `pi-code.claudeCompat.enabled` / `pi-code.claudeCompat.mode` gate activation.

**Used by:**
- [agent-registry-and-resolution](../../09-subagents/agent-registry-and-resolution/agent-registry-and-resolution.md) — Claude agent adaptation uses the tool-compat and boundary wrappers there.
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — claude-compat extension is one of the factories.

## See also

- **Rule — Pi identity is preserved by wrapping.** Every Claude-authored resource that reaches the agent goes through `wrapClaudeCompatibilityContent`. Bypassing the wrapper means the agent sees a raw Claude instruction and can drift into role-confusion.
- **Rule — shim collapse is mandatory.** If `CLAUDE.md` only points to `AGENTS.md`, do not re-inject — Pi already loaded `AGENTS.md` natively. [`isClaudeMdShim`](../../../../src/pi/claude-compat/shim.ts#L27) is the checkpoint.
- **Pattern — deduplication via session-state fingerprint.** Injecting the same CLAUDE.md into every turn would flood context. Each successful injection appends a `CLAUDE_INSTRUCTION_APPLIED_ENTRY` custom entry with a fingerprint; subsequent turns filter against it.
- **Pattern — path-scoped nested context.** When the agent calls a tool that touches a nested directory containing its own `CLAUDE.md`, `afterToolCall` collects the nested instructions and injects them for subsequent turns.
- **Pattern — tool-name resolution has a fallback ladder.** Native (Pi tool exists with the mapped name) → mapped (rename) → proxy (route through `mcp` gateway) → unavailable (return diagnostic) → deferred-agent / runtime-only. Never silently drop; always surface status.
- **Pitfall — user-level `~/.claude/CLAUDE.md` is only loaded when a project marker activates the bridge.** Otherwise a stray home-directory file would spam every workspace regardless of whether the user actually uses Claude Code in that project.
- **Pitfall — path canonicalization matters on Windows.** Symlinks and case-insensitivity are handled by [`path-scope.ts`](../../../../src/pi/claude-compat/path-scope.ts). New comparators must go through it.
- **Pitfall — MCP servers imported via `pi-code.mcp.importClaudeCode` are not the same thing.** That's a settings-panel-driven one-shot copy of `~/.claude/mcp_servers/*.json` into Pi's MCP registry; the claude-compat bridge here is about instruction / skill / tool-name compatibility at agent-run time.
