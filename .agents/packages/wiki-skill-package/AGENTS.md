# AGENTS.md — Wiki Skill Package

Vendor-neutral entry point. If you are any AI coding agent (Claude Code, OpenAI Codex, Cursor, Aider, Pi, Continue, other) pointed at this package, read this file first.

## What this package is

A portable install of a repo-documentation system:

- Two skills — `wiki-read` (orient on a subject) and `wiki-maintain` (edit + validate).
- Three Python validators — `validate.py`, `compute-used-by.py`, `structure-enum-check.py` (plus the demoted `reciprocal.py` and a bash wrapper `validate.sh`).
- A `wiki/` scaffold — empty book-chapters TOC ready to be populated.

Full human overview: [README.md](README.md).

## If asked to deploy

Read [AGENT_DEPLOY.md](AGENT_DEPLOY.md) end-to-end and follow the steps. It is vendor-neutral — no Claude-specific tool calls. You need:

- File-copy capability (`Write` / `create_file` / shell `cp` — whichever your platform exposes).
- Ability to read and edit markdown files (for `.claude/CLAUDE.md` and `AGENTS.md` wire-up in the target repo).
- Ability to run a Python 3 script and read its output (for the validator smoke-test).

Nothing else. No MCP servers, no subagents, no plugin APIs are required to deploy.

## If asked to work with an already-deployed wiki

The two skill files under `files/.claude/skills/` are the documentation for what to do. Even if your agent runtime does not have a "skill" invocation mechanism, both SKILL.md files are plain markdown workflows you can follow step-by-step:

- **`files/.claude/skills/wiki-read/SKILL.md`** — the wiki-lookup workflow (TOC sweep → keyword grep → chapter intro → owner article → neighbours → summary report).
- **`files/.claude/skills/wiki-maintain/SKILL.md`** — the wiki-editing workflow (classify change → update in place → run validators → log to changelog).

On a deployed target repo, the same two files live at `<target>/.claude/skills/wiki-read/SKILL.md` and `<target>/.claude/skills/wiki-maintain/SKILL.md`. Read them there. Non-Claude agents treat them as static markdown; Claude Code invokes them as skills.

## Runtime adaptations

For agents whose tool surface differs from Claude Code's:

| Claude Code capability | Non-Claude equivalent |
|---|---|
| `Skill` tool → `wiki-read` / `wiki-maintain` | Manually read the SKILL.md and follow the workflow steps |
| `Grep` tool | `rg`, `grep -rn`, or the platform's search primitive |
| `Read` tool | `read_file` / `cat` / built-in file reader |
| `Edit` tool | `str_replace` / `apply_diff` / `write_file` (after read) |
| `Bash` tool | `run_command` / shell primitive of your platform |
| `Agent` tool with `subagent_type` | Execute the workflow inline; sub-agent dispatch is optional for context isolation, not correctness |
| Auto-loaded nested `CLAUDE.md` | Non-Claude agents must open target's `AGENTS.md` and `.claude/CLAUDE.md` manually if either exists |

The workflows in both SKILL.md files are pure markdown instructions — no Claude-only APIs are invoked from inside them.

## What NOT to do

- **Do not rename or relocate files inside `files/`.** The subtree mirrors what lands in the target repo. Reorganizing here breaks the deploy step.
- **Do not populate `wiki/` content during deployment.** The scaffold is empty on purpose — content is the user's design decision.
- **Do not overwrite an existing `wiki/`, `.claude/skills/wiki-*/`, `.claude/CLAUDE.md`, or `AGENTS.md` in the target without explicit user consent.** Merge, don't clobber.
- **Do not commit the deployment in the target repo unless the user explicitly asks.** Deployment ends with an unstaged working tree.

## Contact points

If any deployment step is ambiguous, stop and ask the user rather than guessing. The cost of a 30-second clarification is much lower than the cost of overwriting real content or a misconfigured `.claude/CLAUDE.md`.
