# Wiki Changelog

Newest entries at the top. Never reshuffle past entries. `wiki-maintain` prepends a dated entry for every edit that touches wiki content.

Format for each entry:

```
## YYYY-MM-DD — <short scope label>

- **Code:** <1-line description of what changed in the repo>
- **Wiki:** <files touched with section-level summary>
- **Escalations:** <open question reference or "none">
```

## 2026-07-22 — Parts VI–XI bootstrap authoring + Parts I–V backfill

- **Code:** No code changes — this pass continues wiki bootstrap from where the 2026-07-21 entry stopped.
- **Wiki:** Authored 20 articles + 20 chapter intros across Parts VI–XI (UI surfaces webview, safety and reversibility, message flow discipline, subagents, standalone desktop host, auxiliary systems). Backfilled every "not yet authored" plain-text reference in Parts I–V to now-existing markdown links across 9 files. Ran `compute-used-by.py`; 37 files got 112 computed reverse edges. All 78 wiki files now form a complete graph with forward-only `Depends on` authored + `Used by` computed. Validator passes with `[E] ERROR: none` and no `[I]` info hints. Structural enumeration remains limited to `index.md` (no `AGENTS.md` / SKILL.md changes needed).
- **Escalations:** none — no new articles / chapters / appendix entries beyond what was already reserved in the TOC. Appendix (`appendix-a-seam-types.md`) still uncreated; the current article set has clear enough cross-links that a seam-types cheatsheet is not needed yet. Follow-up considerations for future maintenance passes: (a) expand THIN intros (below 50-line threshold) — non-blocking warnings, ~50 files affected; (b) expand THIN articles (below 80-line threshold) — ~10 affected; (c) revisit `chat-event-policy` and `bundled-pi-packages` articles once new event types / new bundled Pi packages appear, since both have narrow authoritative surface areas.

## 2026-07-21 — Parts I–V bootstrap authoring

- **Code:** No code changes — the wiki `parts/**` tree was empty scaffold; this pass populates it for the first time.
- **Wiki:** Authored 19 articles + 19 chapter intros across Parts I–V (extension host substrate, shared protocol / contracts, portable chat core, platform adapters, Pi SDK integration). Every article follows the `Stance / Role / Keywords / Lifecycle edges / See also` schema; every intro carries a chapter description + article roster + reader task + neighborhood + non-goals. Forward-only `Depends on` edges authored; ran `compute-used-by.py` to populate reverse `Used by` bullets (43 computed edges across 19 files). Parts VI–XI remain empty scaffold — cross-references to them in Parts I–V articles are rendered as unlinked "not yet authored" plain-text mentions until those chapters are written. `[W]` THIN warnings remain on a subset of the shorter intros / articles but are non-blocking; validator passes with `[E] ERROR: none`.
- **Escalations:** none — this is the first authoring pass of an empty wiki, so no rule/pitfall contradictions were encountered. Next scheduled pass: Parts VI–XI (UI surfaces webview, safety and reversibility, message flow discipline, subagents, standalone desktop host, auxiliary systems). Appendix (`appendix-a-seam-types.md`) remains uncreated — no cross-cutting concept has yet spanned 3+ chapters in the authored set.

## 2026-07-21 — RawMode chapter reservation

- **Code:** Added RawMode — per-chat developer view of the full agent-to-model exchange. Portable recorder + ring buffer under `src/core/raw/`, Node JSONL storage adapter under `src/adapters/vscode/raw-storage.ts`, inline Pi extension in `src/pi/raw-recorder-extension.ts` subscribing to every `pi.on(...)` event plus `onPayload`/`onResponse` stream capture, RawPanel + serializer, Settings-panel stats block, and cleanup wired into `deleteHistorySession`.
- **Wiki:** `index.md` — reserved a new chapter line `raw-mode` under Part XI (Auxiliary systems) next to `lsp-tools`, matching the "opt-in developer surface that sits around the main product" framing. No article files created — the wiki is still in bootstrap state (empty `parts/**`); this update only tracks the placement decision so the first article-writing pass has a slot to fill.
- **Escalations:** none — TOC-only edit; the article body itself will be authored when `parts/**` starts being populated. Scope check when that happens: RawMode has 10+ distinct types (`RawRecorder`, `RawEntryBuffer`, `RawStoragePort`, `NodeRawStorage`, `RawRecorderRegistry`, `RawPanel`, `RawPanelSerializer`, `RawEntry`, `RawEntryKind`, `RawStorageStats`, `createRawRecorderExtension`) and a distinct reader-task (debugging what the agent sees), so it clears the ≥7-types-and-distinct-reader-task bar for a standalone article.
