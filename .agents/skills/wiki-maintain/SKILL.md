---
name: wiki-maintain
description: Use to keep the repo wiki synchronized with the repo as it evolves (code, tooling, assets, pipelines). Triggers — after a code change that added / renamed / deleted types appearing as wiki keywords; on explicit user request ("update wiki", "check wiki", "update wiki for X"); quarterly drift audit.
---

# wiki-maintain

Maintain the repo wiki at `<repo-root>/wiki/` — `index.md` (book-chapters TOC) + `parts/<NN-part>/<chapter>/_intro.md` + per-chapter article files + optional `appendix-a-seam-types.md` — so it keeps matching the repo it describes.

## When to invoke

1. **After a code change touches types that are wiki keywords.** Run the lightweight check (Step 1 below); if the change affects wiki content, run the full workflow.
2. **Explicit request** — user says "update wiki for X", "check wiki", "sync wiki".
3. **Quarterly drift audit** — scheduled reconciliation between wiki Keywords and the current code index.

## Scope

- **Wiki location:** `<repo-root>/wiki/`. Structure: `index.md` (TOC) + `parts/<NN-part-slug>/<chapter-slug>/<article-slug>.md` + `parts/<NN-part>/<chapter>/_intro.md` (one intro per chapter) + optional `appendix-a-seam-types.md` (cheatsheet routing cross-cutting concepts to their chapter homes).
- **Scripts:** `.agents/skills/wiki-maintain/scripts/validate.py`, `compute-used-by.py`, `structure-enum-check.py`, `reciprocal.py` (demoted). Pass the wiki directory as argument.

## Invariants

Enforced by validators; break any of these and the scripts fail (or surface warnings).

- **Forward-only `Depends on`; `Used by` is computed.** Each article authors `## Lifecycle edges § Depends on:` manually. The reciprocal `## Lifecycle edges § Used by:` section is COMPUTED via `compute-used-by.py` from the inverse Depends-on graph. Don't author Used-by manually — it gets overwritten.
- **No `TBD` leftovers.** Every article + intro is fully authored.
- **English-only.** No Cyrillic in any file under `wiki/`.
- **One-idea-per-article.** Each article covers one system / concept. Subsystems are hinted inside an existing article (Stance / See also), not split into new files unless they meet the chapter-expansion bar (≥7 distinct types + distinct reader-task).
- **Single-source-of-truth structural enumeration.** Only `wiki/index.md` enumerates the Parts and chapters at the top level; per-chapter article rosters live in each chapter's `_intro.md` (the `## Article roster` section). Other files (`AGENTS.md`, `CLAUDE.md`, SKILL.md) cite specific articles by topic, never enumerate the structure. Checked by `structure-enum-check.py`.
- **Wiki-self-contained.** Wiki content should not reference project-specific task-management systems, ticket IDs, or in-flight-work files. Wiki captures architectural knowledge, not workflow state.

## Conventions

Authoring conventions for wiki content.

- **Article section order:** `## Stance` (1–2 lines — what is non-obvious about this system) → `## Role` → `## Keywords` → `## Lifecycle edges` (sub-bullets `**Depends on:**` / `**Used by:**`) → `## See also`.
- **Keywords listing:** one identifier per line, backticked, grouped under `**Types — {label}:**` / `**Methods:**` / `**Attributes/markers:**` / `**Namespaces:**` headers. Grep-friendly: `grep -rn "TypeName" wiki/` lands in the owner article.
- **Cross-links** (chapter-folder relative paths):
  - Same chapter sibling: `[Name](<slug>.md)`
  - Same Part different chapter: `[Name](../<chapter>/<slug>.md)`
  - Different Part: `[Name](../../<NN-part>/<chapter>/<slug>.md)`
  - Appendix from any article: `[Group](../../../appendix-a-seam-types.md)`
- **Forward-only Lifecycle edges.** Each article authors `## Lifecycle edges § Depends on:` manually. The reciprocal `## Lifecycle edges § Used by:` block is COMPUTED by `compute-used-by.py` from the inverse Depends-on graph — do not author it manually (it gets overwritten).
- **`## See also` is hand-authored and asymmetric by design.** Unlike Lifecycle edges, See-also reciprocity is NOT enforced. Hub articles (anything that ≥4 other articles point at) deliberately do NOT back-link to every spoke; reciprocal back-links would clutter their See-also into uselessness. Spoke→hub is one-way by convention. Only **peer↔peer** See-also relationships should be reciprocal — and those are a per-pair judgment call, not a mechanical reciprocity rule.

## Workflow

### Step 1 — Discover the change

Ask if unclear: _What changed?_ New type? Renamed? Deleted? New subsystem? New root asset? New rule? New controller?

Concrete sources of change:
- Agent reports from previous work ("added `XxxPart` to handle Y").
- `git log` / `git diff` on the paths that changed.
- Code search / IDE symbol search for a new name.

**Discovery hygiene:**
- Prefer commit messages when they're detailed; fall back to `git diff --name-status` over the commit range when messages are thin; targeted code search is for disambiguating a specific name, not bulk enumeration.
- Scope-reduce before classifying: ignore paths outside the runtime code and data folders for wiki-impact purposes.
- Re-run `git status --porcelain` + `git diff HEAD -- <file>` at the moment of Step 1. Session-start snapshots age out.
- Use the commit range that future maintainers will see via `git log`.

### Step 2 — Classify

Routing rubric. **Approval column = does this need user sign-off before editing the wiki?**

| Change | Action | Approval? |
|---|---|---|
| New type fitting an existing article's Keywords | Append to Keywords list in place | ❌ No |
| Rename type | `grep -r <OLD_NAME> wiki/`, replace across all hits, rerun validators | ❌ No |
| Delete type | Remove from Keywords; if it was the last mention, remove any dedicated Pitfall/Pattern bullet too | ❌ No |
| Code contradicts existing Stance / Role sentence | Revise the sentence — obvious correction | ❌ No |
| Code contradicts a Rule/Pitfall bullet | **Escalate** — the rule may no longer hold | ✅ Yes |
| New subsystem under existing article | Mention as sub-hint in See-also or Stance; never as a new article. **If it introduces a cross-article dependency, also add to `## Lifecycle edges § Depends on:` on the source side; `compute-used-by.py` will populate the reverse.** | ❌ No |
| New article needed (subsystem too large for inline mention) | **Escalate** — possible new article OR chapter expansion. New article: ≥7 distinct types + distinct reader-task. | ✅ Yes |
| Cross-cutting concept that doesn't fit any one chapter | Update `appendix-a-seam-types.md` (create if absent) to reference primary owner; new appendix entry only if it spans 3+ chapters | ❌ No for cross-link addition; ✅ Yes for new appendix entry |

**Rows are not mutually exclusive.** When N new types form a new subsystem, all N fire Row 1 (Keyword append) AND Row 6 fires once (Stance / See-also hint + Lifecycle edge if applicable).

**What NOT to update.** Some code changes look wiki-relevant but stay outside the wiki:
- **Editor-side types** (validators, importers, tooling UI, editor-scoped code paths). The wiki is a runtime-code reference; editor tooling is out of scope. If a validator encodes a design constraint worth surfacing, capture it as a See-also Rule bullet on the owning article, never as a Keyword.
- **Test classes.** The testing-system articles cover the framework as a whole; individual test classes do not appear in article Keywords.
- **Webview-only UI wiring for this project.** The extension host is the runtime surface documented in the wiki. Webview event handlers, DOM plumbing, and CSS live in the code but are out of scope for wiki keywords unless they surface a cross-boundary invariant.

**Attribute-based component ownership follows the target, not source location.** If the project uses attribute annotations to bind data-model components to their target types, the component lives in the wiki article that hosts its target — regardless of where the source file sits. The component serializes into the target's payload, so it's data-model-side regardless of source-folder. Adapt this rule to whatever equivalent attribute your project uses.

**Rename-vs-replace migrations.** When a delete + new-type pair is a migration (the old type replaced by a new one filling the same semantic slot), classify each item under its rubric row and surface the migration explicitly: a See-also Pattern/Pitfall bullet on the affected article, or in the commit message.

**When in doubt — escalate.** The cost of an unwanted article is larger than the cost of a 30-second confirmation.

### Step 3 — Update in place

1. **Find all affected files:** `grep -r <TYPE_NAME> wiki/`. A keyword often lives in 2-4 articles (owner + consumers).
2. **Update each affected section:**
   - **Keywords** — one identifier per line, backticked, grouped under a `**Types — {label}:**` or `**Methods:**` header. New subsections go near their semantic neighbour.
   - **Stance / Role** — if the change affects "what's non-obvious," revise; else leave alone. New Role paragraphs go where they preserve the existing narrative flow.
   - **Lifecycle edges § Depends on:** — if a new dependency crosses articles, append `- [B](rel/path/B.md) — short reason` at the end of the source article's Depends-on list. Don't manually edit the target's `Used by:` — `compute-used-by.py` will populate it from the inverse graph.
   - **See also** — if a new Pitfall / Pattern / Rule surfaces, add a bullet. Cross-references to other articles + appendix routing also live here.
   - **New subsystem = multiple placements, not one.** Edits in Stance (why-it-exists framing), Role (what-it-does mechanism), AND See-also (non-obvious rules / pitfalls).
   - **Attribute blanket-coverage exemption.** If an attribute is already listed via a scope phrase (e.g. "every persistable component"), don't add a per-type entry for new types matching the scope.
3. **Namespace moves** — if a type moved, update the article's Namespaces list too.
4. **Cross-link conventions:**
   - Same chapter sibling: `<slug>.md`
   - Same Part different chapter: `../<chapter>/<slug>.md`
   - Different Part: `../../<NN-part>/<chapter>/<slug>.md`
   - Appendix from any article: `../../../appendix-a-seam-types.md`

### Step 4 — Validate

```bash
python3 .agents/skills/wiki-maintain/scripts/validate.py wiki
python3 .agents/skills/wiki-maintain/scripts/compute-used-by.py wiki
python3 .agents/skills/wiki-maintain/scripts/structure-enum-check.py wiki .agents   # only if you edited a SKILL.md or AGENTS.md
```

`validate.py` exits 0 if no `[E]` errors. `[W]` warnings (THIN articles <80 lines or intros <50 lines) are non-blocking. `[I]` info hints — usually resolved by running `compute-used-by.py`.

`compute-used-by.py` rewrites every article's `**Used by:**` block from the inverse Depends-on graph. Idempotent — running twice with no source change produces no diff.

After validators pass, eyeball `git diff --stat HEAD -- wiki/` — if the change shape doesn't match your Step 2 planned edits, something drifted. Scope creep caught cheaply.

### Step 5 — Log

Prepend a dated entry to `wiki/changelog.md`:

```
## YYYY-MM-DD — <short scope label>

- **Code:** <1-line description of what changed in the repo>
- **Wiki:** <files touched with section-level summary>
- **Escalations:** <open question reference or "none">
```

Newest entries at the top; never reshuffle past entries. Commit the wiki edits + changelog append in the same commit.

If the change required an escalated taxonomy update (new article, new chapter, or new appendix entry), also update `wiki/index.md` (TOC) + `appendix-a-seam-types.md` if a new cross-cutting concept landed.

## Escalation checklist — new article, new chapter, or new appendix entry

Before writing any of these, confirm:

- [ ] Does the concept appear in 3+ places in the codebase as a distinct concern (not a helper of an existing system)?
- [ ] Is it a subsystem (belongs as a sub-hint inside an existing article) or a sibling system (deserves its own article in the same chapter)? Default is subsystem.
- [ ] If a new article: does it have ≥7 distinct types + distinct reader-task that justifies a separate entry vs inline-mention in an existing article?
- [ ] If a new chapter: does it have 2+ articles' worth of content in distinct sub-areas? (New chapters are rare.)
- [ ] Is it cross-cutting (3+ chapters)? If yes, appendix entry; otherwise a regular sub-hint inside one article.

Present the checklist to the user in one message. Wait for explicit approval before creating the new entry.

## Non-scope

- **Automated code-index diff** (finding types added/removed/renamed in code not yet reflected in wiki) — not part of this skill's scope. Rely on the triggers above + manual `grep`.
- **Auto-sync hooks** — no hook listens for code changes and updates wiki; manual workflow.

## Scripts inventory

### `scripts/validate.py`
Severity-tiered checks. Recursive walk over `wiki/parts/**/*.md` + `wiki/appendix-a-seam-types.md`.
- `[E]` ERROR — broken md-links, TBD leftovers, Cyrillic content. Blocks (exit 1).
- `[W]` WARN — THIN articles (<80 lines), THIN intros (<50 lines). Non-blocking.
- `[I]` INFO — reciprocal asymmetries (`Depends on` without reverse `Used by`). Usually resolved by running `compute-used-by.py` next.

Output uses ASCII tags ([E]/[W]/[I]) instead of emoji for Windows console compat.

### `scripts/compute-used-by.py`
Recompute every article's `**Used by:**` section from inverse Depends-on graph. Forward-only authoring: you write `Depends on`, the script writes `Used by`. Idempotent. Bullets sorted alphabetically by source's H1 for stable diffs.

Run after every Depends-on edit (Step 4).

### `scripts/structure-enum-check.py`
Single-source-of-truth check. Counts `wiki/parts/<NN-part>/` markdown links per file in `wiki/AGENTS.md`, `wiki/CLAUDE.md`, `<extra>/AGENTS.md`, `<extra>/CLAUDE.md`, `<extra>/SKILL.md`. Files (other than `wiki/index.md`) with >5 such links flagged as duplicate-enumeration smell.

Run when editing `AGENTS.md`, `CLAUDE.md`, or SKILL.md files.

### `scripts/reciprocal.py` (DEMOTED)
Legacy bidirectional asymmetry check. Demoted because forward-only Depends-on + computed Used-by replaced the bidirectional invariant. Use this script for first-pass migration validation, rare manual asymmetry checks, or post-`compute-used-by` verification. `--fix` mode survives unchanged for legacy use; for the steady-state workflow, prefer `compute-used-by.py`.

## Reading

- Wiki TOC: `wiki/index.md`.
- Seam-type cheatsheet: `wiki/appendix-a-seam-types.md` (optional).
- Per-chapter intros: `wiki/parts/<NN-part>/<chapter>/_intro.md`.

## Cross-harness notes

This skill file is stored under `.agents/skills/wiki-maintain/` per the [Agent Skills](https://agentskills.io) convention. Validator scripts live alongside it under `scripts/` so any agent that can read this SKILL.md can also invoke the scripts with the same relative paths. Python 3.9+ is the only tooling requirement.
