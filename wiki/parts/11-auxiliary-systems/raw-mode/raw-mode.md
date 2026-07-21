# raw-mode

## Stance

Three layers keep RawMode auditable. **Recorder** owns per-session state — buffered ring for recent tail, chained async write to disk, pending → concrete session-path rebind. **Ring buffer** is a fixed-capacity FIFO (default 5000) for the newest entries; older data lives only on disk. **Storage** is JSONL under `<globalStorage>/raw/<SHA256(sessionPath)>.jsonl` with a manifest + per-file meta sidecar so `list()` doesn't have to rescan large files. Two capture channels feed the recorder: an inline Pi extension (harness-level events via `pi.on`) and an `EventRouter.onAll` subscription (session-only events). The two are recorded verbatim without dedup — the panel groups them visually.

## Role

Storage on disk under `<globalStorageUri>/raw/`:

- Manifest [raw-storage.ts:24](../../../../src/adapters/vscode/raw-storage.ts#L24) — `{ version: 1, entries: Record<hash, { hash, sessionPath, createdAtMs }> }`.
- Per-session JSONL — one line per entry, filename is `<SHA256(sessionPath)>.jsonl`.
- Meta sidecar [raw-storage.ts:29](../../../../src/adapters/vscode/raw-storage.ts#L29) — `{ hash, mtimeMs, sizeBytes, entryCount, firstEntryAtMs, lastEntryAtMs, lastSeq }` — caches counts for `list()`.

`NodeRawStorage` [raw-storage.ts:48](../../../../src/adapters/vscode/raw-storage.ts#L48) implements `RawStoragePort`:

- `append(sessionPath, line)` [raw-storage.ts:66](../../../../src/adapters/vscode/raw-storage.ts#L66) — ensures root + manifest, registers session, appends line, invalidates stale meta.
- `readRange(sessionPath, fromSeq, count)` [raw-storage.ts:77](../../../../src/adapters/vscode/raw-storage.ts#L77) — streams above threshold [raw-storage.ts:16](../../../../src/adapters/vscode/raw-storage.ts#L16) (50 MB), single-read below.
- `list()`, `deleteSession()`, `clearAll()`, `getStorageDir()`, `getSessionFile()`.

`RawRecorder` [raw-recorder.ts:45](../../../../src/core/raw/raw-recorder.ts#L45) — per-session:

- Constructor [raw-recorder.ts:58](../../../../src/core/raw/raw-recorder.ts#L58) — takes storage, logger, capacity, clock, initialSeq, sessionPath, pendingId.
- `record(kind, payload)` [raw-recorder.ts:102](../../../../src/core/raw/raw-recorder.ts#L102) — assigns seq/timestamp, serializes, chains async write, notifies listeners.
- `bindSessionPath(newPath)` [raw-recorder.ts:141](../../../../src/core/raw/raw-recorder.ts#L141) — migrates pending → concrete; re-stamps buffered entries; emits `session_bind` meta marker.
- `snapshot()`, `entriesSince(fromSeq)` — buffer queries.
- Private `_serialize()` [raw-recorder.ts:202](../../../../src/core/raw/raw-recorder.ts#L202) — JSON.stringify with fallback for un-serializable values.
- Private `_enqueueAppend()` [raw-recorder.ts:218](../../../../src/core/raw/raw-recorder.ts#L218) — Promise-chain write serialization; captures storage errors as `recorder_error` meta entries.

`RawRecorderRegistry` [raw-recorder.ts:271](../../../../src/core/raw/raw-recorder.ts#L271):

- Process-wide index by sessionPath.
- `register`, `rebind`, `dispose(sessionPath)`.
- `onMount`, `onDataCleared` subscriptions.

`RawEntryBuffer` [raw-entry-buffer.ts:19](../../../../src/core/raw/raw-entry-buffer.ts#L19) — FIFO ring, `DEFAULT_RAW_BUFFER_CAPACITY = 5000` [raw-entry-buffer.ts:3](../../../../src/core/raw/raw-entry-buffer.ts#L3).

Pi extension [raw-recorder-extension.ts:17](../../../../src/pi/raw-recorder-extension.ts#L17) — `createRawRecorderExtension(recorder)`: iterates `RAW_HARNESS_EVENT_KINDS`, subscribes each via `pi.on(kind, handler)`, each handler calls `recorder.record(kind, event)`.

RawPanel [raw-panel.ts:46](../../../../src/providers/raw-panel.ts#L46):

- Constructor [raw-panel.ts:55](../../../../src/providers/raw-panel.ts#L55) — takes panel, services (`extensionUri`, storage, registry, optional `resolveDisplayTitle`), sessionPath.
- `_bindRecorder(recorder)` [raw-panel.ts:122](../../../../src/providers/raw-panel.ts#L122) — subscribes to `onEntry`; posts `raw.append`.
- `_sendInitialSnapshot()` [raw-panel.ts:131](../../../../src/providers/raw-panel.ts#L131) — reads first 500 entries from storage.
- Auto-dispose on `onDataCleared` [raw-panel.ts:86](../../../../src/providers/raw-panel.ts#L86) — panel closes if the underlying data is wiped.

Serializer — same file — restores the RawPanel across `Reload Window`, keyed by `sessionPath`.

Cleanup wiring in `ChatController.deleteHistorySession` [chat-controller.ts:478](../../../../src/controllers/chat-controller.ts#L478):
1. `_rawRecorderRegistry?.dispose(sessionPath)` — close live recorder.
2. `_rawStorage?.deleteSession(sessionPath)` — remove JSONL + sidecars.
3. `_rawRecorderRegistry?.notifyDataCleared(sessionPath)` — fire listener so open RawPanels auto-close.
4. Unlink session history file.

## Keywords

**Types — protocol:**
- `RawEntry`, `RawEntryKind`, `RAW_HARNESS_EVENT_KINDS`, `RAW_SESSION_ONLY_EVENT_KINDS`, `RawRecorderMetaPayload`, `RawSessionSummary`, `RawStorageStats` — [src/shared/raw-protocol.ts](../../../../src/shared/raw-protocol.ts)
- `RawClientMessage`, `RawServerMessage`, `RawModeSettingsClientMessage`, `RawModeSettingsServerMessage` — same file

**Types — core:**
- `RawRecorder` — [raw-recorder.ts:45](../../../../src/core/raw/raw-recorder.ts#L45)
- `RawRecorderRegistry` — [raw-recorder.ts:271](../../../../src/core/raw/raw-recorder.ts#L271)
- `RawEntryBuffer` — [raw-entry-buffer.ts:19](../../../../src/core/raw/raw-entry-buffer.ts#L19)
- `RawRecorderOptions` — [raw-recorder.ts](../../../../src/core/raw/raw-recorder.ts)

**Types — storage:**
- `RawStoragePort` — port [src/core/ports/raw-storage.ts](../../../../src/core/ports/raw-storage.ts)
- `NodeRawStorage` — adapter [src/adapters/vscode/raw-storage.ts:48](../../../../src/adapters/vscode/raw-storage.ts#L48)
- `Manifest`, `MetaSidecar` — internal shapes in the adapter

**Types — panel:**
- `RawPanel` — class [src/providers/raw-panel.ts:46](../../../../src/providers/raw-panel.ts#L46)
- `RawPanelSerializer` — same file

**Types — extension:**
- `createRawRecorderExtension(recorder)` — [src/pi/raw-recorder-extension.ts:17](../../../../src/pi/raw-recorder-extension.ts#L17)

**Methods — recorder:**
- `record(kind, payload)` — [raw-recorder.ts:102](../../../../src/core/raw/raw-recorder.ts#L102)
- `bindSessionPath(newPath)` — [raw-recorder.ts:141](../../../../src/core/raw/raw-recorder.ts#L141)
- `snapshot()`, `entriesSince(fromSeq)` — buffer queries

**Methods — storage:**
- `append`, `readRange`, `getNextSeq`, `list`, `deleteSession`, `clearAll`, `getStorageDir`, `getSessionFile`

**Attributes / markers:**
- Filename: `<SHA256(sessionPath)>.jsonl`
- Default buffer capacity: 5000
- Stream threshold: 50 MB
- View id: `pi-code.raw`
- Two capture channels: harness events (via `pi.on`) + session-only events (via `EventRouter.onAll`) — no dedup

**Namespaces:**
- [src/core/raw/](../../../../src/core/raw/) — portable recorder + ring buffer
- [src/adapters/vscode/raw-storage.ts](../../../../src/adapters/vscode/raw-storage.ts) — Node JSONL storage
- [src/pi/raw-recorder-extension.ts](../../../../src/pi/raw-recorder-extension.ts) — inline Pi extension
- [src/providers/raw-panel.ts](../../../../src/providers/raw-panel.ts) — RawPanel + serializer
- [src/webview/raw.ts](../../../../src/webview/raw.ts) — RawMode webview UI
- [src/webview/styles/raw.css](../../../../src/webview/styles/raw.css)

## Lifecycle edges

**Depends on:**
- [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — `RawStoragePort` declaration.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — recorder is created / mounted / bound per session.
- [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md) — session-only events are subscribed via `EventRouter.onAll`.
- [Part VI § settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) — stats block + clear buttons.

**Used by:**
- [settings-panel](../../06-ui-surfaces-webview/settings-panel/settings-panel.md) — stats block wires into the raw storage port.

## See also

- **Rule — always record, never redact.** The design is intentional: RawMode is what the agent saw, verbatim. Users who need privacy must use "Clear" (per-session or all) to remove; no filtering.
- **Rule — cleanup rides `deleteHistorySession`.** Deleting the parent chat session deletes the raw data. Do not add an orphan-collection pass; if history disappears, raw follows.
- **Pattern — two capture channels, no dedup.** Harness events (via `pi.on`) and session-only events (via `EventRouter.onAll`) are logged verbatim; the panel groups them by seq. Attempting to dedup at the recorder would confuse the timeline.
- **Pattern — pending → concrete rebind.** New sessions start with a pending id (the session file doesn't exist yet). Once the SDK opens the file and yields `sessionPath`, `bindSessionPath` migrates the recorder to the concrete path. Buffered entries get their `sessionPath` field rewritten.
- **Pitfall — the SHA256 filename is not reversible.** If you need to find the file for a session, use `NodeRawStorage.getSessionFile(sessionPath)` — do not compute the digest yourself.
- **Pitfall — the ring buffer capacity is not adjustable at runtime.** Setting it at construction is deliberate; changing it mid-session would invalidate the seq contract with subscribers.
- **Pattern — `session_bind` marker distinguishes migrations.** When the panel replays, seeing a `session_bind` in the stream tells it "everything before this is from a pending session" — the timeline label swaps accordingly.
