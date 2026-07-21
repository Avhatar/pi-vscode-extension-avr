# Chapter: raw-mode

RawMode is the per-chat developer view of the full agent-to-model exchange. Every `pi.on(...)` event, every provider payload, every response, every stream chunk — captured verbatim, appended to a JSONL file keyed by session path, replayable through a dedicated panel. Not a debug flag: **always recording, always unbounded**, deleted only by explicit user action (clear this session, clear all, or delete the parent history session).

## Article roster

- [raw-mode](raw-mode.md) — three-layer architecture (recorder / ring-buffer / storage port), Node JSONL storage, inline Pi extension, RawPanel + serializer, RawMode webview, cleanup via `deleteHistorySession`.

## Reader task

The reader arrives here to answer one of:

- "Where do the recorded events live on disk?"
- "How is the recorder started — per session or globally?"
- "What events are captured — everything, or just the ones the UI cares about?"
- "How does the RawPanel survive `Reload Window`?"

## Neighborhood

- **Message shapes** (`RawEntry`, `RawEntryKind`, `RAW_HARNESS_EVENT_KINDS`, `RAW_SESSION_ONLY_EVENT_KINDS`) live in [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md).
- **Storage port** contract is in [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md).
- **Settings-panel stats block** for RawMode is [Part VI § settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md).
- **Cleanup** wired into `deleteHistorySession` is documented in [Part I § activation-and-registration](../../01-extension-host-substrate/activation-and-registration/activation-and-registration.md) — the deletion call site.

## Non-goals

- Redaction / retention policy — the design decision is "no redaction, no retention"; user-initiated Clear is the only removal path.
- Cross-session correlation — the recorder is per-session, not per-tab.
- Analysis / query language — RawMode is a raw dump for humans; consume via the panel or read the JSONL directly.
