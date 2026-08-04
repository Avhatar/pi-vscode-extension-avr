# Wiki Changelog

Newest entries at the top. Never reshuffle past entries. `wiki-maintain` prepends a dated entry for every edit that touches wiki content.

Format for each entry:

```
## YYYY-MM-DD — <short scope label>

- **Code:** <1-line description of what changed in the repo>
- **Wiki:** <files touched with section-level summary>
- **Escalations:** <open question reference or "none">
```

## 2026-08-03 — DeepSeek balance and monetary turn accounting

- **Code:** Added official DeepSeek balance refreshes, key/date-scoped local daily spend accounting, SDK session-cost turn deltas, typed host/webview messages, and chat footer presentation for remaining balance plus turn, session, and daily costs.
- **Wiki:** `message-protocol.md` and `protocol-runtime.md` now list the DeepSeek payloads and runtime schema; `tab-registry-and-runtime.md` and `chat-host-and-service.md` document provider-specific monetary turn metadata; `session-lifecycle.md` records the cumulative session-cost projection; `models-and-auth.md` owns the DeepSeek account store, credential use, and persisted daily ledger.
- **Escalations:** none — the feature extends existing protocol, chat-accounting, session, and auth articles without meeting the new-article threshold.

## 2026-08-02 — Marketplace patch readiness

- **Code:** Refreshed Marketplace and repository product documentation and the Marketplace screenshot for the changes accumulated since Marketplace 0.57.1, expanded manifest discovery metadata, moved CI to Node.js 22.19 with unit-test and tag/version gates, documented the current packaged size and explicit publication boundary, updated vulnerable transitive dependencies, and added a deterministic install/package guard plus SemVer boundary coverage for the Pi SDK's shrinkwrapped vulnerable `brace-expansion` copy.
- **Wiki:** `packaging-and-release.md` now records the roughly 120 MB compressed runtime package, explicit Marketplace publication and verification step, matching-tag rule, private standalone-submodule boundary, and physical runtime-dependency repair gate; its chapter intro no longer describes the retired Electron packager as the active standalone build, and the computed reverse edge in `desktop-host-lifecycle.md` was refreshed. `bundled-pi-packages.md` documents why the local repair is not `pi install` and why audit metadata can outlive the removed nested package, while `bundle-targets-and-esbuild.md` includes runtime verification in the package chain. The Raw Mode article and intro now describe opt-in capture, immediate stop-on-disable, retained recordings, and every supported deletion path accurately.
- **Escalations:** none — these are corrections and extensions to the existing packaging-and-release article, with no taxonomy change.

## 2026-08-01 — Chat rename, subagent defaults, and automatic wiki maintenance

- **Code:** Added typed inline chat renaming in editor panels, raised default child-agent execution limits from 30 turns / 10 minutes to 60 turns / 30 minutes, and aligned the bundled `deepseek-v4-implementer` definition; repository guidance now requires an automatic wiki-impact check and in-place synchronization during every relevant change.
- **Wiki:** `chat-command-service.md` and `message-protocol.md` now document the typed `renameTab` path; `subagent-manager-and-lifecycle.md` records the new execution defaults. The two retired desktop IPC pages now point to the private `standalone/` successor instead of a deleted migration note. Recomputed five stale `Used by` sections from the dependency graph. `wiki-maintain` policy and workflow now make existing-article synchronization a required completion gate rather than an opt-in follow-up.
- **Escalations:** none — these are existing-article fact, link, graph, and maintenance-rule corrections without a taxonomy change.

## 2026-07-23 — Standalone-repo split reflected in TOC framing

- **Code:** Split standalone into a separate private repo <https://github.com/Avhatar/pi-code-standalone> attached as a submodule at `standalone/` (commit `09434c3`); then inlined the fonts/assets into that submodule and dropped the nested `pi-code-standalone-assets` layer (commit `ec5df86`). CRT-shader work (commit `fc8edd1`) lives entirely inside the submodule and does not surface in the extension-runtime wiki.
- **Wiki:** `index.md` — updated the two `Part X — standalone desktop host *(retired)*` framing paragraphs (Reading-order §8 and Part X section header) to describe standalone as a private submodule rather than an in-tree `standalone/desktop-rs-poc/` directory. No Part X article body edits (they remain the intentional Electron historical snapshot). Validators pass with `[E] ERROR: none`; `compute-used-by.py` reported 0 updates (no `Depends on` graph changes).
- **Escalations:** none — Stance-sentence revision per Step 2 rubric row 4. Follow-up: Part X `desktop-*` articles still cite `standalone/desktop/src/...` file paths for the retired Electron implementation — those code links have been broken since the Electron retirement on 2026-07-22 and remain broken by design (historical snapshot). No action planned.

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
