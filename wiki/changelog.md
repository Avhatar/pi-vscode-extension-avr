# Wiki Changelog

Newest entries at the top. Never reshuffle past entries. `wiki-maintain` prepends a dated entry for every edit that touches wiki content.

Format for each entry:

```
## YYYY-MM-DD — <short scope label>

- **Code:** <1-line description of what changed in the repo>
- **Wiki:** <files touched with section-level summary>
- **Escalations:** <open question reference or "none">
```

## 2026-07-21 — RawMode chapter reservation

- **Code:** Added RawMode — per-chat developer view of the full agent-to-model exchange. Portable recorder + ring buffer under `src/core/raw/`, Node JSONL storage adapter under `src/adapters/vscode/raw-storage.ts`, inline Pi extension in `src/pi/raw-recorder-extension.ts` subscribing to every `pi.on(...)` event plus `onPayload`/`onResponse` stream capture, RawPanel + serializer, Settings-panel stats block, and cleanup wired into `deleteHistorySession`.
- **Wiki:** `index.md` — reserved a new chapter line `raw-mode` under Part XI (Auxiliary systems) next to `lsp-tools`, matching the "opt-in developer surface that sits around the main product" framing. No article files created — the wiki is still in bootstrap state (empty `parts/**`); this update only tracks the placement decision so the first article-writing pass has a slot to fill.
- **Escalations:** none — TOC-only edit; the article body itself will be authored when `parts/**` starts being populated. Scope check when that happens: RawMode has 10+ distinct types (`RawRecorder`, `RawEntryBuffer`, `RawStoragePort`, `NodeRawStorage`, `RawRecorderRegistry`, `RawPanel`, `RawPanelSerializer`, `RawEntry`, `RawEntryKind`, `RawStorageStats`, `createRawRecorderExtension`) and a distinct reader-task (debugging what the agent sees), so it clears the ≥7-types-and-distinct-reader-task bar for a standalone article.
