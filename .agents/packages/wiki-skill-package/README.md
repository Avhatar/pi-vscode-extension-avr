# Wiki Skill Package

Portable install of the `wiki-read` + `wiki-maintain` skills and the empty wiki scaffold they operate on. Point an AI coding agent at this folder, tell it which project to deploy into, and it will drop everything into the right places.

## What's inside

```
wiki-skill-package/
├── README.md                  ← you are here (human-facing overview)
├── AGENTS.md                  ← vendor-neutral entry point for any AI agent
├── AGENT_DEPLOY.md            ← the deployment instructions the agent follows
└── files/
    ├── AGENTS.md              ← template deployed into target repo root
    ├── .claude/
    │   └── skills/
    │       ├── wiki-read/
    │       │   └── SKILL.md
    │       └── wiki-maintain/
    │           ├── SKILL.md
    │           └── scripts/
    │               ├── validate.py
    │               ├── validate.sh
    │               ├── compute-used-by.py
    │               ├── structure-enum-check.py
    │               └── reciprocal.py
    └── wiki/
        ├── index.md           ← book-chapters TOC (template)
        ├── CLAUDE.md          ← conventions (auto-loads with any wiki file)
        ├── changelog.md       ← empty change log
        └── parts/             ← empty content root
            └── .gitkeep
```

The `files/` subtree mirrors what ends up at the target repo root — the deploying agent just copies it in place, preserving structure.

## How to use it

1. **Copy this whole folder** to wherever you keep reusable tooling (a shared drive, a git repo, a Notion attachment — doesn't matter). Nothing here is project-specific.
2. **Open a Claude Code session inside the target repo** you want to seed. Any project works, though the skill was designed with Unity projects in mind.
3. **Point the agent at this package** with a prompt like:

   > Deploy this wiki skill package into the current repo. Instructions: `<absolute-path-to>/wiki-skill-package/AGENT_DEPLOY.md`.

   Non-Claude agents (Codex / Cursor / Aider / Pi / etc.) can point at [`AGENTS.md`](AGENTS.md) instead — same content, framed for the wider agent ecosystem. Both files ultimately delegate to `AGENT_DEPLOY.md` for the step-by-step.

4. The agent reads the entry point + `AGENT_DEPLOY.md` and executes the deployment: file copy, `CLAUDE.md` and `AGENTS.md` wiring, validator dry-run, back-report. It will stop and ask before overwriting anything.

## What you get after deployment

- **Two slash-commands active in Claude Code**: `/wiki-read` (orient on a subject) and `/wiki-maintain` (edit + validate).
- **A `wiki/` folder at the repo root** with a starter TOC and no content. You (or your agent) fill in Parts, chapters, and articles as you go — one system at a time.
- **Three Python validators** wired to run manually or via `/wiki-maintain`. Idempotent, safe to re-run any time.
- **`.claude/CLAUDE.md` gently updated** to tell future Claude Code sessions to consult the wiki as the first orientation step.
- **`AGENTS.md` at repo root** — vendor-neutral entry point so non-Claude agents (Codex, Cursor, Aider, Pi, etc.) can use the wiki system without Claude's skill invocation mechanism. Merged into any pre-existing `AGENTS.md` rather than overwriting.

## When to redeploy / upgrade

If you improve the skills or scripts here, re-run the deployment against the same target — the agent will offer to overwrite the skill files (safe; they're pure logic) while leaving `wiki/` content alone.

## Requirements on the target machine

- **Python 3.9+** (for the validators; anything shipping with a recent OS works).
- **Claude Code** with skill support (any current version).
- **A shell** — bash, zsh, or PowerShell all work; the scripts are cross-platform Python.

That's it. No third-party packages, no build step.

## Non-goals

- **This is not a wiki-authoring tutorial.** The `wiki-maintain` SKILL.md explains the schema and validators; use that as the authoring guide.
- **This does not migrate an existing wiki.** If the target repo already has a `wiki/` folder, the agent will refuse to overwrite without permission. Merging existing content into the schema is a manual task.
- **This does not enforce Unity-specific rules.** The skills are engine-agnostic. If your project has domain-specific placement rules (blueprints, prefabs, editor code), extend `wiki-maintain/SKILL.md` § "What NOT to update" after deployment.
