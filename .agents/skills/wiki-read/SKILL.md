---
name: wiki-read
description: Use to orient on any subject in this repo — code systems, tooling, asset/localization pipelines, tests — via the committed wiki at `wiki/`. Auto-fire as a prelude to investigating, describing, planning around, or modifying any system / type / concept / pipeline / tool the agent has not just touched in-session. Read the wiki before greping code, so reasoning starts from real context instead of hypothesis. Do NOT use as a substitute for `wiki-maintain` (editing wiki content).
---

# wiki-read

Lightweight read-only lookup into the repo wiki at `<repo-root>/wiki/`. The wiki is a book — Parts → chapters → articles + an optional appendix routing cross-cutting seam types to their owning chapters. Builds a mental model of a subject in a few minutes so downstream work (planning, coding, research dispatch) starts with real context instead of hypothesis.

Code is one important subject of the repo, not the whole story. Pipelines, assets, and tooling all have wiki articles too.

## When to invoke

- Before planning work on an unfamiliar system, tool, or pipeline — cheap priming.
- When you need to know which article owns a concept / type / tool — grep the wiki.
- Quick sanity checks: "which chapter is X in?", "who depends on system Y?", "is `SomeType` in the tooling chapter or part of runtime architecture?".

## When NOT to invoke

- You are editing wiki content (new type, rename, pitfall revision) → `wiki-maintain`.
- You already know the target article and want to read it directly → just read the file; no skill needed.
- The wiki is empty (no `wiki/parts/**` content yet). Say so and fall back to source-first investigation.

## Output format (always produced)

Every `wiki-read` invocation — inline or via a dispatched agent — finishes by producing a **compact summary report** of target length **~50–60 lines**. The report is the deliverable; full article content is *not* piped back into the consumer's context. Sections:

- **Scope match** — which wiki articles were identified as relevant and why.
- **Key facts** — stance + the critical role / rule / pitfall bullets that answer the question being asked. Dense, not verbose.
- **Open gaps** — what the wiki alone does not answer; points the consumer toward source-first investigation or a dedicated research agent.
- **Links** — every claim cites the source wiki article via `[Article](wiki/parts/<NN-part>/<chapter>/<slug>.md)` so the consumer can follow up without re-greping.

The consumer of the report (orchestrator if inline, caller if dispatched) decides: act on it, follow a specific link for deeper reading, or escalate to source-first investigation.

## Invocation modes

The output format does not change between modes — only who runs the workflow.

- **Inline (default).** The orchestrator runs the workflow itself and produces the report. Suitable for narrow scope, when full wiki content is small enough that landing it in session context briefly is fine.
- **Dispatched.** The orchestrator dispatches a general-purpose sub-agent with this skill, the scope, and an instruction to return only the report. Use when scope is broad, when many wiki articles would otherwise crowd the orchestrator's context, or when the lookup is part of a larger orchestration where the agent's intermediate reading is throwaway.

## Workflow (same in both modes)

1. **TOC sweep.** Read `wiki/index.md` — book-chapters TOC (Parts → chapters). The index lists chapters with one-line descriptions; the per-chapter article roster lives in each chapter's `_intro.md` § Article roster (next step). Locate the target's approximate chapter from the TOC.
2. **Keyword grep.** `grep -rni "<target>" wiki/` — find the owning article(s). A concept usually appears in its owner plus 2–4 consumer articles.
3. **Read the chapter intro.** `wiki/parts/<NN-part>/<chapter>/_intro.md` frames what the chapter is about, lists its article roster (`## Article roster`), and (often) covers the cross-cutting seam content owned by the chapter.
4. **Read the owner article in full.** `Stance` + `Role` build the mental model; `Keywords` give the surface (types / paths / programs / formats / protocols, depending on the chapter); `Lifecycle edges` show the dependency graph around the subject.
5. **Read neighbours shallowly.** For each `Depends on` / `Used by` / `See also` target that's in-scope for the question, read at least its `Stance` and `Role`. Follow only edges that matter — don't chase the whole graph.
6. **Follow appendix refs.** If the article cites `appendix-a-seam-types.md` (or a similarly-named cross-cutting appendix), skim the matching entry — seam types are cross-cutting and the appendix maps them to their primary chapter homes.
7. **Produce the summary report** in the `## Output format` shape above. Cite every claim with a wiki link. Flag anything that looks stale relative to current code in the `Open gaps` section.

## Scope-to-chapter heuristics

Once the wiki has been populated for this project, add project-specific routing hints here — e.g. "chat session lifecycle → Part I, `pi-session-runtime`". Until then, rely on the TOC + grep workflow above. Do NOT enumerate the full chapter list here — that duplicates `wiki/index.md`, which is the single source of truth for structure (see `structure-enum-check.py`).

## Hypothesis, not truth

Wiki articles are primes, not gospel. Before acting on a non-obvious claim (a pitfall bullet, a "Rule —" line, a declared invariant), verify against current source or tool state. If evidence disagrees with the wiki, that's a trigger for `wiki-maintain`, not for silently trusting one over the other.

## Reading

- `wiki/index.md` — book-chapters TOC.
- `wiki/appendix-a-seam-types.md` — cross-cutting seam-type cheatsheet (optional; present only if the project has cross-cutting concepts worth cataloguing).
- `wiki/AGENTS.md` — conventions for wiki content (vendor-neutral; open before editing or navigating wiki content the first time in a session).

## Cross-harness notes

This skill file is stored under `.agents/skills/wiki-read/` per the [Agent Skills](https://agentskills.io) convention. Harnesses with native discovery (Claude Code, Pi Code, others) invoke it automatically; other agents (Codex, Cursor, Aider, Continue) can execute this markdown workflow inline — no vendor-specific tool calls are required from inside the workflow above.
