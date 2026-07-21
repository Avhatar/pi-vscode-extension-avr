# Chapter: claude-sdk-compat

Many teams have accumulated `CLAUDE.md` files, `.claude/skills/**`, `.claude/commands/**`, `.claude/rules/**`, `.claude/agents/**`, and MCP servers under `~/.claude/mcp_servers/*.json`. Pi wants to consume that content productively without becoming Claude — no aliasing, no identity confusion, and, crucially, without triggering when the user has already migrated their guidance to `AGENTS.md`.

The [src/pi/claude-compat/](../../../../src/pi/claude-compat/) module is where all of that lives. It detects Claude infrastructure, discovers and parses skills / commands / rules, indexes CLAUDE.md ancestry, wraps content in a boundary preamble that clarifies Pi identity, maps Claude tool names to Pi equivalents (with an MCP proxy fallback), and tracks per-session state so it doesn't re-inject the same guidance twice.

## Article roster

- [claude-sdk-compat](claude-sdk-compat.md) — detection, root / nested context expansion, resource indexing (skills / commands), rule matching, tool-name compatibility, boundary preamble, shim collapse, and per-session tracking.

## Reader task

The reader arrives here to answer one of:

- "How does Pi decide the current workspace 'has Claude infrastructure'?"
- "What happens when a workspace has both `AGENTS.md` and `CLAUDE.md` — do we duplicate the instruction?"
- "When the agent tries to call a Claude tool name (`Read`, `Bash`, `mcp__server__tool`), what does Pi do?"
- "Where's the rate limiter that prevents CLAUDE.md content from being re-injected on every tool call?"

## Neighborhood

- **Session integration** — the claude-compat extension is one of the ExtensionFactory implementations handed to `DefaultResourceLoader`; see [session-lifecycle](../session-lifecycle/session-lifecycle.md).
- **Settings** — the master switch (`pi-code.claudeCompat.enabled`) and per-workspace mode (`pi-code.claudeCompat.mode` = `auto | on | off`) live in [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md).
- **MCP import** (`pi-code.mcp.importClaudeCode`) is *not* claude-compat — it's a separate one-shot copy of the user's Claude Code MCP config into Pi's MCP registry, orthogonal to the runtime bridge here.

## Non-goals

- Claude Code itself is not modified — Pi Code has no privileged access to Claude Code's data structures.
- OAuth tokens, Claude Console credentials, etc., are the user's business.
- Anthropic-model-specific quirks (context window, tool schema differences) are handled by the Pi SDK's Anthropic provider, not by claude-compat.
