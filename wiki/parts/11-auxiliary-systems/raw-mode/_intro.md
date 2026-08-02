# Chapter: raw-mode

RawMode is the per-chat developer view of the full agent-to-model exchange. While the opt-in `pi-code.rawMode.enabled` setting is on, every `pi.on(...)` event, provider payload, response, and stream chunk is captured verbatim, appended to an unbounded JSONL file keyed by session path, and replayable through a dedicated panel. Disabling capture leaves existing recordings available until the user clears one session, clears all Raw Mode data, or deletes the corresponding History session.

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

- Redaction / automatic retention policy — enabled capture is verbatim and unbounded; removal occurs through per-session Clear, Clear All, or deletion of the corresponding History session.
- Cross-session correlation — the recorder is per-session, not per-tab.
- Analysis / query language — RawMode is a raw dump for humans; consume via the panel or read the JSONL directly.
