# Wiki Skill Package — Deployment Instructions for AI Agents

You have been pointed at this package and asked to deploy it into a target project (typically a Unity project, but the package is domain-agnostic). Follow this file end-to-end.

## What the package installs

Two Claude Code skills plus a scaffold for repo documentation:

- **`.claude/skills/wiki-read/`** — read-only wiki lookup skill.
- **`.claude/skills/wiki-maintain/`** — wiki editing / validation skill, with Python scripts in `scripts/`.
- **`wiki/`** — scaffold: `index.md` (TOC template), `CLAUDE.md` (conventions, auto-loaded when reading wiki files), `changelog.md` (empty), `parts/` (empty content root).
- **`AGENTS.md`** at target repo root — vendor-neutral entry point for non-Claude agents (Codex / Cursor / Aider / Pi / etc.). Describes how to use the wiki without relying on Claude's skill invocation mechanism.

The wiki itself is content the user will populate over time. The skills + scripts + AGENTS.md are the machinery that keeps it consistent.

## Preconditions

Before you copy anything, verify these are true. If any is false, STOP and report it to the user.

1. **Target project root known.** The user must have told you the absolute path of the target repo. If unclear, ask: _"What's the absolute path of the project I should deploy into?"_
2. **Target has `.claude/` — or is willing to have one created.** Claude Code projects live under `<repo>/.claude/`. If the target has no `.claude/` directory, create it.
3. **Target has no existing `wiki/` folder** — or if it does, get explicit permission before overwriting. `wiki/` may contain user-authored content.
4. **Target has no existing `.claude/skills/wiki-read/` or `.claude/skills/wiki-maintain/`** — same rule. If they exist, ask whether to overwrite, skip, or diff.
5. **Target's existing `AGENTS.md`, if any, may need a section-merge rather than overwrite.** See Step 2b below.
6. **Python 3 is available on the machine** (`python3 --version` or `python --version`). Required by the validation scripts.

## Deployment steps

### Step 1 — Copy the file tree

Copy the contents of `files/` in this package into the target repo root, preserving structure:

```
<package>/files/.claude/skills/wiki-read/SKILL.md
    → <target-repo>/.claude/skills/wiki-read/SKILL.md

<package>/files/.claude/skills/wiki-maintain/SKILL.md
    → <target-repo>/.claude/skills/wiki-maintain/SKILL.md

<package>/files/.claude/skills/wiki-maintain/scripts/
    → <target-repo>/.claude/skills/wiki-maintain/scripts/
    (validate.py, validate.sh, compute-used-by.py, structure-enum-check.py, reciprocal.py)

<package>/files/wiki/
    → <target-repo>/wiki/
    (index.md, CLAUDE.md, changelog.md, parts/.gitkeep)

<package>/files/AGENTS.md
    → <target-repo>/AGENTS.md
    (see Step 2b — copy verbatim only if target has no AGENTS.md; otherwise merge sections)
```

Preserve the executable bit on `.py` and `.sh` files if the target OS uses one.

### Step 2 — Wire the wiki into project CLAUDE.md

The target repo's root-level `CLAUDE.md` (project instructions) should nudge the model to consult the wiki. Do one of the following:

- **If `<target-repo>/.claude/CLAUDE.md` exists:** append (or merge into an existing "Repo orientation" / "Documentation" section) this block:

  ```markdown
  ### Repo orientation
  - **Wiki is the entry point for repo info.** Before answering questions about how a system works, locating a type or concept, or designing a fix that touches code you haven't just edited — consult `wiki/` first (skill `wiki-read`, or read `wiki/index.md` and drill down). Wiki is hypothesis-priming, not authoritative — verify load-bearing claims against current source.

  ## Wiki

  @../wiki/index.md
  ```

  Do NOT duplicate an existing wiki mention — merge.

- **If `<target-repo>/.claude/CLAUDE.md` does not exist:** create it with the block above as the initial content.

The `@../wiki/index.md` line auto-includes the wiki TOC in Claude Code sessions. Path is relative to `.claude/`; adjust if the target has non-standard nesting.

### Step 2b — Wire in AGENTS.md (vendor-neutral entry point)

The package ships an `AGENTS.md` template at `files/AGENTS.md` — an open convention that non-Claude agents (Codex, Cursor, Aider, Pi, Continue, others) read at repo root as their system-prompt extension point.

- **If `<target-repo>/AGENTS.md` does not exist:** copy `files/AGENTS.md` to `<target-repo>/AGENTS.md` verbatim. Delete the `<!-- DEPLOY NOTE ... -->` HTML comment at the top of the deployed file (it exists only to catch incomplete deploys).
- **If `<target-repo>/AGENTS.md` already exists:** the target already has a vendor-neutral entry point. **Do not overwrite.** Extract just the `## Wiki` section (plus its subsections) from `files/AGENTS.md` and append/insert it into the existing `AGENTS.md`. Skip the "Notes for adaptation" trailing section — that is only relevant when the file is created fresh.

Never delete pre-existing sections in the target's `AGENTS.md`. If unsure where to insert the Wiki section, put it after any existing "Quick orientation" / "Structure" sections and before any tool-specific adaptation sections.

### Step 3 — Verify with a dry run of the validators

Run from the target repo root:

```bash
python3 .claude/skills/wiki-maintain/scripts/validate.py wiki
python3 .claude/skills/wiki-maintain/scripts/compute-used-by.py wiki --dry-run
python3 .claude/skills/wiki-maintain/scripts/structure-enum-check.py wiki .claude
```

Expected results at zero-content state:

- `validate.py` → prints `PASS — no [E] errors` (may warn about the empty wiki; that's fine).
- `compute-used-by.py --dry-run` → reports 0 files changed.
- `structure-enum-check.py` → `PASS — no duplicate structural enumeration outside wiki/index.md`.

If any of these fail, report the exact stderr/stdout to the user before continuing.

### Step 4 — Report back

Tell the user:

1. Which files were written (paths relative to target repo).
2. Whether `.claude/CLAUDE.md` was created new or merged into.
3. Whether `AGENTS.md` was created new or merged into (and where the Wiki section was inserted).
4. Whether validators passed on the empty scaffold.
5. **Next steps for the user** — a short paragraph:
   > The skills and scaffold are in place. The wiki itself is empty. To seed it, decide on the Part/chapter structure of the repo (edit `wiki/index.md`), then start authoring one chapter at a time — each with an `_intro.md` and one or more articles under the `Stance / Role / Keywords / Lifecycle edges / See also` schema (see `.claude/skills/wiki-maintain/SKILL.md` § Conventions). Invoke `/wiki-maintain` when adding new articles so validators run.

## Things you must NOT do

- **Do not populate wiki content yourself** during deployment. The scaffold ships empty on purpose — content is the user's design decision.
- **Do not enumerate Parts/chapters inside SKILL.md files or the root CLAUDE.md.** Only `wiki/index.md` may enumerate structure (enforced by `structure-enum-check.py`).
- **Do not overwrite an existing `wiki/`, existing skill folders, or an existing `AGENTS.md` without explicit user consent.** They may hold real content — merge instead.
- **Do not commit the changes** unless the user explicitly asks. Deployment ends with an unstaged working tree; the user commits when they're satisfied.
- **Do not modify anything inside `files/` in this package** — the package is meant to be reusable; per-project customization happens on the target side.

## Adaptation notes for the target project

Two places in the deployed skill files may benefit from a small edit **after** the user has populated some wiki content:

1. **`wiki-read/SKILL.md` § "Scope-to-chapter heuristics"** — start empty. Once several chapters exist, the user can add a few `<domain> → <chapter>` routing hints here to speed up lookups. Do not enumerate — cite specific chapter slugs by topic only.
2. **`wiki-maintain/SKILL.md` § "What NOT to update"** — mentions "editor-side types" and "test classes" in generic terms. If the target project has non-obvious "out of scope for wiki" categories (e.g. a generated-code folder), the user can extend this list.

Neither adaptation is needed at deployment time. Do these only if the user asks after they've been using the wiki for a while.
