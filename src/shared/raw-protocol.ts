/**
 * RawMode wire types.
 *
 * RawMode is an opt-in developer view that records every event and provider
 * payload exchanged between the Pi agent and the model while enabled. These
 * types describe:
 *   - the shape of a single recorded entry;
 *   - per-session storage summaries surfaced in Settings;
 *   - the message unions carried between the RawMode webview and the
 *     extension host, and between the Settings webview and the host
 *     for the RawMode statistics block.
 *
 * All content is stored and transported verbatim. Payload is `unknown` on
 * purpose: no schema, no redaction, no transformation. Anything is fair game.
 */

/**
 * Discriminator for a recorded entry.
 *
 * Kept intentionally open (`string`) so that any event exposed by the Pi
 * SDK — including ones added by future SDK releases — can be captured
 * verbatim without touching this type. See {@link RAW_HARNESS_EVENT_KINDS}
 * for the concrete list the recorder subscribes to today. Legacy `stream_*`
 * entries remain readable, while `recorder_meta` is produced by the recorder.
 */
export type RawEntryKind = string;

/** All harness-level (`pi.on(...)`) event names captured by the recorder. */
export const RAW_HARNESS_EVENT_KINDS = [
    // Session lifecycle
    'session_start',
    'session_shutdown',
    'session_info_changed',
    'session_before_switch',
    'session_before_fork',
    'session_before_compact',
    'session_compact',
    'session_before_tree',
    'session_tree',
    // Provider I/O
    'context',
    'before_provider_request',
    'before_provider_headers',
    'after_provider_response',
    // Agent lifecycle
    'before_agent_start',
    'agent_start',
    'agent_end',
    'agent_settled',
    'turn_start',
    'turn_end',
    // Messages
    'message_start',
    'message_update',
    'message_end',
    // Tools
    'tool_execution_start',
    'tool_execution_update',
    'tool_execution_end',
    'tool_call',
    'tool_result',
    // Model / thinking / user input
    'model_select',
    'thinking_level_select',
    'user_bash',
    'input',
    // Compatibility observations
    'project_trust',
    'resources_discover',
] as const;

export type RawHarnessEventKind = typeof RAW_HARNESS_EVENT_KINDS[number];

/**
 * `AgentSession`-listener kinds that are known not to be surfaced by
 * ExtensionAPI. They are recorded via `EventRouter.onAll(...)` so nothing
 * is lost through the session channel.
 */
export const RAW_SESSION_ONLY_EVENT_KINDS = [
    'entry_appended',
    'queue_update',
    'compaction_start',
    'compaction_end',
    'auto_retry_start',
    'auto_retry_end',
    'thinking_level_changed',
] as const;

export type RawSessionOnlyEventKind = typeof RAW_SESSION_ONLY_EVENT_KINDS[number];

/**
 * Bookkeeping payload for `recorder_meta` entries. `session_bind` is emitted
 * once when a recorder that started before Pi assigned a session file
 * migrates its buffered entries to the concrete path. `recorder_error`
 * captures storage failures so the timeline shows a gap explicitly.
 */
export type RawRecorderMetaPayload =
    | { kind: 'recorder_start'; capturedAtMs: number }
    | { kind: 'session_bind'; previousSessionPath?: string; boundSessionPath: string }
    | { kind: 'recorder_error'; message: string; where: string };

/**
 * Single recorded entry. `seq` is strictly monotonically increasing within
 * a single recorder instance and is preserved on disk across
 * activations — the Node storage adapter continues numbering from the last
 * value observed in the JSONL file.
 */
export interface RawEntry {
    seq: number;
    timestampMs: number;
    sessionPath: string;
    kind: RawEntryKind;
    payload: unknown;
}

export interface RawSessionSummary {
    sessionPath: string;
    /**
     * Best-effort human-readable label. Resolved from the current chat's
     * session name when the raw file is bound to an open session; falls
     * back to the session-file basename otherwise.
     */
    displayTitle?: string;
    entryCount: number;
    sizeBytes: number;
    firstEntryAtMs?: number;
    lastEntryAtMs?: number;
    /**
     * True when the underlying Pi session file no longer exists on disk.
     * The raw JSONL is preserved (nothing is auto-deleted) but the user
     * should be nudged to clear it explicitly.
     */
    orphaned: boolean;
}

export interface RawStorageStats {
    sessions: RawSessionSummary[];
    totalEntries: number;
    totalSizeBytes: number;
    /** Absolute filesystem path of the raw storage directory. */
    storageDir: string;
}

// ── Raw panel webview ⇄ extension host ──

export type RawClientMessage =
    | { type: 'raw.subscribe'; sessionPath: string }
    | { type: 'raw.unsubscribe'; sessionPath: string }
    | { type: 'raw.loadRange'; sessionPath: string; fromSeq: number; count: number }
    | { type: 'raw.requestCopy'; sessionPath: string }
    | { type: 'raw.requestSaveAs'; sessionPath: string }
    | { type: 'raw.revealStorage' };

export type RawServerMessage =
    | {
        type: 'raw.snapshot';
        sessionPath: string;
        entries: RawEntry[];
        hasMore: boolean;
        nextSeq: number;
    }
    | { type: 'raw.append'; sessionPath: string; entry: RawEntry }
    | {
        type: 'raw.range';
        sessionPath: string;
        entries: RawEntry[];
        hasMore: boolean;
        nextSeq: number;
    }
    | {
        type: 'raw.sessionInfo';
        sessionPath: string;
        displayTitle?: string;
        orphaned: boolean;
    }
    | { type: 'raw.copyDone'; sessionPath: string; ok: boolean; message?: string }
    | { type: 'raw.saveAsDone'; sessionPath: string; ok: boolean; savedTo?: string; message?: string };

// ── Settings-panel RawMode block ⇄ extension host ──
//
// These live alongside the existing SettingsClientMessage / SettingsServerMessage
// unions in `protocol.ts` and are fetched on demand when the RawMode section
// mounts. Statistics are not eagerly attached to `SettingsData` so the raw
// storage stays uncoupled from the general settings payload.

export type RawModeSettingsClientMessage =
    | { type: 'rawMode.getStats' }
    | { type: 'rawMode.clearAll' }
    | { type: 'rawMode.clearSession'; sessionPath: string }
    | { type: 'rawMode.revealStorage' }
    | { type: 'rawMode.openView'; sessionPath: string };

export type RawModeSettingsServerMessage =
    | { type: 'rawMode.stats'; stats: RawStorageStats }
    | { type: 'rawMode.error'; message: string };
