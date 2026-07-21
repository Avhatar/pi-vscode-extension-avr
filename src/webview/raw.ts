import type {
    RawClientMessage,
    RawServerMessage,
    RawEntry,
    RawEntryKind,
} from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: RawClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

const appEl = document.getElementById('app') as HTMLDivElement | null;
const initialSessionPath = appEl?.dataset.sessionPath ?? '';

// Persisted webview state — sessionPath must survive Reload Window so the
// panel serializer can restore this panel to the same session.
const persistedState = vscode.getState() as { sessionPath?: string } | undefined;
const sessionPath = persistedState?.sessionPath || initialSessionPath;
vscode.setState({ sessionPath });

type ViewMode = 'timeline' | 'firehose';

interface UiState {
    entries: RawEntry[];
    firstSeqLoaded: number | undefined;
    lastSeqReceived: number | undefined;
    hasOlder: boolean;
    hasMoreOlder: boolean;
    mode: ViewMode;
    followTail: boolean;
    displayTitle?: string;
    orphaned: boolean;
    expandedEntries: Set<number>;
    collapsedTurns: Set<number>;
    lastCopyStatus?: string;
    lastSaveStatus?: string;
}

const state: UiState = {
    entries: [],
    firstSeqLoaded: undefined,
    lastSeqReceived: undefined,
    hasOlder: false,
    hasMoreOlder: false,
    mode: 'timeline',
    followTail: true,
    orphaned: false,
    expandedEntries: new Set(),
    collapsedTurns: new Set(),
};

window.addEventListener('message', (event) => {
    const msg = event.data as RawServerMessage;
    if (!msg || typeof (msg as any).type !== 'string') return;
    handleServerMessage(msg);
});

document.addEventListener('DOMContentLoaded', () => {
    render();
    vscode.postMessage({ type: 'raw.subscribe', sessionPath });
});

function handleServerMessage(msg: RawServerMessage) {
    switch (msg.type) {
        case 'raw.snapshot': {
            // Snapshot is authoritative for the entry list.
            state.entries = msg.entries.slice();
            state.firstSeqLoaded = msg.entries[0]?.seq;
            state.lastSeqReceived = msg.entries.at(-1)?.seq;
            // `hasMore` from readRange means "more entries exist after nextSeq"
            // — but we asked for range starting at 0. So hasMore=true means
            // there are additional NEWER entries not in this page. Older
            // entries are only ones with seq < firstSeqLoaded (impossible when
            // fromSeq=0 unless the first entry's seq > 0, which happens after
            // history migrations).
            state.hasMoreOlder = (state.firstSeqLoaded ?? 0) > 0;
            state.hasOlder = state.hasMoreOlder;
            render();
            break;
        }
        case 'raw.range': {
            // Pagination page — prepend when the range starts before the
            // currently-loaded head, append otherwise.
            if (msg.entries.length === 0) {
                state.hasMoreOlder = msg.hasMore;
                render();
                return;
            }
            const firstIncoming = msg.entries[0]!.seq;
            const lastIncoming = msg.entries.at(-1)!.seq;
            if (state.firstSeqLoaded === undefined || firstIncoming < state.firstSeqLoaded) {
                state.entries = [...msg.entries, ...state.entries];
                state.firstSeqLoaded = firstIncoming;
                state.hasMoreOlder = firstIncoming > 0;
                state.hasOlder = state.hasMoreOlder;
            } else {
                state.entries.push(...msg.entries);
                state.lastSeqReceived = lastIncoming;
            }
            render();
            break;
        }
        case 'raw.append': {
            const entry = msg.entry;
            if (state.lastSeqReceived !== undefined && entry.seq <= state.lastSeqReceived) return;
            state.entries.push(entry);
            state.lastSeqReceived = entry.seq;
            render(entry);
            break;
        }
        case 'raw.sessionInfo': {
            state.displayTitle = msg.displayTitle;
            state.orphaned = msg.orphaned;
            renderHeader();
            break;
        }
        case 'raw.copyDone': {
            state.lastCopyStatus = msg.ok
                ? 'Copied to clipboard.'
                : `Copy failed: ${msg.message ?? 'unknown reason'}`;
            renderStatus();
            break;
        }
        case 'raw.saveAsDone': {
            if (msg.ok) {
                state.lastSaveStatus = `Saved to ${msg.savedTo}`;
            } else if (msg.message === 'cancelled') {
                state.lastSaveStatus = 'Save cancelled.';
            } else {
                state.lastSaveStatus = `Save failed: ${msg.message ?? 'unknown reason'}`;
            }
            renderStatus();
            break;
        }
    }
}

// ── DOM helpers ──

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// ── Rendering ──

function render(newlyAppended?: RawEntry): void {
    if (!appEl) return;
    if (!appEl.dataset.mounted) {
        appEl.innerHTML = '';
        appEl.appendChild(buildLayout());
        appEl.dataset.mounted = '1';
    }
    renderHeader();
    renderContent();
    renderStatus();
    if (newlyAppended && state.followTail) {
        // Defer scroll to next frame so newly-added nodes are laid out.
        requestAnimationFrame(() => {
            const contentEl = appEl.querySelector('.raw-content');
            if (contentEl) (contentEl as HTMLElement).scrollTop = (contentEl as HTMLElement).scrollHeight;
        });
    }
}

function buildLayout(): HTMLElement {
    const shell = el('div', 'raw-shell');
    shell.appendChild(el('div', 'raw-header'));
    const content = el('div', 'raw-content');
    content.addEventListener('scroll', () => {
        const isAtBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 4;
        if (!isAtBottom && state.followTail) {
            state.followTail = false;
            renderHeader();
        } else if (isAtBottom && !state.followTail) {
            state.followTail = true;
            renderHeader();
        }
    });
    shell.appendChild(content);
    shell.appendChild(el('div', 'raw-status'));
    return shell;
}

function renderHeader(): void {
    const container = appEl?.querySelector('.raw-header') as HTMLElement | null;
    if (!container) return;
    container.innerHTML = '';

    const title = el('div', 'raw-title');
    title.append(el('span', 'raw-badge', 'RAW'));
    title.append(el('span', 'raw-title-text', state.displayTitle ?? sessionPath));
    if (state.orphaned) title.append(el('span', 'raw-orphan-badge', '(orphan)'));
    container.appendChild(title);

    const counters = el('div', 'raw-counters');
    counters.append(el('span', 'raw-counter', `${state.entries.length} entries`));
    counters.append(el('span', 'raw-counter-sep', '·'));
    const turnCount = state.entries.filter(e => e.kind === 'turn_start').length;
    counters.append(el('span', 'raw-counter', `${turnCount} turns`));
    if (state.lastSeqReceived !== undefined) {
        counters.append(el('span', 'raw-counter-sep', '·'));
        counters.append(el('span', 'raw-counter-muted', `seq ${state.firstSeqLoaded ?? 0}–${state.lastSeqReceived}`));
    }
    container.appendChild(counters);

    const controls = el('div', 'raw-controls');
    const modeToggle = el('div', 'raw-mode-toggle');
    for (const mode of ['timeline', 'firehose'] as const) {
        const btn = el('button', mode === state.mode ? 'raw-mode-btn active' : 'raw-mode-btn', mode);
        btn.addEventListener('click', () => {
            state.mode = mode;
            renderHeader();
            renderContent();
        });
        modeToggle.append(btn);
    }
    controls.append(modeToggle);

    const followBtn = el('button', state.followTail ? 'raw-btn active' : 'raw-btn', 'Follow tail');
    followBtn.title = 'When enabled, the view auto-scrolls to the newest entry as it arrives.';
    followBtn.addEventListener('click', () => {
        state.followTail = !state.followTail;
        renderHeader();
        if (state.followTail) {
            const contentEl = appEl?.querySelector('.raw-content') as HTMLElement | null;
            if (contentEl) contentEl.scrollTop = contentEl.scrollHeight;
        }
    });
    controls.append(followBtn);

    const copyBtn = el('button', 'raw-btn', 'Copy JSONL');
    copyBtn.addEventListener('click', () => {
        state.lastCopyStatus = 'Copying…';
        renderStatus();
        vscode.postMessage({ type: 'raw.requestCopy', sessionPath });
    });
    controls.append(copyBtn);

    const saveBtn = el('button', 'raw-btn', 'Save As…');
    saveBtn.addEventListener('click', () => {
        state.lastSaveStatus = 'Preparing…';
        renderStatus();
        vscode.postMessage({ type: 'raw.requestSaveAs', sessionPath });
    });
    controls.append(saveBtn);

    const revealBtn = el('button', 'raw-btn', 'Reveal folder');
    revealBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'raw.revealStorage' });
    });
    controls.append(revealBtn);

    container.appendChild(controls);
}

function renderStatus(): void {
    const container = appEl?.querySelector('.raw-status') as HTMLElement | null;
    if (!container) return;
    container.innerHTML = '';
    const parts: string[] = [];
    if (state.lastCopyStatus) parts.push(state.lastCopyStatus);
    if (state.lastSaveStatus) parts.push(state.lastSaveStatus);
    if (state.orphaned) parts.push('Underlying session file no longer exists.');
    if (parts.length === 0) {
        container.append(el('span', 'raw-status-muted', 'RawMode records everything the agent exchanges with the model. Nothing is redacted.'));
        return;
    }
    for (const part of parts) container.append(el('span', 'raw-status-line', part));
}

function renderContent(): void {
    const container = appEl?.querySelector('.raw-content') as HTMLElement | null;
    if (!container) return;
    const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    container.innerHTML = '';

    if (state.hasMoreOlder) {
        const loadOlder = el('button', 'raw-load-older', `Load older entries (seq < ${state.firstSeqLoaded})`);
        loadOlder.addEventListener('click', () => {
            const fromSeq = Math.max(0, (state.firstSeqLoaded ?? 0) - 500);
            const count = (state.firstSeqLoaded ?? 0) - fromSeq;
            vscode.postMessage({ type: 'raw.loadRange', sessionPath, fromSeq, count: Math.max(1, count) });
        });
        container.appendChild(loadOlder);
    }

    if (state.entries.length === 0) {
        container.append(el('div', 'raw-empty', 'No entries recorded yet. Send a prompt to see the raw stream populate here.'));
        return;
    }

    if (state.mode === 'firehose') {
        renderFirehose(container);
    } else {
        renderTimeline(container);
    }

    if (wasAtBottom || state.followTail) {
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
}

function renderFirehose(container: HTMLElement): void {
    for (const entry of state.entries) {
        container.appendChild(buildEntryRow(entry, false));
    }
}

function renderTimeline(container: HTMLElement): void {
    // Group entries into turns by turn_start / turn_end boundaries.
    // Anything outside a turn (session setup, provider events before the
    // first turn, meta events at the tail) forms an implicit "pre" and
    // "post" group so nothing is hidden.
    interface TurnGroup {
        turnIndex: number | null;
        entries: RawEntry[];
    }
    const groups: TurnGroup[] = [];
    let currentTurn: TurnGroup | null = null;
    let openTurnCounter = 0;
    for (const entry of state.entries) {
        if (entry.kind === 'turn_start') {
            openTurnCounter += 1;
            currentTurn = { turnIndex: openTurnCounter, entries: [entry] };
            groups.push(currentTurn);
            continue;
        }
        if (entry.kind === 'turn_end') {
            if (currentTurn) {
                currentTurn.entries.push(entry);
                currentTurn = null;
            } else {
                (groups.at(-1) ?? pushImplicitGroup(groups)).entries.push(entry);
            }
            continue;
        }
        if (currentTurn) {
            currentTurn.entries.push(entry);
        } else {
            const tail = groups.at(-1);
            if (tail && tail.turnIndex === null) {
                tail.entries.push(entry);
            } else {
                groups.push({ turnIndex: null, entries: [entry] });
            }
        }
    }

    for (const group of groups) {
        container.appendChild(buildTurnGroup(group.turnIndex, group.entries));
    }
}

function pushImplicitGroup(groups: Array<{ turnIndex: number | null; entries: RawEntry[] }>): { turnIndex: number | null; entries: RawEntry[] } {
    const g = { turnIndex: null, entries: [] as RawEntry[] };
    groups.push(g);
    return g;
}

function buildTurnGroup(turnIndex: number | null, entries: RawEntry[]): HTMLElement {
    const group = el('div', 'raw-turn');
    const key = turnIndex ?? -1 - entries[0]!.seq;
    const isCollapsed = state.collapsedTurns.has(key);

    const header = el('div', 'raw-turn-header');
    const chevron = el('span', 'raw-turn-chevron', isCollapsed ? '▶' : '▼');
    const label = turnIndex === null
        ? `Session events (${entries.length})`
        : `Turn ${turnIndex} — ${entries.length} events`;
    header.append(chevron);
    header.append(el('span', 'raw-turn-label', label));
    header.append(buildTurnMeta(entries));
    header.addEventListener('click', () => {
        if (state.collapsedTurns.has(key)) state.collapsedTurns.delete(key);
        else state.collapsedTurns.add(key);
        renderContent();
    });
    group.append(header);

    if (!isCollapsed) {
        const body = el('div', 'raw-turn-body');
        for (const entry of entries) {
            body.append(buildEntryRow(entry, true));
        }
        group.append(body);
    }
    return group;
}

function buildTurnMeta(entries: RawEntry[]): HTMLElement {
    const meta = el('div', 'raw-turn-meta');
    const firstMs = entries[0]!.timestampMs;
    const lastMs = entries.at(-1)!.timestampMs;
    const durationMs = Math.max(0, lastMs - firstMs);
    meta.append(el('span', 'raw-meta-chip', `${durationMs}ms`));
    const retries = entries.filter(e => e.kind === 'auto_retry_start').length;
    if (retries > 0) meta.append(el('span', 'raw-meta-chip retry', `${retries} retry`));
    const compactions = entries.filter(e => e.kind === 'compaction_start').length;
    if (compactions > 0) meta.append(el('span', 'raw-meta-chip compact', 'compaction'));
    const providerCalls = entries.filter(e => e.kind === 'before_provider_payload').length;
    if (providerCalls > 0) meta.append(el('span', 'raw-meta-chip provider', `${providerCalls} provider call${providerCalls === 1 ? '' : 's'}`));
    return meta;
}

function buildEntryRow(entry: RawEntry, indented: boolean): HTMLElement {
    const row = el('div', indented ? 'raw-entry indented' : 'raw-entry');
    const isExpanded = state.expandedEntries.has(entry.seq);
    row.dataset.seq = String(entry.seq);
    row.dataset.kind = entry.kind;

    const summaryLine = el('div', 'raw-entry-summary');
    summaryLine.append(el('span', `raw-kind kind-${entry.kind}`, entry.kind));
    summaryLine.append(el('span', 'raw-seq', `#${entry.seq}`));
    summaryLine.append(el('span', 'raw-time', formatTime(entry.timestampMs)));
    summaryLine.append(el('span', 'raw-preview', previewPayload(entry.kind, entry.payload)));
    summaryLine.addEventListener('click', () => {
        if (state.expandedEntries.has(entry.seq)) state.expandedEntries.delete(entry.seq);
        else state.expandedEntries.add(entry.seq);
        renderContent();
    });
    row.append(summaryLine);

    if (isExpanded) {
        const pre = el('pre', 'raw-entry-json');
        pre.textContent = safeStringify(entry.payload);
        row.append(pre);
    }
    return row;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return `<unserializable: ${error instanceof Error ? error.message : String(error)}>`;
    }
}

function previewPayload(kind: RawEntryKind, payload: unknown): string {
    if (payload === null || payload === undefined) return '';
    if (typeof payload === 'string') return truncateOneLine(payload, 160);
    if (typeof payload !== 'object') return String(payload);
    const obj = payload as Record<string, unknown>;
    // Kind-specific summaries so the collapsed line carries useful signal.
    switch (kind) {
        case 'before_provider_payload': {
            const messages = Array.isArray(obj.messages) ? obj.messages.length : undefined;
            const tools = Array.isArray(obj.tools) ? obj.tools.length : undefined;
            const model = typeof obj.model === 'string' ? obj.model : undefined;
            const parts: string[] = [];
            if (model) parts.push(`model=${model}`);
            if (messages !== undefined) parts.push(`messages=${messages}`);
            if (tools !== undefined) parts.push(`tools=${tools}`);
            return parts.join(' · ');
        }
        case 'after_provider_response': {
            const status = obj.status;
            const headers = obj.headers as Record<string, string> | undefined;
            const usage = headers?.['x-usage'] ?? headers?.['anthropic-usage'];
            const parts: string[] = [];
            if (status !== undefined) parts.push(`status=${status}`);
            if (usage) parts.push(`usage=${usage}`);
            return parts.join(' · ');
        }
        case 'context': {
            const messages = Array.isArray(obj.messages) ? obj.messages.length : undefined;
            return messages !== undefined ? `messages=${messages}` : '';
        }
        case 'tool_call':
        case 'tool_result': {
            const name = obj.toolName;
            const id = obj.toolCallId;
            return `${name ?? '?'} · ${id ?? '?'}`;
        }
        case 'stream_chunk': {
            return truncateOneLine(safeStringify(payload).replace(/\s+/g, ' '), 160);
        }
        case 'turn_start': {
            const idx = obj.turnIndex;
            return idx !== undefined ? `turnIndex=${idx}` : '';
        }
        case 'recorder_meta': {
            const inner = obj as { kind?: string; message?: string };
            return inner.kind ?? '';
        }
    }
    return truncateOneLine(safeStringify(payload).replace(/\s+/g, ' '), 160);
}

function truncateOneLine(s: string, max: number): string {
    const single = s.replace(/\n/g, '↵ ');
    return single.length > max ? single.slice(0, max - 1) + '…' : single;
}

function formatTime(ms: number): string {
    try {
        const d = new Date(ms);
        return d.toISOString().replace('T', ' ').replace('Z', '');
    } catch {
        return String(ms);
    }
}
