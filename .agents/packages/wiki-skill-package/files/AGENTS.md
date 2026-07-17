# AGENTS.md — Repo Entry Point (Wiki Section)

Vendor-neutral entry point for AI coding agents working on this repo. If your target repo has its own `AGENTS.md`, treat the block below as a **section to merge in**, not a full replacement.

<!--
DEPLOY NOTE — for the AI agent that installed this file:
If <target-repo>/AGENTS.md already existed at deployment, you should have merged the "Wiki" section below into it and deleted this template file. If this file still sits at repo root untouched, deployment was incomplete — flag it to the user.
-->

---

## Wiki

The repo carries a book-style wiki at [`wiki/`](wiki/) — the primary orientation surface for any system, tool, or pipeline in this project. Structure: `wiki/index.md` (Parts → chapters TOC) + `wiki/parts/<NN-part>/<chapter>/_intro.md` + article files under the fixed schema `Stance / Role / Keywords / Lifecycle edges / See also`.

**Before answering questions about how something works, locating a type/concept, or designing a change:** consult the wiki first. It is hypothesis-priming, not authoritative — verify load-bearing claims against current source before acting on them.

### How to read the wiki

Workflow (adapted from `.claude/skills/wiki-read/SKILL.md`):

1. **TOC sweep** — read [`wiki/index.md`](wiki/index.md) to locate the target's approximate chapter.
2. **Keyword grep** — `grep -rni "<target>" wiki/` finds the owning article(s). A concept typically appears in its owner plus 2–4 consumer articles.
3. **Read the chapter intro** — `wiki/parts/<NN-part>/<chapter>/_intro.md` frames what the chapter covers and lists its article roster.
4. **Read the owner article in full** — `Stance` + `Role` build the mental model; `Keywords` give the surface; `Lifecycle edges` show the dependency graph.
5. **Read neighbours shallowly** — for each `Depends on` / `Used by` / `See also` target that matters, read at least its `Stance` and `Role`.
6. **Follow appendix refs** — if the article cites `wiki/appendix-a-seam-types.md`, skim the matching entry.

Produce a compact summary report (~50–60 lines) with `Scope match` / `Key facts` / `Open gaps` / `Links` sections, citing every claim with a wiki link.

### How to update the wiki

Workflow (adapted from `.claude/skills/wiki-maintain/SKILL.md`):

1. **Discover the change** — what type / subsystem / rule was added / renamed / deleted?
2. **Classify** — use the routing rubric in the SKILL.md (new type → Keywords append; rename → global grep+replace; new subsystem → Stance/See-also hint; new article → **escalate**).
3. **Update in place** — edit Keywords / Stance / Role / Lifecycle edges § Depends on / See also. Never edit `Used by:` manually — it's computed.
4. **Validate:**

   ```bash
   python3 .claude/skills/wiki-maintain/scripts/validate.py wiki
   python3 .claude/skills/wiki-maintain/scripts/compute-used-by.py wiki
   python3 .claude/skills/wiki-maintain/scripts/structure-enum-check.py wiki .claude
   ```

   `validate.py` must exit 0 (no `[E]` errors). `compute-used-by.py` rewrites `Used by:` blocks from the inverse Depends-on graph.
5. **Log** — prepend a dated entry to `wiki/changelog.md`.

### Wiki invariants

- **Forward-only `Depends on`; `Used by:` is computed.** Never author `Used by:` bullets manually — `compute-used-by.py` overwrites them.
- **No `TBD` leftovers.** Every article + intro is fully authored.
- **English-only.** No Cyrillic anywhere under `wiki/`.
- **One-idea-per-article.** Subsystems become sub-hints inside an existing article, not new files.
- **Single-source-of-truth structural enumeration.** Only `wiki/index.md` enumerates Parts and chapters at the top level. Do not duplicate the chapter list in AGENTS.md, CLAUDE.md, or any skill file — `structure-enum-check.py` will flag it.

### Runtime adaptations

If your agent runtime differs from Claude Code (Cursor, Codex, Aider, Pi, etc.):

- **No skill invocation?** The two SKILL.md files under `.claude/skills/wiki-read/` and `.claude/skills/wiki-maintain/` are plain markdown workflows. Read them and follow the steps.
- **No auto-loaded nested `CLAUDE.md`?** Manually read `wiki/CLAUDE.md` when opening any wiki file — it defines wiki-only conventions.
- **No sub-agent dispatch?** Execute wiki-read / wiki-maintain workflows inline. Sub-agent dispatch is optional (for context isolation), not correctness.

## Notes for adaptation

This section was seeded from the `wiki-skill-package` install. If your project already had an `AGENTS.md` before deployment, this block was merged in — you should have other, project-specific sections above/below it.
