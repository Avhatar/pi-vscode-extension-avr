# Wiki — Repo Navigation Map

This folder is the navigation atlas of the repo. **The wiki is organized as a book** — Parts → Chapters → Articles. Each article is dense enough to orient an LLM on its subject in a single read. Cross-cutting concepts that don't fit one chapter (former "seam types") are mapped to their primary chapter homes via the appendix (create only when needed).

## Entry points

- [`index.md`](index.md) — the book-chapters TOC. **Start here.**
- [`appendix-a-seam-types.md`](appendix-a-seam-types.md) — cross-cutting seam-type cheatsheet (optional; present only when the project has cross-cutting concepts worth cataloguing).
- [`changelog.md`](changelog.md) — per-change log of wiki updates (prepended by `wiki-maintain`, newest at top).
- `parts/<NN-part>/<chapter>/_intro.md` — chapter intros; frame what each chapter covers and absorb the relevant seam-type content per the appendix routing.
- `parts/<NN-part>/<chapter>/<article>.md` — article files, each with `Stance` / `Role` / `Keywords` / `Lifecycle edges` / `See also`.

## Skills

Pick the right one for the operation you want:

- **`/wiki-read`** — lightweight read-only lookup. Use when orienting on a system, scoping a planned investigation, or answering "which article owns type X". No writes.
- **`/wiki-maintain`** — validation and in-place updates. Use when code changes introduce, rename, or delete types that appear in wiki Keywords, or when a rule/pitfall bullet is contradicted by new code.

## Conventions

- **English only.** No Cyrillic in any file under `wiki/`.

Wiki-authoring conventions (article schema, Keywords listing, cross-link paths, lifecycle-edge discipline, see-also asymmetry rule) live in skill `wiki-maintain` so they load only when wiki is being edited.

## Hypothesis, not truth

Wiki content is a **prime for reasoning**, not ground truth. It is written from real code but it can lag behind renames, new components, or removed subsystems. Verify any load-bearing factual claim against current source before acting on it — especially before editing code or designing a fix around a described invariant.
