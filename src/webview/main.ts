import { marked } from 'marked';
import type { ClientMessage, ServerMessage, SerializedAgentState, FileChangeInfo, TabInfo, ToolCallPendingInfo, SkillInfo, CodexUsageSnapshot, ImageAttachment, FileAttachment, WorkspaceFileSuggestion } from '../shared/protocol';
import { getCacheCapability } from '../shared/cache-info';

declare function acquireVsCodeApi(): {
    postMessage(message: ClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();
const appEl = document.getElementById('app');
const iconsBaseUri = appEl?.dataset.iconsUri ?? '';
/**
 * 'sidebar' = the chat is shown inside the activity-bar webview-view.
 * 'panel'   = the chat is shown in a stand-alone editor tab (a `WebviewPanel`).
 *
 * Panels are bound to one specific chat tab and need to call
 * `vscode.setState({ tabId, sessionPath })` so VS Code's
 * `WebviewPanelSerializer` can restore them after a window reload.
 */
const viewMode: 'sidebar' | 'panel' =
    (appEl?.dataset.mode === 'panel') ? 'panel' : 'sidebar';
/** When in panel mode, the tab id baked into the HTML at panel creation time. */
const panelTabId: string | undefined = appEl?.dataset.tabId || undefined;

// ── State ──

// Per-tab draft text and attachments (unsent input preserved across tab switches)
const draftTexts = new Map<string, string>();
const draftImages = new Map<string, ImageAttachment[]>();
const draftFiles = new Map<string, FileAttachment[]>();
let currentImageAttachments: ImageAttachment[] = [];
let currentFileAttachments: FileAttachment[] = [];

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_IMAGE_DIMENSION = 2000;
const JPEG_RESIZE_QUALITY = 0.88;

const SUPPORTED_TEXT_MIME_TYPES = new Set([
    'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/xml', 'text/markdown',
    'text/csv', 'text/yaml', 'application/json', 'application/xml', 'application/javascript',
    'application/typescript', 'application/x-yaml', 'application/x-sh',
]);
const SUPPORTED_TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.xml', '.html', '.htm', '.css', '.js', '.jsx',
    '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
    '.cs', '.swift', '.kt', '.kts', '.scala', '.sh', '.bash', '.zsh', '.fish',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.csv', '.log',
    '.sql', '.r', '.m', '.mm', '.pl', '.pm', '.php', '.vue', '.svelte', '.astro',
    '.graphql', '.gql', '.proto', '.tf', '.tfvars', '.dockerfile', '.makefile',
    '.cmake', '.gradle', '.properties', '.editorconfig', '.gitignore',
]);
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB max for text files
const MAX_FILE_ATTACHMENTS = 5;
const diffStripeAlignmentObservers = new WeakMap<HTMLElement, ResizeObserver>();

type SlashMenuItem = {
    kind: 'builtin' | 'skill';
    name: string;
    displayName: string;
    description: string;
    insertText: string;
};

const BUILTIN_SLASH_COMMANDS: SlashMenuItem[] = [
    {
        kind: 'builtin',
        name: 'compact',
        displayName: '/compact',
        description: 'Summarize older conversation context while keeping recent work available.',
        insertText: '/compact ',
    },
];

const state: {
    messages: any[];
    isStreaming: boolean;
    isCompacting: boolean;
    model?: { provider: string; id: string; name?: string; supportsImages?: boolean };
    thinkingLevel?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null; estimated?: boolean };
    fileChanges: FileChangeInfo[];
    rollbackPoint: number | null;
    availableModels: any[];
    modelsLoaded: boolean;
    recentModels: { provider: string; id: string; name?: string; supportsImages?: boolean }[];
    favoriteModels: Set<string>;
    tabs: TabInfo[];
    activeTabId: string;
    skills: SkillInfo[];
    queuedMessages: string[];
    codexUsage: CodexUsageSnapshot | null;
    cacheMode: 'short' | 'long' | 'auto';
    cacheEffective: 'short' | 'long';
} = {
    messages: [],
    isStreaming: false,
    isCompacting: false,
    tools: [],
    streamingText: '',
    streamingThinking: '',
    isThinking: false,
    thinkingStartTime: 0,
    streamingThinkingDuration: 0,
    availableModels: [],
    modelsLoaded: false,
    recentModels: [],
    favoriteModels: new Set(),
    fileChanges: [],
    rollbackPoint: null,
    tabs: [],
    activeTabId: '',
    skills: [],
    queuedMessages: [],
    codexUsage: null,
    cacheMode: 'auto',
    cacheEffective: 'short',
};

// ── Marked config ──

const renderer = new marked.Renderer();

let codeBlockId = 0;
renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const langLabel = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
    return `<div class="code-block-wrapper">
        <div class="code-block-header">${langLabel}<button class="copy-btn" data-code-id="${id}">Copy</button></div>
        <pre class="code-block-pre" id="${id}"><code class="code-block-code">${escHtml(text)}</code></pre>
    </div>`;
};

renderer.codespan = function ({ text }: { text: string }) {
    return `<code>${text}</code>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

function renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

// ── Message handling ──

window.addEventListener('message', (event) => {
    handleMessage(event.data as ServerMessage);
});

function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
        case 'ready':
            vscode.postMessage({ type: 'getState' });
            vscode.postMessage({ type: 'getModels' });
            vscode.postMessage({ type: 'getSkills' });
            break;
        case 'stateSync':
            applyStateSync(msg.state);
            break;
        case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        case 'models':
            state.availableModels = msg.models ?? [];
            state.modelsLoaded = true;
            state.favoriteModels = new Set(msg.favorites ?? []);
            if (msg.current) {
                state.model = msg.current;
                addToRecentModels(msg.current.provider, msg.current.id, msg.current.name, msg.current.supportsImages);
            }
            if (msg.thinkingLevel) state.thinkingLevel = msg.thinkingLevel;
            updateFooterModel();
            if (state.messages.length === 0 && !state.isStreaming) {
                updateMessages();
            }
            if (pendingModelPicker) {
                pendingModelPicker = false;
                showModelPicker();
            }
            break;
        case 'sessions':
            renderSessionList(msg.sessions, msg.currentSessionId);
            break;
        case 'fileChange':
            state.fileChanges.push(msg.change);
            renderChangedFilesBar();
            renderInlineFileChange(msg.change);
            break;
        case 'confirmResult':
            handleConfirmResult(msg.action, msg.confirmed, msg.payload);
            break;
        case 'toolCallPending':
            renderToolApprovalCard(msg.pending);
            break;
        case 'toolCallResolved':
            removeToolApprovalCard(msg.toolCallId);
            break;
        case 'skills':
            state.skills = msg.skills;
            break;
        case 'workspaceFileSuggestions':
            handleWorkspaceFileSuggestions(msg.requestId, msg.query, msg.items, !!msg.isIndexing);
            break;
        case 'codexUsage':
            state.codexUsage = msg.usage ?? null;
            updateInputArea();
            break;
        case 'error':
            state.messages.push({
                role: 'error',
                content: msg.message,
                timestamp: Date.now(),
            });
            updateMessages();
            scrollToBottom();
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
        case 'restoreCheckpoint':
            if (payload?.messageIndex !== undefined) {
                vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: payload.messageIndex });
            }
            break;
        case 'redoCheckpoint':
            vscode.postMessage({ type: 'redoCheckpoint' });
            break;
    }
}

function applyStateSync(s: SerializedAgentState): void {
    const prevTab = state.activeTabId;
    const incomingTabId = s.activeTabId ?? '';

    // Save draft for the outgoing tab before we switch
    if (prevTab && prevTab !== incomingTabId && skeletonBuilt) {
        const inputEl = document.getElementById('input') as HTMLTextAreaElement | null;
        if (inputEl) {
            draftTexts.set(prevTab, inputEl.value);
        }
        draftImages.set(prevTab, [...currentImageAttachments]);
        draftFiles.set(prevTab, [...currentFileAttachments]);
    }

    // Preserve locally-pushed error banners across server-driven state syncs.
    // The server replaces state.messages with the SDK's transcript, which does
    // not include role:'error' entries; without this re-append, error banners
    // posted by the controller (e.g. provider failures, empty responses) would
    // render for one frame and then be wiped by the agent_end stateSync.
    const localErrors = state.messages.filter((m: any) => m?.role === 'error');
    state.messages = [...(s.messages ?? []), ...localErrors];
    state.isStreaming = s.isStreaming;
    state.isCompacting = s.isCompacting ?? false;
    state.model = s.model;
    state.thinkingLevel = s.thinkingLevel;
    state.tools = s.tools ?? [];
    state.sessionId = s.sessionId;
    state.sessionName = s.sessionName;
    state.contextUsage = s.contextUsage;
    state.fileChanges = s.fileChanges ?? [];
    state.rollbackPoint = s.rollbackPoint ?? null;
    state.tabs = s.tabs ?? [];
    state.activeTabId = s.activeTabId ?? '';
    state.streamingText = s.streamingText ?? '';
    state.streamingThinking = s.streamingThinking ?? '';
    state.isThinking = s.isThinking ?? false;
    state.thinkingStartTime = s.thinkingStartTime ?? 0;
    state.streamingThinkingDuration = s.streamingThinkingDuration ?? 0;
    state.queuedMessages = s.queuedMessages ?? [];
    if (s.cacheMode === 'short' || s.cacheMode === 'long' || s.cacheMode === 'auto') {
        state.cacheMode = s.cacheMode;
    }
    if (s.cacheEffective === 'short' || s.cacheEffective === 'long') {
        state.cacheEffective = s.cacheEffective;
    }
    const tabSwitched = prevTab !== state.activeTabId;

    // In panel mode, persist a tiny pointer (tabId + sessionPath) so VS Code
    // can re-attach this panel to the right session after a window reload.
    if (viewMode === 'panel' && s.sessionPath) {
        vscode.setState({ tabId: panelTabId, sessionPath: s.sessionPath });
    }

    // Purge drafts for tabs that no longer exist
    const liveTabIds = new Set(state.tabs.map((t: TabInfo) => t.id));
    for (const id of draftTexts.keys()) {
        if (!liveTabIds.has(id)) draftTexts.delete(id);
    }
    for (const id of draftImages.keys()) {
        if (!liveTabIds.has(id)) draftImages.delete(id);
    }
    for (const id of draftFiles.keys()) {
        if (!liveTabIds.has(id)) draftFiles.delete(id);
    }

    if (tabSwitched || !skeletonBuilt) {
        render();
        // Restore saved draft for the newly active tab
        currentImageAttachments = [...(draftImages.get(state.activeTabId) ?? [])];
        currentFileAttachments = [...(draftFiles.get(state.activeTabId) ?? [])];
        const inputEl = document.getElementById('input') as HTMLTextAreaElement | null;
        if (inputEl) {
            const draft = draftTexts.get(state.activeTabId) ?? '';
            if (draft) {
                inputEl.value = draft;
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
                updateInputHighlights(inputEl);
            }
        }
        renderAttachmentPreview();
        updateInputArea();
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    } else {
        updateTabs();
        updateStreamingUI();
        updateMessages();
        updateInputArea();
        updateChangedFiles();
        updateQueuedMessageBanner();
        if (state.isCompacting) {
            showPreparingPlaceholder('Compacting...');
        } else if (state.isStreaming) {
            ensurePreparingPlaceholder();
        } else {
            removePreparingPlaceholder();
        }
        updateScrollButton();
    }
}

function handleAgentEvent(event: any): void {
    switch (event.type) {
        case 'message_update':
            if (event.assistantMessageEvent) {
                handleStreamingDelta(event.assistantMessageEvent);
            }
            break;
        case 'agent_start':
            // Drop error banners from the previous turn so a successful retry
            // doesn't leave a stale provider-error message stuck to the chat.
            state.messages = state.messages.filter((m: any) => m?.role !== 'error');
            state.isStreaming = true;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            updateInputArea();
            updateStreamingUI();
            showPreparingPlaceholder();
            break;
        case 'agent_end':
            state.isStreaming = false;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            dismissSteerToast();
            updateStreamingUI();
            updateInputArea();
            break;
        case 'compaction_start':
            state.isCompacting = true;
            showPreparingPlaceholder('Compacting...');
            updateInputArea();
            break;
        case 'compaction_end':
            state.isCompacting = false;
            removePreparingPlaceholder();
            updateInputArea();
            break;
        case 'tool_execution_start':
            removePreparingPlaceholder();
            renderToolStart(event);
            break;
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            showPreparingPlaceholder();
            break;
    }
}

function handleStreamingDelta(ae: any): void {
    switch (ae.type) {
        case 'thinking_start':
            state.isThinking = true;
            state.streamingThinking = '';
            state.thinkingStartTime = Date.now();
            state.streamingThinkingDuration = 0;
            break;
        case 'thinking_delta':
            state.streamingThinking += ae.delta ?? '';
            dismissSteerToast();
            break;
        case 'thinking_end':
            state.isThinking = false;
            if (state.thinkingStartTime > 0) {
                state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
            }
            break;
        case 'text_start':
            break;
        case 'text_delta':
            state.streamingText += ae.delta ?? '';
            dismissSteerToast();
            break;
        case 'text_end':
            break;
    }
    renderStreamingContent();
}

// ── Rendering ──

let skeletonBuilt = false;

/**
 * Build the panel-mode toolbar with "New chat" and "History" buttons. The
 * sidebar variant uses VS Code's `view/title` menu instead, so this only
 * runs for editor panels.
 */
function buildPanelToolbar(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '4px';
    wrap.style.width = '100%';

    const newBtn = el('button', 'panel-toolbar-btn');
    newBtn.title = 'Start a new chat in a new editor tab';
    newBtn.innerHTML = `<img class="panel-toolbar-icon-img" src="${iconsBaseUri}/new.png" alt="new chat">`;
    newBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'createTab' });
    });
    wrap.appendChild(newBtn);

    const historyBtn = el('button', 'panel-toolbar-btn');
    historyBtn.title = 'Show previous sessions';
    historyBtn.innerHTML = `<img class="panel-toolbar-icon-img" src="${iconsBaseUri}/text.png" alt="history">`;
    historyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'getSessions' });
    });
    wrap.appendChild(historyBtn);

    const spacer = el('div', 'panel-toolbar-spacer');
    wrap.appendChild(spacer);

    return wrap;
}

function render(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';
    skeletonBuilt = false;

    // Header: in sidebar mode it holds the multi-tab strip; in panel mode it
    // becomes a toolbar with `New` and `History` buttons (so the user does not
    // have to jump back to the launcher for those).
    const header = el('div', 'header');
    if (viewMode === 'panel') {
        header.classList.add('panel-toolbar');
        header.appendChild(buildPanelToolbar());
    } else {
        const tabStrip = el('div', 'tab-strip');
        header.appendChild(tabStrip);
    }
    app.appendChild(header);

    // Messages container (persistent, children managed by updateMessages)
    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';
    const streamingContainer = el('div', 'streaming-message message-group-assistant');
    streamingContainer.id = 'streaming-message';
    messagesContainer.appendChild(streamingContainer);
    const spacer = el('div', 'messages-spacer');
    messagesContainer.appendChild(spacer);
    app.appendChild(messagesContainer);

    // Scroll-to-bottom button (static)
    const scrollWrap = el('div', 'scroll-btn-wrap');
    const scrollBtn = el('button', 'scroll-bottom-btn');
    scrollBtn.id = 'btn-scroll-bottom';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 13L3 8M8 13L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    scrollWrap.appendChild(scrollBtn);
    app.appendChild(scrollWrap);

    // Input container: changed-files slot + queued section + slash menu + input-area (persistent textarea) + footer
    const inputContainer = el('div', 'input-container');
    const queuedSection = document.createElement('details');
    queuedSection.className = 'queued-section';
    queuedSection.id = 'queued-section';
    queuedSection.style.display = 'none';
    inputContainer.appendChild(queuedSection);
    const slashMenu = el('div', 'slash-menu');
    slashMenu.id = 'slash-menu';
    slashMenu.style.display = 'none';
    inputContainer.appendChild(slashMenu);
    const fileMentionMenu = el('div', 'file-mention-menu');
    fileMentionMenu.id = 'file-mention-menu';
    fileMentionMenu.style.display = 'none';
    inputContainer.appendChild(fileMentionMenu);
    const area = el('div', 'input-area');
    area.innerHTML = `<div id="attachment-preview" class="attachment-preview" style="display: none;"></div><div class="input-text-wrap"><div id="input-highlight" class="input-highlight" aria-hidden="true"></div><textarea id="input" placeholder="Ask Pi anything..." rows="1"></textarea></div><input id="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.json,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.hpp,.cs,.swift,.kt,.kts,.scala,.sh,.bash,.zsh,.fish,.yaml,.yml,.toml,.ini,.cfg,.conf,.env,.csv,.log,.sql,.r,.m,.mm,.pl,.pm,.php,.vue,.svelte,.astro,.graphql,.gql,.proto,.tf,.tfvars,.dockerfile,.makefile,.cmake,.gradle,.properties,.gitignore" multiple hidden>`;
    inputContainer.appendChild(area);
    const footer = el('div', 'input-footer');
    inputContainer.appendChild(footer);
    app.appendChild(inputContainer);

    // Bind stable event listeners (these elements persist for the lifetime of the skeleton)
    bindStableEvents();
    bindScrollListener();
    scrollBtn.addEventListener('click', () => {
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    });

    skeletonBuilt = true;

    // Populate all dynamic sections
    updateTabs();
    updateMessages();
    updateInputArea();
    updateChangedFiles();
    scrollToBottom();
}

function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove all children before #streaming-message (the message nodes)
    while (container.firstChild && container.firstChild !== streamingEl) {
        container.removeChild(container.firstChild);
    }

    // Remove orphaned error banners from previous transient showError() calls
    // that live between #streaming-message and .messages-spacer.
    const orphanErrors = container.querySelectorAll('#streaming-message ~ .error-message');
    orphanErrors.forEach(el => el.remove());

    codeBlockId = 0;

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(buildWelcome(), streamingEl);
    } else {
        let userMsgCount = 0;
        const rollbackUserIdx = state.rollbackPoint;
        let dimming = false;
        let redoPlaced = false;

        const displayItems = getDisplayMessageItems();
        let lastUserMessageDisplayIndex = -1;
        for (let i = 0; i < displayItems.length; i++) {
            if ((displayItems[i].msg.role ?? 'unknown') === 'user') {
                lastUserMessageDisplayIndex = i;
            }
        }

        for (let displayIndex = 0; displayIndex < displayItems.length; displayIndex++) {
            const { msg, sourceIndex } = displayItems[displayIndex];
            const role = msg.role ?? 'unknown';

            if (role === 'user') {
                userMsgCount++;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }
            }

            const msgEl = renderMessage(
                msg,
                sourceIndex,
                role === 'user' ? userMsgCount : undefined,
                role === 'user' && displayIndex === lastUserMessageDisplayIndex,
            );
            if (dimming) {
                msgEl.classList.add('dimmed');
            }

            container.insertBefore(msgEl, streamingEl);

            if (role === 'user' && dimming && !redoPlaced && rollbackUserIdx !== null) {
                const redoWrap = el('div', 'redo-anchor');
                const redoBtn = el('button', 'redo-btn');
                redoBtn.title = 'Redo changes';
                redoBtn.textContent = 'Redo';
                redoWrap.appendChild(redoBtn);
                container.insertBefore(redoWrap, streamingEl);
                redoPlaced = true;
            }
        }
    }

    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindDiffPreviewToggles();
    bindToolClickable();
}

function getDisplayMessageItems(): Array<{ msg: any; sourceIndex: number }> {
    const compactions: Array<{ msg: any; sourceIndex: number; timestamp: number }> = [];
    const items: Array<{ msg: any; sourceIndex: number }> = [];

    for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i];
        if ((msg.role ?? 'unknown') === 'compactionSummary') {
            const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Number.MAX_SAFE_INTEGER;
            compactions.push({ msg, sourceIndex: i, timestamp });
        } else {
            items.push({ msg, sourceIndex: i });
        }
    }

    const latestCompactionTimestamp = compactions.reduce(
        (latest, item) => Math.max(latest, item.timestamp),
        -Infinity,
    );

    for (const compaction of compactions.sort((a, b) => a.timestamp - b.timestamp)) {
        const msg = {
            ...compaction.msg,
            _latestCompaction: compaction.timestamp === latestCompactionTimestamp,
        };
        let insertAt = items.length;
        for (let i = 0; i < items.length; i++) {
            const ts = items[i].msg?.timestamp;
            if (typeof ts === 'number' && ts > compaction.timestamp) {
                insertAt = i;
                break;
            }
        }
        items.splice(insertAt, 0, { msg, sourceIndex: compaction.sourceIndex });
    }

    return items;
}

function updateTabs(): void {
    const header = document.querySelector('.header') as HTMLElement | null;
    const tabStrip = document.querySelector('.tab-strip');
    if (!tabStrip) return;
    tabStrip.innerHTML = '';

    // Hide the entire header when only 1 tab — action buttons live in VS Code title bar.
    // (Panel mode has no `.tab-strip`, so we already returned above; in panel mode
    // the header instead hosts the New / History toolbar and stays visible.)
    if (header) {
        header.style.display = state.tabs.length <= 1 ? 'none' : '';
    }

    for (const tab of state.tabs) {
        const tabEl = el('div', `tab${tab.isActive ? ' tab-active' : ''}${tab.isStreaming ? ' tab-streaming' : ''}`);
        tabEl.dataset.tabId = tab.id;

        const icon = el('span', 'tab-icon');
        if (tab.isStreaming) {
            icon.innerHTML = '<span class="tab-spinner"></span>';
        } else if (tab.hasNotification) {
            icon.innerHTML = `<img class="tab-icon-img" src="${iconsBaseUri}/notification.png" alt="notification">`;
        } else {
            icon.innerHTML = `<img class="tab-icon-img" src="${iconsBaseUri}/chat.png" alt="chat">`;
        }

        const name = el('span', 'tab-name');
        const displayName = tab.name.length > 20
            ? tab.name.substring(0, 18) + '...'
            : tab.name;
        name.textContent = displayName;
        name.title = tab.name;

        tabEl.appendChild(icon);
        tabEl.appendChild(name);

        if (state.tabs.length > 1) {
            const closeBtn = el('button', 'tab-close');
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close tab';
            closeBtn.dataset.tabId = tab.id;
            tabEl.appendChild(closeBtn);
        }

        tabStrip.appendChild(tabEl);
    }

    bindTabEvents();
}

function renderCodexUsage(): string {
    const provider = state.model?.provider;
    if (provider !== 'openai-codex') return '';
    const snap = state.codexUsage;
    if (!snap) return `<span class="footer-codex footer-codex--pending" title="Subscription usage will appear after the first response">Codex &middot; &hellip;</span>`;

    const nowSec = Date.now() / 1000;
    const primaryPct = snap.primary
        ? (nowSec >= snap.primary.resetAt ? 0 : snap.primary.percentUsed)
        : null;
    const secondaryPct = snap.secondary
        ? (nowSec >= snap.secondary.resetAt ? 0 : snap.secondary.percentUsed)
        : null;

    const segments: string[] = [];
    const planLabel = snap.planType ? snap.planType.charAt(0).toUpperCase() + snap.planType.slice(1) : 'Codex';
    segments.push(`<span class="footer-codex-plan">${escHtml(planLabel)}</span>`);
    if (primaryPct !== null && snap.primary) {
        const label = formatCodexWindow(snap.primary.windowMinutes);
        const sev = severityClass(primaryPct);
        segments.push(`<span class="footer-codex-segment ${sev}">${escHtml(label)} ${primaryPct.toFixed(1)}%</span>`);
    }
    if (secondaryPct !== null && snap.secondary) {
        const label = formatCodexWindow(snap.secondary.windowMinutes);
        const sev = severityClass(secondaryPct);
        segments.push(`<span class="footer-codex-segment ${sev}">${escHtml(label)} ${secondaryPct.toFixed(1)}%</span>`);
    }

    const tooltipLines: string[] = [];
    tooltipLines.push(`Plan: ${snap.planType}${snap.activeLimit ? ` (${snap.activeLimit})` : ''}`);
    if (snap.primary) {
        tooltipLines.push(
            `${formatCodexWindow(snap.primary.windowMinutes)} window: ${(primaryPct ?? 0).toFixed(1)}% used, resets ${formatResetTime(snap.primary.resetAt)}`,
        );
    }
    if (snap.secondary) {
        tooltipLines.push(
            `${formatCodexWindow(snap.secondary.windowMinutes)} window: ${(secondaryPct ?? 0).toFixed(1)}% used, resets ${formatResetTime(snap.secondary.resetAt)}`,
        );
    }
    if (snap.credits) {
        if (snap.credits.unlimited) {
            tooltipLines.push('Credits: unlimited');
        } else if (snap.credits.balance) {
            tooltipLines.push(`Credits balance: ${snap.credits.balance}`);
        } else if (snap.credits.hasCredits) {
            tooltipLines.push('Credits: available');
        }
    }
    const ageSec = Math.max(0, Math.round((Date.now() - snap.capturedAt) / 1000));
    tooltipLines.push(`Last update: ${formatAge(ageSec)} ago`);

    const title = tooltipLines.join('\n');
    return `<span class="footer-codex" title="${escHtml(title)}">${segments.join(' &middot; ')}</span>`;
}

function severityClass(percent: number): string {
    if (percent >= 90) return 'footer-codex-segment--high';
    if (percent >= 50) return 'footer-codex-segment--mid';
    return 'footer-codex-segment--low';
}

function formatCodexWindow(minutes: number): string {
    if (minutes >= 1440 && minutes % 1440 === 0) {
        const days = minutes / 1440;
        return days === 7 ? 'week' : `${days}d`;
    }
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
}

function formatResetTime(unixSec: number): string {
    const diffMs = unixSec * 1000 - Date.now();
    if (diffMs <= 0) return 'now';
    const totalMin = Math.round(diffMs / 60000);
    if (totalMin < 60) return `in ${totalMin} min`;
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    if (hours < 24) return mins ? `in ${hours}h ${mins}m` : `in ${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

function formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
}

function updateInputArea(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.placeholder = state.isCompacting
            ? 'Compacting context...'
            : state.isStreaming
                ? 'Type; Enter queues, Ctrl+Enter steers, Esc stops...'
                : 'Ask Pi anything...';
    }

    const footer = document.querySelector('.input-footer');
    if (!footer) return;

    const modelName = state.model?.name ?? state.model?.id ?? '';

    let contextHtml = '';
    if (state.contextUsage) {
        const cu = state.contextUsage;
        const tokensK = cu.tokens != null ? formatTokenCount(cu.tokens) : null;
        const windowK = formatTokenCount(cu.contextWindow);
        const pct = cu.percent != null ? Math.round(cu.percent) : null;
        if (tokensK !== null && pct !== null) {
            const estimatePrefix = cu.estimated ? 'Approximate context' : 'Context';
            const estimateMark = cu.estimated ? '~' : '';
            const title = `${estimatePrefix}: ${tokensK} / ${windowK} tokens (${pct}%). Click for context actions.`;
            contextHtml = `<span class="footer-context footer-context-usage" title="${escAttr(title)}" role="button" tabindex="0">${estimateMark}${tokensK} / ${windowK} &middot; ${pct}%</span>`;
        } else {
            contextHtml = `<span class="footer-context footer-context-usage" title="Context window: ${escAttr(windowK)} tokens. Click for context actions." role="button" tabindex="0">${windowK}</span>`;
        }
    }

    const codexUsageHtml = renderCodexUsage();
    const attachmentCount = currentImageAttachments.length + currentFileAttachments.length;
    const attachmentLabels: string[] = [];
    if (currentImageAttachments.length > 0) attachmentLabels.push(`${currentImageAttachments.length} image${currentImageAttachments.length === 1 ? '' : 's'}`);
    if (currentFileAttachments.length > 0) attachmentLabels.push(`${currentFileAttachments.length} file${currentFileAttachments.length === 1 ? '' : 's'}`);
    const attachmentHtml = attachmentCount > 0
        ? `<span class="footer-context" title="${attachmentLabels.join(', ')}">${attachmentLabels.join(', ')}</span>`
        : '';

    const actionIcon = state.isStreaming ? 'stop.png' : 'chevrons.png';
    const actionTitle = state.isStreaming ? 'Stop generation (Esc)' : 'Send';
    const actionAlt = state.isStreaming ? 'Stop' : 'Send';

    const cacheChipHtml = renderCacheChip();

    footer.innerHTML = `
        <button id="btn-attach-file" class="attach-btn" title="Attach file or image"><img class="attach-icon-img" src="${iconsBaseUri}/folder.png" alt="Attach file or image"></button>
        <span class="footer-model">${escHtml(modelName)}</span>
        ${cacheChipHtml}
        <span class="footer-spacer"></span>
        ${attachmentHtml}
        ${codexUsageHtml}
        ${contextHtml}
        <button id="btn-send" class="send-btn${state.isStreaming ? ' send-btn--stop' : ''}" title="${actionTitle}"><img class="send-icon-img" src="${iconsBaseUri}/${actionIcon}" alt="${actionAlt}"></button>
    `;

    // Rebind the dynamic footer elements
    const sendBtn = document.getElementById('btn-send');
    sendBtn?.addEventListener('click', () => {
        if (state.isStreaming) {
            vscode.postMessage({ type: 'abort' });
        } else {
            sendMessage();
        }
    });

    const attachBtn = document.getElementById('btn-attach-file');
    attachBtn?.addEventListener('click', () => {
        const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
        fileInput?.click();
    });

    document.querySelector('.footer-model')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextActionPicker();
        toggleModelPicker();
    });

    document.querySelector('.footer-cache')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextActionPicker();
        toggleCacheModePicker();
    });

    const contextChip = document.querySelector('.footer-context-usage') as HTMLElement | null;
    contextChip?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCacheModePicker();
        closeModelPicker();
        toggleContextActionPicker(contextChip);
    });
    contextChip?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            closeCacheModePicker();
            closeModelPicker();
            toggleContextActionPicker(contextChip);
        }
    });

    updateQueuedMessageBanner();
}

function renderCacheChip(): string {
    const mode = state.cacheMode;
    const eff = state.cacheEffective;
    const cap = getCacheCapability(state.model?.provider, state.model?.id);
    let label: string;
    let cls = 'footer-cache';
    if (mode === 'auto') {
        label = `cache: auto&middot;${eff}`;
        cls += ` footer-cache--auto footer-cache--${eff}`;
    } else {
        label = `cache: ${mode}`;
        cls += ` footer-cache--${mode}`;
    }
    if (!cap.chipActive) cls += ' footer-cache--inert';
    const tooltip = cacheChipTooltip(mode, eff);
    return `<span class="${cls}" title="${escHtml(tooltip)}">${label}</span>`;
}

function cacheChipTooltip(mode: 'short' | 'long' | 'auto', eff: 'short' | 'long'): string {
    const cap = getCacheCapability(state.model?.provider, state.model?.id);
    const lines: string[] = [];
    lines.push(`Prompt cache retention: ${mode}${mode === 'auto' ? ` (currently ${eff})` : ''}`);
    lines.push(`Provider: ${state.model?.provider ?? '-'} — short: ${cap.shortLabel}, long: ${cap.longLabel}`);
    lines.push(cap.note);
    if (mode === 'auto') {
        if (cap.family === 'openai' || cap.family === 'auto') {
            lines.push('Auto picks long here because cache writes are free on this provider.');
        } else if (cap.family === 'anthropic') {
            lines.push('Auto picks long when this session has shown a >2 min idle gap or the cached prefix is >20k tokens.');
        } else {
            lines.push('Auto picks long after a >2 min idle gap or a >20k-token prefix.');
        }
    }
    if (!cap.chipActive) {
        lines.push('Note: this provider does not act on the chip; setting is informational.');
    }
    lines.push('Click to change.');
    return lines.join('\n');
}

function toggleCacheModePicker(): void {
    closeContextActionPicker();
    const existing = document.getElementById('cache-mode-picker');
    if (existing) {
        existing.remove();
        document.removeEventListener('click', onClickOutsideCachePicker);
        return;
    }
    const container = document.querySelector('.input-container');
    if (!container) return;

    const picker = el('div', 'cache-mode-picker');
    picker.id = 'cache-mode-picker';
    const cap = getCacheCapability(state.model?.provider, state.model?.id);

    const autoDesc =
        cap.family === 'openai' || cap.family === 'auto'
            ? `Always picks long for this provider (free cache writes)`
            : cap.family === 'anthropic'
                ? `Picks long after a >2 min idle gap or a >20k-token prefix`
                : cap.family === 'unsupported'
                    ? `Heuristic runs, but ${state.model?.provider ?? 'this provider'} ignores the setting`
                    : `Picks based on idle gaps & context size`;

    const shortDesc =
        cap.family === 'openai'
            ? `5 min TTL — provider auto-caches, writes are free either way`
            : cap.family === 'auto'
                ? `Provider auto-caches by prefix; setting has little effect`
                : cap.family === 'unsupported'
                    ? `No caching wired for this provider`
                    : `5 min TTL — cheap writes, lost on long pauses`;

    const longDesc =
        cap.family === 'openai'
            ? `24 h TTL — writes free, survives long breaks`
            : cap.family === 'auto'
                ? `Provider auto-caches by prefix; setting has little effect`
                : cap.family === 'unsupported'
                    ? `No caching wired for this provider`
                    : `1 h TTL — pricier writes (~2× input), survives breaks`;

    const options: Array<{ value: 'short' | 'long' | 'auto'; title: string; desc: string }> = [
        { value: 'auto', title: 'Auto', desc: autoDesc },
        { value: 'short', title: `Short${cap.family !== 'unsupported' && cap.family !== 'auto' ? ` (${cap.shortLabel})` : ''}`, desc: shortDesc },
        { value: 'long', title: `Long${cap.family !== 'unsupported' && cap.family !== 'auto' ? ` (${cap.longLabel})` : ''}`, desc: longDesc },
    ];
    for (const opt of options) {
        const isActive = state.cacheMode === opt.value;
        const item = el('div', `cache-mode-item${isActive ? ' active' : ''}`);
        item.dataset.mode = opt.value;
        const effHint = opt.value === 'auto' ? ` <span class="cache-mode-eff">(now ${state.cacheEffective})</span>` : '';
        item.innerHTML = `
            <span class="cache-mode-check">${isActive ? '&#10003;' : ''}</span>
            <span class="cache-mode-text">
                <span class="cache-mode-title">${escHtml(opt.title)}${effHint}</span>
                <span class="cache-mode-desc">${escHtml(opt.desc)}</span>
            </span>
        `;
        picker.appendChild(item);
    }
    container.appendChild(picker);

    picker.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.cache-mode-item') as HTMLElement | null;
        if (!item) return;
        const mode = item.dataset.mode as 'short' | 'long' | 'auto' | undefined;
        if (!mode) return;
        state.cacheMode = mode;
        vscode.postMessage({ type: 'setCacheMode', mode });
        closeCacheModePicker();
        updateInputArea();
    });

    setTimeout(() => {
        document.addEventListener('click', onClickOutsideCachePicker);
    }, 0);
}

function onClickOutsideCachePicker(e: MouseEvent): void {
    const picker = document.getElementById('cache-mode-picker');
    if (picker && !picker.contains(e.target as Node)) {
        closeCacheModePicker();
    }
}

function closeCacheModePicker(): void {
    document.getElementById('cache-mode-picker')?.remove();
    document.removeEventListener('click', onClickOutsideCachePicker);
}

function toggleContextActionPicker(anchor: HTMLElement): void {
    closeCacheModePicker();
    closeModelPicker();
    const existing = document.getElementById('context-action-picker');
    if (existing) {
        closeContextActionPicker();
        return;
    }
    const container = document.querySelector('.input-container') as HTMLElement | null;
    if (!container) return;

    const picker = el('div', 'context-action-picker');
    picker.id = 'context-action-picker';

    const item = el('button', 'context-action-item') as HTMLButtonElement;
    item.type = 'button';
    item.textContent = 'Compact';
    item.title = 'Summarize older conversation context while keeping recent work available.';
    if (state.isCompacting) {
        item.disabled = true;
    }
    picker.appendChild(item);
    container.appendChild(picker);
    positionContextActionPicker(picker, anchor, container);

    item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isCompacting) return;
        closeContextActionPicker();
        vscode.postMessage({ type: 'prompt', text: '/compact' });
    });

    setTimeout(() => {
        document.addEventListener('click', onClickOutsideContextActionPicker);
    }, 0);
}

function positionContextActionPicker(picker: HTMLElement, anchor: HTMLElement, container: HTMLElement): void {
    const containerRect = container.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const margin = 6;
    const maxLeft = Math.max(margin, containerRect.width - picker.offsetWidth - margin);
    const anchorLeft = anchorRect.left - containerRect.left;
    picker.style.left = `${Math.min(Math.max(anchorLeft, margin), maxLeft)}px`;
}

function onClickOutsideContextActionPicker(e: MouseEvent): void {
    const picker = document.getElementById('context-action-picker');
    if (picker && !picker.contains(e.target as Node)) {
        closeContextActionPicker();
    }
}

function closeContextActionPicker(): void {
    document.getElementById('context-action-picker')?.remove();
    document.removeEventListener('click', onClickOutsideContextActionPicker);
}

let queuedEditingIndex = -1;

function updateQueuedMessageBanner(): void {
    const section = document.getElementById('queued-section') as HTMLDetailsElement | null;
    if (!section) return;

    if (state.queuedMessages.length === 0) {
        section.style.display = 'none';
        section.innerHTML = '';
        queuedEditingIndex = -1;
        return;
    }

    section.style.display = '';
    section.open = true;

    const count = state.queuedMessages.length;
    section.innerHTML = `
        <summary class="queued-summary">
            <span class="queued-chevron">&#9656;</span>
            <span class="queued-count">${count} Queued</span>
        </summary>
        <div class="queued-list">
            ${state.queuedMessages.map((msg, i) => {
                if (i === queuedEditingIndex) {
                    return `<div class="queued-item queued-item-editing" data-index="${i}">
                        <span class="queued-item-icon">&#9675;</span>
                        <input class="queued-edit-input" data-index="${i}" type="text" value="${escAttr(msg)}">
                        <button class="queued-edit-save" data-index="${i}" title="Save">&#10003;</button>
                        <button class="queued-edit-cancel" data-index="${i}" title="Cancel">&#10005;</button>
                    </div>`;
                }
                return `<div class="queued-item" data-index="${i}">
                    <span class="queued-item-icon">&#9675;</span>
                    <span class="queued-item-text">${escHtml(msg)}</span>
                    <span class="queued-item-actions">
                        <button class="queued-item-btn queued-item-edit" data-index="${i}" title="Edit"><img class="queued-btn-icon" src="${iconsBaseUri}/pencil.png" alt="edit"></button>
                        <button class="queued-item-btn queued-item-delete" data-index="${i}" title="Remove"><img class="queued-btn-icon" src="${iconsBaseUri}/trash.png" alt="remove"></button>
                    </span>
                </div>`;
            }).join('')}
        </div>
    `;

    bindQueuedItemEvents(section);
}

function bindQueuedItemEvents(section: HTMLElement): void {
    section.querySelectorAll('.queued-item-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                if (queuedEditingIndex === idx) queuedEditingIndex = -1;
                else if (queuedEditingIndex > idx) queuedEditingIndex--;
                vscode.postMessage({ type: 'removeQueuedMessage', index: idx });
            }
        });
    });

    section.querySelectorAll('.queued-item-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                queuedEditingIndex = idx;
                updateQueuedMessageBanner();
                const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        });
    });

    section.querySelectorAll('.queued-edit-save').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
            if (idx >= 0 && input && input.value.trim()) {
                queuedEditingIndex = -1;
                vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: input.value.trim() });
            }
        });
    });

    section.querySelectorAll('.queued-edit-cancel').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            queuedEditingIndex = -1;
            updateQueuedMessageBanner();
        });
    });

    section.querySelectorAll('.queued-edit-input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            const ke = e as KeyboardEvent;
            const idx = parseInt((input as HTMLElement).dataset.index ?? '-1', 10);
            if (ke.key === 'Enter') {
                ke.preventDefault();
                const val = (input as HTMLInputElement).value.trim();
                if (idx >= 0 && val) {
                    queuedEditingIndex = -1;
                    vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: val });
                }
            }
            if (ke.key === 'Escape') {
                ke.preventDefault();
                queuedEditingIndex = -1;
                updateQueuedMessageBanner();
            }
        });
    });
}

function showSteerToast(text: string): void {
    const existing = document.getElementById('steer-toast');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const toast = el('div', 'steer-toast');
    toast.id = 'steer-toast';
    toast.innerHTML = `
        <span class="steer-toast-indicator"></span>
        <span class="steer-toast-label">Steering...</span>
        <span class="steer-toast-text">${escHtml(truncate(text, 80))}</span>
    `;

    const inputArea = container.querySelector('.input-area');
    if (inputArea) {
        container.insertBefore(toast, inputArea);
    } else {
        container.appendChild(toast);
    }
}

function dismissSteerToast(): void {
    const toast = document.getElementById('steer-toast');
    if (!toast) return;
    toast.classList.add('steer-toast-fade');
    setTimeout(() => toast.remove(), 300);
}

function buildWelcome(): HTMLElement {
    const w = el('div', 'welcome');
    const hasUsableModel = (state.availableModels?.length ?? 0) > 0 || !!state.model;
    const noAuthBanner = (!state.modelsLoaded || hasUsableModel) ? '' : `
        <div class="welcome-no-auth">
            <div class="welcome-no-auth-title">No models available yet</div>
            <div class="welcome-no-auth-text">Add an API key or sign in with a subscription account (ChatGPT, Claude, Copilot) to unlock models.</div>
            <button class="welcome-no-auth-btn" id="welcome-open-settings">Open Settings</button>
        </div>
    `;
    w.innerHTML = `
        <div class="welcome-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M7 2.5 Q3 2.5 3 6 V10 Q3 12 1.5 12 Q3 12 3 14 V18 Q3 21.5 7 21.5"/>
                <path d="M17 2.5 Q21 2.5 21 6 V10 Q21 12 22.5 12 Q21 12 21 14 V18 Q21 21.5 17 21.5"/>
                <path d="M6 8 H18"/>
                <path d="M9.5 8 V17.5"/>
                <path d="M14 8 V15.5 Q14 17.5 16 17.5"/>
            </svg>
        </div>
        <div class="welcome-title">Pi Code</div>
        <div class="welcome-subtitle">Ask anything. Pi can read, write, and execute code for you.</div>
        ${noAuthBanner}
        <div class="welcome-hints">
            <div class="welcome-hint">Type a message to start</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+L</kbd> Focus chat</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+N</kbd> New session</div>
            <div class="welcome-hint"><kbd>Esc</kbd> Stop generation</div>
        </div>
    `;
    if (!hasUsableModel) {
        const btn = w.querySelector('#welcome-open-settings');
        btn?.addEventListener('click', () => {
            vscode.postMessage({ type: 'openSettings' });
        });
    }
    return w;
}

// ── Changed Files section ──

function getFileIcon(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const icons: Record<string, string> = {
        ts: '&#128312;', tsx: '&#128312;',
        js: '&#128313;', jsx: '&#128313;',
        json: '&#128312;',
        css: '&#128309;', scss: '&#128309;',
        html: '&#128992;',
        md: '&#128310;',
        py: '&#128311;',
        svg: '&#128993;',
    };
    return icons[ext] ?? '&#128196;';
}

function buildChangedFilesSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'changed-files-section';
    details.id = 'changed-files-bar';

    const fileMap = new Map<string, FileChangeInfo>();
    for (const c of state.fileChanges) {
        fileMap.set(c.filePath, c);
    }
    const uniqueFiles = [...fileMap.values()];
    const count = uniqueFiles.length;

    const summary = document.createElement('summary');
    summary.className = 'changed-files-summary';
    const undoRedoBtn = state.rollbackPoint !== null
        ? `<button class="changed-files-link" id="btn-redo" title="Redo changes">Redo</button>`
        : `<button class="changed-files-link" id="btn-undo" title="Undo last change">Undo</button>`;
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${count} File${count !== 1 ? 's' : ''}</span>
        <span class="changed-files-spacer"></span>
        ${undoRedoBtn}
        <button class="changed-files-review-btn" id="btn-review-all" title="Review all changes">Review</button>
    `;
    details.appendChild(summary);

    const list = el('div', 'changed-files-list');
    for (const change of uniqueFiles) {
        const fileName = change.filePath.split('/').pop() ?? change.filePath;
        const item = el('div', 'changed-file-item');
        item.dataset.filepath = change.filePath;
        item.dataset.toolcallid = change.toolCallId;

        let statsHtml = '';
        if (change.addedLines > 0) statsHtml += `<span class="cf-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="cf-stat-del">-${change.removedLines}</span>`;

        item.innerHTML = `
            <span class="cf-icon">${getFileIcon(change.filePath)}</span>
            <span class="cf-name">${escHtml(fileName)}</span>
            <span class="cf-stats">${statsHtml}</span>
        `;
        list.appendChild(item);
    }
    details.appendChild(list);

    return details;
}

function updateChangedFiles(): void {
    const container = document.querySelector('.input-container');
    if (!container) return;

    const existing = document.getElementById('changed-files-bar') as HTMLDetailsElement | null;
    const wasOpen = existing?.open ?? false;

    if (state.fileChanges.length === 0) {
        existing?.remove();
        return;
    }

    const newSection = buildChangedFilesSection();
    if (wasOpen) {
        (newSection as HTMLDetailsElement).open = true;
    }

    if (existing) {
        existing.replaceWith(newSection);
    } else {
        container.insertBefore(newSection, container.firstChild);
    }

    bindChangedFileItems();

    const undoBtn = document.getElementById('btn-undo');
    undoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let lastUserTurn = 0;
        for (const msg of state.messages) {
            if ((msg.role ?? 'unknown') === 'user') lastUserTurn++;
        }
        if (lastUserTurn < 1) return;
        vscode.postMessage({
            type: 'confirmAction',
            action: 'restoreCheckpoint',
            message: 'Undo changes from the last turn?',
            payload: { messageIndex: lastUserTurn - 1 },
        });
    });

    const redoBtn = document.getElementById('btn-redo');
    redoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({
            type: 'confirmAction',
            action: 'redoCheckpoint',
            message: 'Re-apply the rolled-back changes?',
        });
    });

    const reviewBtn = document.getElementById('btn-review-all');
    reviewBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const seen = new Set<string>();
        for (const change of state.fileChanges) {
            if (!seen.has(change.filePath)) {
                seen.add(change.filePath);
                vscode.postMessage({ type: 'openDiff', filePath: change.filePath, toolCallId: change.toolCallId });
            }
        }
    });
}

function renderChangedFilesBar(): void {
    const existing = document.getElementById('changed-files-bar');
    if (existing) {
        const fileMap = new Map<string, FileChangeInfo>();
        for (const c of state.fileChanges) {
            fileMap.set(c.filePath, c);
        }
        const count = fileMap.size;
        const countEl = existing.querySelector('.changed-files-count');
        if (countEl) {
            countEl.textContent = `${count} File${count !== 1 ? 's' : ''}`;
        }
    }
}

function renderInlineFileChange(change: FileChangeInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`diff-${change.toolCallId}`);
    if (existing) return;

    const card = buildDiffCard(change);

    const loadingCard = document.getElementById(`tool-${change.toolCallId}`);
    if (loadingCard) {
        loadingCard.replaceWith(card);
    } else {
        container.appendChild(card);
    }

    bindDiffButtons();
    bindDiffPreviewToggles();
    scrollToBottom();
}

// ── Inline diff card ──

function buildDiffCard(change: FileChangeInfo, msg?: any): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', 'diff-card');
    card.id = `diff-${change.toolCallId}`;

    const fileName = change.filePath.split('/').pop() ?? change.filePath;
    const dirPath = change.filePath.split('/').slice(0, -1).join('/');

    let statsHtml = '';
    if (change.addedLines > 0 || change.removedLines > 0) {
        statsHtml = `<span class="diff-stats">`;
        if (change.addedLines > 0) statsHtml += `<span class="diff-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="diff-stat-del">-${change.removedLines}</span>`;
        statsHtml += `</span>`;
    }

    const actionLabel = change.toolName === 'write' ? 'Write' : 'Edit';

    card.innerHTML = `
        <div class="diff-file-header" data-filepath="${escHtml(change.filePath)}" data-toolcallid="${escHtml(change.toolCallId)}">
            <span class="tool-icon">${getToolIcon(change.toolName)}</span>
            <span class="diff-file-name">${actionLabel} ${escHtml(fileName)}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${change.isNew ? '<span class="diff-new-badge">NEW</span>' : ''}
        </div>
    `;

    if (change.diff) {
        const renderedDiff = renderDiffLines(change.diff);
        const diffView = el('div', `diff-view${renderedDiff.rowCount > 3 ? ' diff-view-expandable diff-view-collapsed' : ''}`);
        if (renderedDiff.rowCount > 3) {
            diffView.dataset.moreRows = String(renderedDiff.rowCount - 3);
            diffView.title = 'Click to expand the full diff';
        }
        diffView.innerHTML = renderedDiff.html;
        card.appendChild(diffView);
        observeDiffStripeAlignment(diffView);
    }

    wrapper.appendChild(card);

    const ts = msg?.timestamp;
    if (ts) {
        const footer = el('div', 'tool-footer');
        footer.textContent = formatTimestamp(ts);
        wrapper.appendChild(footer);
    }

    return wrapper;
}

function observeDiffStripeAlignment(diffView: HTMLElement): void {
    const align = () => {
        diffView.querySelectorAll<HTMLElement>('.diff-cell-empty, .diff-gap').forEach((cell) => {
            const row = cell.closest<HTMLTableRowElement>('tr');
            if (!row) return;
            cell.style.setProperty('--diff-stripe-offset-y', `${-row.offsetTop}px`);
        });
    };

    requestAnimationFrame(align);

    if (typeof ResizeObserver !== 'undefined' && !diffStripeAlignmentObservers.has(diffView)) {
        const observer = new ResizeObserver(() => requestAnimationFrame(align));
        observer.observe(diffView);
        diffStripeAlignmentObservers.set(diffView, observer);
    }
}

function renderDiffLines(diff: string): { html: string; rowCount: number } {
    const lines = diff.replace(/\r\n/g, '\n').split('\n');
    const rows: string[] = [];
    let rowCount = 0;
    let removed: string[] = [];
    let added: string[] = [];
    let hasRenderedRows = false;

    const pushRow = (row: string, countsAsContent = true) => {
        rows.push(row);
        if (countsAsContent) rowCount++;
    };

    const flushChanges = () => {
        if (removed.length === 0 && added.length === 0) return;

        const count = Math.max(removed.length, added.length);
        for (let i = 0; i < count; i++) {
            pushRow(renderDiffPairRow(
                removed[i] ?? '',
                added[i] ?? '',
                removed[i] === undefined ? 'empty' : 'del',
                added[i] === undefined ? 'empty' : 'add',
            ));
        }

        removed = [];
        added = [];
        hasRenderedRows = true;
    };

    for (const rawLine of lines) {
        if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
            continue;
        }

        if (rawLine.startsWith('@@')) {
            flushChanges();
            if (hasRenderedRows) {
                pushRow(renderDiffGapRow(), false);
            }
            continue;
        }

        if (rawLine.startsWith('-')) {
            removed.push(rawLine.slice(1));
            continue;
        }

        if (rawLine.startsWith('+')) {
            added.push(rawLine.slice(1));
            continue;
        }

        flushChanges();

        if (rawLine.startsWith('\\ No newline')) {
            pushRow(renderDiffNoticeRow(rawLine));
            hasRenderedRows = true;
            continue;
        }

        const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
        pushRow(renderDiffPairRow(text, text, 'ctx', 'ctx'));
        hasRenderedRows = true;
    }

    flushChanges();

    return {
        html: `<table class="diff-side-by-side" role="presentation"><tbody>${rows.join('')}</tbody></table>`,
        rowCount,
    };
}

type DiffCellKind = 'ctx' | 'add' | 'del' | 'empty';

function renderDiffPairRow(
    leftText: string,
    rightText: string,
    leftKind: DiffCellKind,
    rightKind: DiffCellKind,
): string {
    return `<tr class="diff-row">
        ${renderDiffCell(leftText, leftKind, 'left')}
        ${renderDiffCell(rightText, rightKind, 'right')}
    </tr>`;
}

function renderDiffCell(text: string, kind: DiffCellKind, side: 'left' | 'right'): string {
    const content = kind === 'empty' ? '&nbsp;' : escHtml(text);
    return `<td class="diff-cell diff-cell-${side} diff-cell-${kind}">${content}</td>`;
}

function renderDiffGapRow(): string {
    return `<tr class="diff-row diff-row-gap"><td class="diff-gap" colspan="2" aria-hidden="true">&nbsp;</td></tr>`;
}

function renderDiffNoticeRow(text: string): string {
    return `<tr class="diff-row diff-row-notice"><td class="diff-notice" colspan="2">${escHtml(text)}</td></tr>`;
}

// ── Message rendering ──

function renderMessage(msg: any, index: number, turnNumber?: number, isStickyPrompt = false): HTMLElement {
    const role = msg.role ?? 'unknown';

    if (role === 'toolResult' || role === 'tool') {
        const toolName = msg.toolName ?? '';
        if (toolName === 'edit' || toolName === 'write') {
            const matchingChange = findFileChangeForToolResult(msg)
                ?? buildFileChangeFromToolResult(msg, state.messages, index);
            if (matchingChange) {
                return buildDiffCard(matchingChange, msg);
            }
        }
        return buildToolResultCard(msg, state.messages, index);
    }

    if (role === 'error') {
        return renderErrorMessage(msg);
    }

    if (role === 'compactionSummary') {
        return buildCompactionSummaryCard(msg);
    }

    if (role === 'user') {
        const group = el('div', `message-group-user${isStickyPrompt ? ' message-group-current-user' : ''}`);

        const wrapper = el('div', `message message-${role}`);
        if (turnNumber !== undefined && !state.isStreaming) {
            const checkpointBtn = el('button', 'checkpoint-btn');
            checkpointBtn.title = 'Restore to this checkpoint';
            checkpointBtn.dataset.turn = String(turnNumber);
            checkpointBtn.innerHTML = '&#8634;';
            wrapper.appendChild(checkpointBtn);
        }
        const rawText = extractText(msg);
        const images = extractImages(msg);
        const { cleanText, fileNames } = stripFileBlocks(stripPlanModeBlock(rawText));
        const { skillName, userText } = parseSkillFromUserMessage(cleanText);
        if (skillName) {
            const badge = el('span', 'skill-badge');
            badge.textContent = `/skill:${skillName}`;
            wrapper.appendChild(badge);
        }
        if (fileNames.length > 0 || images.length > 0) {
            wrapper.appendChild(buildMessageAttachmentChips(images, fileNames));
        }
        if (userText) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(userText);
            wrapper.appendChild(content);
        }
        if (images.length > 0) {
            wrapper.appendChild(buildMessageImageGrid(images));
        }
        group.appendChild(wrapper);

        const footer = buildMessageFooter(msg, index);
        if (footer) {
            group.appendChild(footer);
        }

        return group;
    }

    // Assistant messages: wrap in a styled container
    const thinking = extractThinking(msg);
    const text = stripPlanCompleteMarker(extractText(msg));

    if (!thinking && !text) {
        const empty = el('div');
        empty.style.display = 'none';
        return empty;
    }

    const group = el('div', 'message-group-assistant');

    const wrapper = el('div', `message message-${role}`);

    if (thinking) {
        wrapper.appendChild(buildThinkingBlock(thinking, false, msg._thinkingDurationSec));
    }

    if (text) {
        const content = el('div', 'message-content');
        content.innerHTML = renderMarkdown(text);
        wrapper.appendChild(content);
    }

    group.appendChild(wrapper);

    const footer = buildMessageFooter(msg, index);
    if (footer) {
        group.appendChild(footer);
    }

    return group;
}

function buildCompactionSummaryCard(msg: any): HTMLElement {
    const group = el('div', 'message-group-compaction');
    const wrapper = el('div', 'message-compaction-summary');

    const details = document.createElement('details');
    details.className = 'compaction-details';

    const summary = document.createElement('summary');
    summary.textContent = getCompactionTitle(msg);
    details.appendChild(summary);

    const content = el('div', 'message-content compaction-content');
    const meta = getCompactionMetaText(msg);
    if (meta) {
        const metaEl = el('div', 'compaction-meta');
        metaEl.textContent = meta;
        content.appendChild(metaEl);
    }
    const summaryEl = el('div', 'compaction-summary-text');
    summaryEl.innerHTML = renderMarkdown(msg.summary ?? '');
    content.appendChild(summaryEl);
    details.appendChild(content);

    wrapper.appendChild(details);
    group.appendChild(wrapper);
    return group;
}

function getCompactionTitle(msg: any): string {
    const before = typeof msg.tokensBefore === 'number' ? msg.tokensBefore : undefined;
    const after = getCompactionCurrentTokens(msg);
    if (before !== undefined && after !== undefined) {
        const removed = Math.max(0, before - after);
        const removedText = removed > 0 ? `, ${formatTokenCount(removed)} removed` : '';
        const estimateMark = msg._latestCompaction && state.contextUsage?.estimated ? '~' : '';
        return `Context compacted: ${formatTokenCount(before)} → ${estimateMark}${formatTokenCount(after)} tokens${removedText}`;
    }
    if (before !== undefined) {
        return `Context compacted from ${formatTokenCount(before)} tokens`;
    }
    return 'Context compacted';
}

function getCompactionMetaText(msg: any): string {
    const before = typeof msg.tokensBefore === 'number' ? msg.tokensBefore : undefined;
    const after = getCompactionCurrentTokens(msg);
    if (before === undefined || after === undefined) return '';
    const removed = Math.max(0, before - after);
    const pct = before > 0 ? Math.round((removed / before) * 100) : 0;
    return removed > 0
        ? `Compaction reduced the visible context by about ${formatTokenCount(removed)} tokens (${pct}%).`
        : `Current context is about ${formatTokenCount(after)} tokens after compaction.`;
}

function getCompactionCurrentTokens(msg: any): number | undefined {
    if (typeof msg.tokensAfter === 'number') return msg.tokensAfter;
    if (msg._latestCompaction && typeof state.contextUsage?.tokens === 'number') {
        return state.contextUsage.tokens;
    }
    return undefined;
}

function extractToolCalls(msg: any): any[] {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg.tool_calls;
    if (Array.isArray(msg.content)) {
        const tcs = msg.content.filter((c: any) => c.type === 'toolCall' || c.type === 'tool_call' || c.type === 'tool_use');
        if (tcs.length > 0) return tcs;
    }
    return [];
}

function findFileChangeForToolResult(msg: any): FileChangeInfo | undefined {
    const id = msg.toolCallId ?? msg.tool_call_id;
    if (id) {
        const match = state.fileChanges.find(c => c.toolCallId === id);
        if (match) return match;
    }
    return undefined;
}

function buildFileChangeFromToolResult(msg: any, allMessages: any[], msgIndex: number): FileChangeInfo | undefined {
    if (msg.isError) return undefined;

    const toolName = msg.toolName ?? '';
    if (toolName !== 'edit' && toolName !== 'write') return undefined;

    const toolCallId = msg.toolCallId ?? msg.tool_call_id ?? `tool-result-${msgIndex}`;
    const matchingCall = findToolCallInMessages(allMessages, msgIndex, toolCallId);
    const parsedArgs = getParsedToolArgs(matchingCall);
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? extractPathFromToolResultText(extractText(msg));
    if (!filePath) return undefined;

    const diff = extractToolResultDiff(msg)
        ?? (toolName === 'edit' ? buildDiffFromEditArgs(parsedArgs) : undefined);
    if (!diff) return undefined;

    const stats = countDiffStats(diff);
    return {
        filePath,
        toolCallId,
        toolName,
        isNew: false,
        diff,
        addedLines: stats.added,
        removedLines: stats.removed,
        turnIndex: 0,
    };
}

function getParsedToolArgs(toolCall: any): any {
    const args = toolCall?.arguments ?? toolCall?.args ?? toolCall?.input ?? toolCall?.function?.arguments ?? {};
    return typeof args === 'string' ? tryParseJSON(args) : args;
}

function extractToolResultDiff(msg: any): string | undefined {
    const candidates = [
        msg.details?.diff,
        msg.result?.details?.diff,
        msg._result?.details?.diff,
    ];
    return candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
}

function extractPathFromToolResultText(text: string): string {
    const match = text.match(/\bin\s+(.+?)\.?$/m);
    return match?.[1]?.trim() ?? '';
}

function buildDiffFromEditArgs(args: any): string | undefined {
    const edits = getEditItems(args);
    if (edits.length === 0) return undefined;

    const lines: string[] = [];
    edits.forEach((edit, index) => {
        if (index > 0) lines.push('@@');
        for (const line of splitToolIoLines(edit.oldText)) lines.push(`-${line}`);
        for (const line of splitToolIoLines(edit.newText)) lines.push(`+${line}`);
    });
    return lines.join('\n');
}

function getEditItems(args: any): { oldText: string; newText: string }[] {
    if (!args || typeof args !== 'object') return [];

    let rawEdits = args.edits;
    if (typeof rawEdits === 'string') {
        const parsed = tryParseJSON(rawEdits);
        if (Array.isArray(parsed)) rawEdits = parsed;
    }

    const edits = Array.isArray(rawEdits) ? rawEdits : [];
    const normalized = edits
        .filter((edit: any) => typeof edit?.oldText === 'string' && typeof edit?.newText === 'string')
        .map((edit: any) => ({ oldText: edit.oldText, newText: edit.newText }));

    if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
        normalized.push({ oldText: args.oldText, newText: args.newText });
    }

    return normalized;
}

function countDiffStats(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
        if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
    }
    return { added, removed };
}

function removePreparingPlaceholder(): void {
    document.getElementById('preparing-placeholder')?.remove();
}

function showPreparingPlaceholder(labelText = 'Preparing next moves...'): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    const existing = document.getElementById('preparing-placeholder');
    if (existing) {
        const label = existing.querySelector('.preparing-label');
        if (label) label.textContent = labelText;
        return;
    }
    const ph = el('div', 'preparing-placeholder');
    ph.id = 'preparing-placeholder';
    const spinner = el('span', 'preparing-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const label = el('span', 'preparing-label');
    label.textContent = labelText;
    ph.appendChild(spinner);
    ph.appendChild(label);
    container.appendChild(ph);
    scrollToBottom();
}

function ensurePreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    const hasRunningTool = container.querySelector('.tool-status.running');
    if (!hasRunningTool) {
        showPreparingPlaceholder(state.isCompacting ? 'Compacting...' : 'Preparing next moves...');
    }
}

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if (!state.streamingText && !state.streamingThinking) return;
    removePreparingPlaceholder();

    if (!container.querySelector('.message')) {
        container.innerHTML = `
            <div class="message message-assistant">
                <details class="thinking-block active" id="streaming-thinking" style="display:none">
                    <summary class="thinking-summary">
                        <span class="thinking-indicator" aria-hidden="true"><img class="thinking-indicator-icon" src="${iconsBaseUri}/thinking.png" alt=""></span>
                        <span class="thinking-label">Thinking...</span>
                        <span class="thinking-preview"></span>
                        <span class="thinking-chevron">&#9656;</span>
                    </summary>
                    <div class="thinking-content"></div>
                </details>
                <div class="message-content" id="streaming-text"></div>
            </div>
        `;
    }

    const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    if (thinkingEl) {
        if (state.streamingThinking) {
            thinkingEl.style.display = '';
            const contentEl = thinkingEl.querySelector('.thinking-content');
            if (contentEl) contentEl.innerHTML = renderMarkdown(state.streamingThinking);
            const previewEl = thinkingEl.querySelector('.thinking-preview');
            if (previewEl) previewEl.textContent = getThinkingPreview(state.streamingThinking);
            const labelEl = thinkingEl.querySelector('.thinking-label');
            if (state.isThinking) {
                thinkingEl.classList.add('active');
                if (labelEl) labelEl.textContent = 'Thinking...';
            } else {
                thinkingEl.classList.remove('active');
                if (labelEl) {
                    const dur = state.streamingThinkingDuration;
                    labelEl.textContent = dur > 0
                        ? `Thought for ${dur} second${dur !== 1 ? 's' : ''}`
                        : 'Thought';
                }
            }
        } else {
            thinkingEl.style.display = 'none';
        }
    }

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        textEl.innerHTML = renderMarkdown(stripPlanCompleteMarker(state.streamingText));
    }

    bindCopyButtons();
    scrollToBottom();
}

// ── Tool rendering ──

function getToolIcon(name: string): string {
    const iconFiles: Record<string, string> = {
        bash: 'terminal.png',
        python: 'code.png',
        read: 'text.png',
        write: 'pencil.png',
        edit: 'pencil.png',
        find: 'magnifying-glass.png',
        glob: 'magnifying-glass.png',
        grep: 'magnifying-glass.png',
        list: 'folder.png',
        todo: 'todo.png',
        web_search: 'web.png',
        fetch_content: 'web.png',
        get_search_content: 'web.png',
        code_search: 'web.png',
        // LSP toolset — share a single icon so the chat groups them visually.
        find_references: 'links.png',
        find_implementations: 'links.png',
        goto_definition: 'links.png',
        document_symbols: 'links.png',
        hover: 'links.png',
        type_definition: 'links.png',
        workspace_symbols: 'links.png',
        call_hierarchy_incoming: 'links.png',
        call_hierarchy_outgoing: 'links.png',
    };
    const file = iconFiles[name.toLowerCase()] ?? 'bolt.png';
    return `<img class="tool-icon-img" src="${iconsBaseUri}/${file}" alt="${escHtml(name)}">`;
}

function getToolLabel(name: string, args: any): string {
    const filePath = args?.path ?? args?.file_path;
    switch (name.toLowerCase()) {
        case 'bash':
            return args?.command ? truncate(args.command, 60) : 'Execute command';
        case 'read':
            return filePath ? `Read ${truncate(filePath, 50)}` : 'Read file';
        case 'write':
            return filePath ? `Write ${truncate(filePath, 50)}` : 'Write file';
        case 'edit':
            return filePath ? `Edit ${truncate(filePath, 50)}` : 'Edit file';
        case 'glob':
            return args?.pattern ? `Glob ${truncate(args.pattern, 50)}` : 'Find files';
        case 'grep':
            return args?.pattern ? `Grep ${truncate(args.pattern, 50)}` : 'Search files';
        case 'todo':
            return 'Todo';
        case 'web_search':
            return args?.query ? `Search: ${truncate(args.query, 50)}` : 'Web search';
        case 'fetch_content':
            return args?.url ? `Fetch: ${truncate(args.url, 50)}` : 'Fetch content';
        case 'get_search_content':
            return 'Get search results';
        case 'code_search':
            return args?.query ? `Code search: ${truncate(args.query, 50)}` : 'Code search';
        // LSP toolset — uniform "LSP: <tool_name>" header so the chat
        // shows what kind of LSP operation ran without the agent's
        // input dressing.
        case 'find_references':
        case 'find_implementations':
        case 'goto_definition':
        case 'document_symbols':
        case 'hover':
        case 'type_definition':
        case 'workspace_symbols':
        case 'call_hierarchy_incoming':
        case 'call_hierarchy_outgoing':
            return `LSP: ${name.toLowerCase()}`;
        default:
            return name;
    }
}

function extractToolResultText(result: any): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result
            .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof result === 'object') {
        if (Array.isArray(result.content)) {
            const text = result.content
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            if (text) return text;
        }
        if (result.text) return result.text;
        if (result.output) return result.output;
    }
    return JSON.stringify(result, null, 2);
}

function formatToolArgs(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${val}`;
    }).join('\n');
}

const COMMAND_LIKE_TOOLS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'python', 'node']);
const COMMAND_INPUT_KEYS = ['command', 'cmd', 'script', 'code'];
const TOOL_IO_PREVIEW_LINE_LIMIT = 4;
const liveToolOutputs = new Map<string, string>();

function buildStatusHtml(status: string): string {
    if (status === 'done') return '';
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return `<span class="tool-status ${status}">${label}</span>`;
}

function isCommandLikeTool(name: string, args: any): boolean {
    const normalized = (name ?? '').toLowerCase();
    if (COMMAND_LIKE_TOOLS.has(normalized)) return true;
    if (!args || typeof args !== 'object') return false;
    return COMMAND_INPUT_KEYS.some(key => typeof args[key] === 'string');
}

function getCommandInputText(args: any): string {
    if (!args) return '';
    if (typeof args === 'string') return args;
    if (typeof args !== 'object') return '';
    for (const key of COMMAND_INPUT_KEYS) {
        const value = args[key];
        if (typeof value === 'string') return value;
    }
    return '';
}

function splitToolIoLines(text: string): string[] {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function takeToolIoLines(lines: string[], limit: number): string {
    if (limit <= 0) return '';
    const selected = lines.slice(0, limit);
    if (lines.length > limit && selected.length > 0) {
        const last = selected.length - 1;
        selected[last] = selected[last] ? `${selected[last]} …` : '…';
    }
    return selected.join('\n');
}

function buildToolIoPreview(input: string, output: string): { input: string; output: string } {
    const inputLines = splitToolIoLines(input || '(no input)');
    const outputLines = splitToolIoLines(output || '(no output)');
    const inputLimit = Math.min(inputLines.length, Math.min(2, TOOL_IO_PREVIEW_LINE_LIMIT - 1));
    const outputLimit = Math.max(1, TOOL_IO_PREVIEW_LINE_LIMIT - inputLimit);
    return {
        input: takeToolIoLines(inputLines, inputLimit),
        output: takeToolIoLines(outputLines, outputLimit),
    };
}

function appendToolIoRow(container: HTMLElement, label: string, value: string): void {
    const row = el('div', 'tool-io-row');
    const labelEl = el('div', 'tool-io-label');
    labelEl.textContent = label;
    const valueEl = el('pre', 'tool-io-value');
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    container.appendChild(row);
}

function appendToolIoRows(container: HTMLElement, input: string, output: string, preview: boolean): void {
    const displayInput = input || '(no input)';
    const displayOutput = output || '(no output)';
    const values = preview ? buildToolIoPreview(displayInput, displayOutput) : { input: displayInput, output: displayOutput };
    appendToolIoRow(container, 'IN', values.input);
    appendToolIoRow(container, 'OUT', values.output);
}

function refreshToolIoCard(details: HTMLDetailsElement, input: string, output: string): void {
    const preview = details.querySelector('.tool-io-preview') as HTMLElement | null;
    if (preview) {
        preview.replaceChildren();
        appendToolIoRows(preview, input, output, true);
    }

    const body = details.querySelector('.tool-io-full') as HTMLElement | null;
    if (body) {
        body.replaceChildren();
        appendToolIoRows(body, input, output, false);
    }
}

function buildToolIoCard(headerHtml: string, input: string, output: string, className = 'tool-card tool-expandable'): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = `${className} tool-io-card`;

    const summary = el('summary', 'tool-io-summary');
    const header = el('div', 'tool-header');
    header.innerHTML = headerHtml;
    const arrow = el('span', 'tool-expand-arrow');
    arrow.innerHTML = '&#9656;';
    header.appendChild(arrow);
    summary.appendChild(header);

    const preview = el('div', 'tool-io-preview');
    summary.appendChild(preview);
    details.appendChild(summary);

    const body = el('div', 'tool-body tool-io-full');
    details.appendChild(body);
    refreshToolIoCard(details, input, output);

    return details;
}

interface TodoToolRow {
    id?: number;
    status?: string;
    subject: string;
    blockedBy?: number[];
    activeForm?: string;
}

function normalizeTodoStatus(status: unknown): string | undefined {
    return typeof status === 'string' && /^(pending|in_progress|completed|deleted)$/.test(status)
        ? status
        : undefined;
}

function getTodoRowsFromDetails(source: any): TodoToolRow[] {
    const details = source?.details;
    if (!details || !Array.isArray(details.tasks)) return [];

    const params = details.params ?? {};
    let tasks: any[] = [];
    if (details.action === 'list') {
        tasks = [...details.tasks];
        if (!params.includeDeleted) tasks = tasks.filter((t) => t.status !== 'deleted');
        if (typeof params.status === 'string') tasks = tasks.filter((t) => t.status === params.status);
    } else if (details.action === 'get' && typeof params.id === 'number') {
        const task = details.tasks.find((t: any) => t.id === params.id);
        if (task) tasks = [task];
    }

    return tasks.map((t) => ({
        id: typeof t.id === 'number' ? t.id : undefined,
        status: normalizeTodoStatus(t.status),
        subject: String(t.subject ?? ''),
        activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.filter((id: any) => typeof id === 'number') : undefined,
    })).filter((row) => row.subject.length > 0);
}

function parseTodoRowsFromText(text: string): TodoToolRow[] {
    const rows: TodoToolRow[] = [];
    for (const line of splitToolIoLines(text)) {
        let match = line.match(/^\[(pending|in_progress|completed|deleted)\]\s+#(\d+)\s+(.+)$/);
        if (match) {
            rows.push(parseTodoRowTail(match[3], match[1], Number(match[2])));
            continue;
        }
        match = line.match(/^#(\d+)\s+\[(pending|in_progress|completed|deleted)\]\s+(.+)$/);
        if (match) {
            rows.push(parseTodoRowTail(match[3], match[2], Number(match[1])));
        }
    }
    return rows;
}

function parseTodoRowTail(tail: string, status: string, id: number): TodoToolRow {
    const [subjectPart, blockedPart] = tail.split(' ⛓ ', 2);
    const blockedBy = blockedPart
        ? blockedPart.split(',').map((part) => Number(part.trim().replace(/^#/, ''))).filter(Number.isFinite)
        : undefined;
    return { id, status, subject: subjectPart.trim(), blockedBy };
}

function buildTodoToolResultElement(source: any, text: string): HTMLElement | null {
    const rows = getTodoRowsFromDetails(source);
    const fallbackRows = rows.length > 0 ? rows : parseTodoRowsFromText(text);
    if (fallbackRows.length === 0) return null;

    const list = el('div', 'todo-tool-result');
    for (const row of fallbackRows) {
        const statusClass = row.status ? ` todo-tool-row-${row.status}` : '';
        const item = el('div', `todo-tool-row${statusClass}`);
        const icon = el('span', 'todo-tool-icon');
        icon.innerHTML = `<img class="todo-tool-icon-img" src="${iconsBaseUri}/todo.png" alt="Todo">`;
        item.appendChild(icon);
        if (row.id !== undefined) item.appendChild(el('span', 'todo-tool-id', `#${row.id}`));
        const label = el('span', 'todo-tool-label', row.status === 'in_progress' && row.activeForm ? row.activeForm : row.subject);
        item.appendChild(label);
        if (row.blockedBy?.length) {
            item.appendChild(el('span', 'todo-tool-blocked', `⛓ ${row.blockedBy.map((id) => `#${id}`).join(',')}`));
        }
        list.appendChild(item);
    }
    return list;
}

function appendToolResultContent(container: HTMLElement, toolName: string, source: any, text: string): void {
    const todoResult = toolName.toLowerCase() === 'todo'
        ? buildTodoToolResultElement(source, text)
        : null;
    if (todoResult) {
        container.appendChild(todoResult);
        return;
    }

    const result = el('pre', 'tool-result');
    result.textContent = text || '(no output)';
    if (!text) result.classList.add('empty');
    container.appendChild(result);
}

function buildToolCard(tc: any): HTMLElement {
    const card = el('div', 'tool-card');
    const name = tc.name ?? tc.toolName ?? tc.function?.name ?? 'unknown';
    const args = tc.args ?? tc.arguments ?? tc.input ?? tc.function?.arguments;
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const statusClass = tc._status ?? 'pending';

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(name)}</span>
            <span class="tool-name">${escHtml(getToolLabel(name, parsedArgs))}</span>
            ${buildStatusHtml(statusClass)}
        </div>
    `;

    if (tc._result !== undefined) {
        const text = extractToolResultText(tc._result);
        if (text) {
            appendToolResultContent(card, name, tc._result, text);
        }
    }

    return card;
}

function buildToolFooter(msg: any, allMessages: any[], msgIndex: number): HTMLElement | null {
    const parts: string[] = [];
    const ts = msg.timestamp;
    if (ts) parts.push(formatTimestamp(ts));

    const precedingAssistant = findPrecedingAssistant(allMessages, msgIndex);
    if (precedingAssistant?.usage) {
        const u = precedingAssistant.usage;
        if (u.input > 0) parts.push(`${u.input.toLocaleString()} in`);
        if (u.output > 0) parts.push(`${u.output.toLocaleString()} out`);
    }

    if (parts.length === 0) return null;
    const footer = el('div', 'tool-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

function findPrecedingAssistant(messages: any[], beforeIndex: number): any | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i];
        if (messages[i].role === 'user') return null;
    }
    return null;
}

function buildToolResultCard(msg: any, allMessages: any[], msgIndex: number): HTMLElement {
    const isError = msg.isError ?? false;
    const toolName = msg.toolName ?? '';
    const toolCallId = msg.toolCallId ?? '';
    const nameLower = toolName.toLowerCase();

    const matchingCall = findToolCallInMessages(allMessages, msgIndex, toolCallId);
    const args = matchingCall?.arguments ?? matchingCall?.args ?? matchingCall?.input ?? matchingCall?.function?.arguments ?? {};
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const label = toolName ? getToolLabel(toolName, parsedArgs) : 'Tool Result';
    const icon = getToolIcon(toolName ?? '');
    const isRead = nameLower === 'read';
    const isCommandLike = isCommandLikeTool(toolName, parsedArgs);
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isCommandLike) && !isRead;

    const footer = buildToolFooter(msg, allMessages, msgIndex);

    if (hasBody) {
        const wrapper = el('div', 'tool-card-wrapper');

        if (isCommandLike) {
            const headerHtml = `
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${escHtml(label)}</span>
                ${buildStatusHtml(isError ? 'error' : 'done')}
            `;
            const details = buildToolIoCard(headerHtml, getCommandInputText(parsedArgs), resultContent);
            wrapper.appendChild(details);
        } else {
            const details = document.createElement('details');
            details.className = 'tool-card tool-expandable';

            details.innerHTML = `
                <summary class="tool-header">
                    <span class="tool-icon">${icon}</span>
                    <span class="tool-name">${escHtml(label)}</span>
                    ${buildStatusHtml(isError ? 'error' : 'done')}
                    <span class="tool-expand-arrow">&#9656;</span>
                </summary>
            `;

            const body = el('div', 'tool-body');
            appendToolResultContent(body, toolName, msg, resultContent);
            details.appendChild(body);
            wrapper.appendChild(details);
        }

        if (footer) wrapper.appendChild(footer);
        return wrapper;
    }

    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escHtml(label)}</span>
            ${buildStatusHtml(isError ? 'error' : 'done')}
        </div>
    `;

    wrapper.appendChild(card);
    if (footer) wrapper.appendChild(footer);
    return wrapper;
}

function findToolCallInMessages(messages: any[], beforeIndex: number, toolCallId: string): any | undefined {
    if (!toolCallId) return undefined;
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const tcs = extractToolCalls(m);
        for (const tc of tcs) {
            if ((tc.id ?? tc.toolCallId) === toolCallId) return tc;
        }
    }
    return undefined;
}

function renderToolStart(event: any): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const editFilePath = event.args?.path ?? event.args?.file_path;
    if ((event.toolName === 'edit' || event.toolName === 'write') && editFilePath) {
        const card = el('div', 'diff-card loading');
        card.id = `tool-${event.toolCallId}`;
        const fileName = (editFilePath as string).split('/').pop() ?? editFilePath;
        const actionLabel = event.toolName === 'write' ? 'Write' : 'Edit';
        card.innerHTML = `
            <div class="diff-file-header">
                <span class="tool-icon">${getToolIcon(event.toolName)}</span>
                <span class="diff-file-name">${actionLabel} ${escHtml(fileName)}</span>
                <span class="tool-status running">running</span>
            </div>
        `;
        container.appendChild(card);
        scrollToBottom();
        return;
    }

    const parsedArgs = typeof event.args === 'string' ? tryParseJSON(event.args) : event.args;
    const nameLower = (event.toolName ?? '').toLowerCase();
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';
    const isCommandLike = isCommandLikeTool(event.toolName, parsedArgs);

    if (isCommandLike) {
        const input = getCommandInputText(parsedArgs);
        const headerHtml = `
            <span class="tool-icon">${getToolIcon(event.toolName)}</span>
            <span class="tool-name">${escHtml(getToolLabel(event.toolName, parsedArgs))}</span>
            <span class="tool-status running">running</span>
        `;
        const details = buildToolIoCard(headerHtml, input, '');
        details.id = `tool-${event.toolCallId}`;
        details.dataset.toolName = event.toolName;
        details.dataset.commandLike = 'true';
        details.dataset.toolInput = input;
        container.appendChild(details);
        scrollToBottom();
        return;
    }

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    card.id = `tool-${event.toolCallId}`;
    card.dataset.toolName = event.toolName;
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(event.toolName)}</span>
            <span class="tool-name">${escHtml(getToolLabel(event.toolName, parsedArgs))}</span>
            <span class="tool-status running">running</span>
        </div>
    `;

    container.appendChild(card);
    bindToolClickable();
    scrollToBottom();
}

function renderToolUpdate(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`) as HTMLElement | null;
    if (!card) return;
    if (card.classList.contains('diff-card')) return;
    const text = extractToolResultText(event.partialResult);
    if (!text) return;

    if (card.dataset.commandLike === 'true' || card.classList.contains('tool-io-card')) {
        liveToolOutputs.set(event.toolCallId, text);
        if (card instanceof HTMLDetailsElement) {
            refreshToolIoCard(card, card.dataset.toolInput ?? '', text);
        }
        scrollToBottom();
        return;
    }

    let resultEl = card.querySelector('.tool-result') as HTMLElement | null;
    if (!resultEl) {
        resultEl = el('pre', 'tool-result');
        card.appendChild(resultEl);
    }
    resultEl.textContent = text;
    scrollToBottom();
}

function renderToolEnd(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;

    if (card.classList.contains('diff-card')) {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = event.isError ? 'error' : 'done';
            statusEl.className = `tool-status ${event.isError ? 'error' : 'done'}`;
        }
        return;
    }

    const toolName = (card as HTMLElement).dataset.toolName ?? '';
    const text = extractToolResultText(event.result) || liveToolOutputs.get(event.toolCallId) || '';
    liveToolOutputs.delete(event.toolCallId);
    const isCommandLike = (card as HTMLElement).dataset.commandLike === 'true' || isCommandLikeTool(toolName, undefined);
    const hasBody = !!(text || isCommandLike);

    if (hasBody) {
        const headerEl = card.querySelector('.tool-header') as HTMLElement | null;
        const statusEl = headerEl?.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = 'error';
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }
        const nameHtml = headerEl?.innerHTML ?? '';

        if (isCommandLike && card instanceof HTMLDetailsElement && card.classList.contains('tool-io-card')) {
            refreshToolIoCard(card, (card as HTMLElement).dataset.toolInput ?? '', text);
            bindToolClickable();
            return;
        }

        let details: HTMLDetailsElement;
        if (isCommandLike) {
            details = buildToolIoCard(nameHtml, (card as HTMLElement).dataset.toolInput ?? '', text, card.className.replace('tool-card', 'tool-card tool-expandable'));
        } else {
            details = document.createElement('details');
            details.className = card.className.replace('tool-card', 'tool-card tool-expandable');
            details.innerHTML = `<summary class="tool-header">${nameHtml}</summary>`;

            const arrow = el('span', 'tool-expand-arrow');
            arrow.innerHTML = '&#9656;';
            details.querySelector('summary')?.appendChild(arrow);

            const body = el('div', 'tool-body');
            appendToolResultContent(body, toolName, event.result, text);
            details.appendChild(body);
        }

        details.id = card.id;
        details.dataset.toolName = toolName;
        if ((card as HTMLElement).dataset.filepath) details.dataset.filepath = (card as HTMLElement).dataset.filepath;

        card.replaceWith(details);
        bindToolClickable();
    } else {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = 'error';
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }
    }
}

// ── Tool approval cards ──

function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    removePreparingPlaceholder();

    const existing = document.getElementById(`approval-${pending.toolCallId}`);
    if (existing) return;

    const card = el('div', 'tool-approval-card');
    card.id = `approval-${pending.toolCallId}`;

    const parsedArgs = typeof pending.args === 'string' ? tryParseJSON(pending.args) : pending.args;
    const label = getToolLabel(pending.toolName, parsedArgs);

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(pending.toolName)}</span>
            <span class="tool-name">${escHtml(label)}</span>
            <span class="tool-status pending">awaiting approval</span>
        </div>
        <div class="approval-args">${escHtml(formatToolArgs(parsedArgs))}</div>
        <div class="approval-actions">
            <button class="approval-btn approve" data-toolcallid="${escHtml(pending.toolCallId)}">Approve</button>
            <button class="approval-btn reject" data-toolcallid="${escHtml(pending.toolCallId)}">Reject</button>
        </div>
    `;

    container.appendChild(card);
    bindApprovalButtons();
    scrollToBottom();
}

function removeToolApprovalCard(toolCallId: string): void {
    document.getElementById(`approval-${toolCallId}`)?.remove();
}

function bindApprovalButtons(): void {
    document.querySelectorAll('.approval-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const toolCallId = (btn as HTMLElement).dataset.toolcallid;
            if (!toolCallId) return;
            if (btn.classList.contains('approve')) {
                vscode.postMessage({ type: 'approveToolCall', toolCallId });
            } else {
                vscode.postMessage({ type: 'rejectToolCall', toolCallId });
            }
            removeToolApprovalCard(toolCallId);
        });
    });
}

// ── Thinking block ──

function buildThinkingBlock(text: string, active: boolean, durationSec?: number): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    let label: string;
    if (active) {
        label = 'Thinking...';
    } else if (durationSec && durationSec > 0) {
        label = `Thought for ${durationSec} second${durationSec !== 1 ? 's' : ''}`;
    } else {
        label = 'Thought';
    }
    details.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator" aria-hidden="true"><img class="thinking-indicator-icon" src="${iconsBaseUri}/thinking.png" alt=""></span>
            <span class="thinking-label">${label}</span>
            <span class="thinking-preview">${escHtml(getThinkingPreview(text))}</span>
            <span class="thinking-chevron">&#9656;</span>
        </summary>
        <div class="thinking-content">${renderMarkdown(text)}</div>
    `;
    return details;
}

// ── Model picker popup ──

let pendingModelPicker = false;

function toggleModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) {
        existing.remove();
        pendingModelPicker = false;
        return;
    }

    if (state.availableModels.length === 0) {
        pendingModelPicker = true;
        vscode.postMessage({ type: 'getModels' });
        return;
    }

    showModelPicker();
}

function addToRecentModels(provider: string, id: string, name?: string, supportsImages?: boolean): void {
    state.recentModels = state.recentModels.filter(
        m => !(m.id === id && m.provider === provider)
    );
    state.recentModels.unshift({ provider, id, name, supportsImages });
    if (state.recentModels.length > 1) {
        state.recentModels = state.recentModels.slice(0, 1);
    }
}

function buildModelItem(m: any): HTMLElement {
    const item = el('div', 'model-item');
    const isActive = state.model && m.id === state.model.id && m.provider === state.model.provider;
    if (isActive) item.classList.add('active');
    item.dataset.provider = m.provider;
    item.dataset.modelId = m.id;
    item.dataset.name = (m.name ?? m.id).toLowerCase();
    const favKey = `${m.provider}:${m.modelId ?? m.id}`;
    const isFav = state.favoriteModels.has(favKey);
    const starIcon = isFav ? 'starfill.png' : 'starline.png';
    item.innerHTML = `
        <span class="model-item-check">${isActive ? '&#10003;' : ''}</span>
        <span class="model-item-name">${escHtml(m.name ?? m.id)}</span>
        <img class="model-item-star" src="${iconsBaseUri}/${starIcon}" alt="" data-fav-key="${escAttr(favKey)}">
    `;
    return item;
}

function showModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const picker = el('div', 'model-picker');
    picker.id = 'model-picker';

    const searchInput = document.createElement('input');
    searchInput.className = 'model-search';
    searchInput.placeholder = 'Search models...';
    searchInput.type = 'text';
    picker.appendChild(searchInput);

    const list = el('div', 'model-list');

    // Favorites — alphabetically sorted, always at the top
    const favModels = state.availableModels
        .filter(m => state.favoriteModels.has(`${m.provider}:${m.id}`))
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    if (favModels.length > 0) {
        const favHeader = el('div', 'model-section-header');
        favHeader.textContent = 'Favorites';
        list.appendChild(favHeader);
        for (const m of favModels) {
            list.appendChild(buildModelItem(m));
        }
    }

    // Recent — only 1 model, skip if already in favorites
    if (state.recentModels.length > 0) {
        const recentItem = state.recentModels[0];
        const favKey = `${recentItem.provider}:${recentItem.id}`;
        if (!state.favoriteModels.has(favKey)) {
            const full = state.availableModels.find(
                m => m.id === recentItem.id && m.provider === recentItem.provider
            );
            if (full) {
                const recentHeader = el('div', 'model-section-header');
                recentHeader.textContent = 'Recent';
                list.appendChild(recentHeader);
                list.appendChild(buildModelItem(full));
            }
        }
    }

    // All Models — always full list
    const allHeader = el('div', 'model-section-header');
    allHeader.textContent = 'All Models';
    list.appendChild(allHeader);
    for (const m of state.availableModels) {
        list.appendChild(buildModelItem(m));
    }
    picker.appendChild(list);

    const thinkingRow = el('div', 'thinking-chips');
    const thinkingLabel = el('span', 'thinking-label');
    thinkingLabel.textContent = 'Thinking:';
    thinkingRow.appendChild(thinkingLabel);
    const levels = ['off', 'minimal', 'low', 'medium', 'high'];
    for (const level of levels) {
        const chip = el('button', `thinking-chip${level === state.thinkingLevel ? ' active' : ''}`);
        chip.textContent = level.charAt(0).toUpperCase() + level.slice(1);
        chip.dataset.level = level;
        thinkingRow.appendChild(chip);
    }
    picker.appendChild(thinkingRow);

    container.appendChild(picker);

    searchInput.focus();

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        list.querySelectorAll('.model-item').forEach((item) => {
            const name = (item as HTMLElement).dataset.name ?? '';
            (item as HTMLElement).style.display = name.includes(q) ? '' : 'none';
        });
        list.querySelectorAll('.model-section-header').forEach((hdr) => {
            (hdr as HTMLElement).style.display = q ? 'none' : '';
        });
    });

    list.addEventListener('click', (e) => {
        // Star click — toggle favorite, don't select model
        const star = (e.target as HTMLElement).closest('.model-item-star') as HTMLElement | null;
        if (star) {
            e.stopPropagation();
            const favKey = star.dataset.favKey!;
            const [provider, ...rest] = favKey.split(':');
            const modelId = rest.join(':');
            const isFav = state.favoriteModels.has(favKey);
            if (isFav) {
                state.favoriteModels.delete(favKey);
            } else {
                state.favoriteModels.add(favKey);
            }
            star.src = isFav ? `${iconsBaseUri}/starline.png` : `${iconsBaseUri}/starfill.png`;
            vscode.postMessage({ type: 'toggleFavorite', provider, modelId });
            return;
        }

        const item = (e.target as HTMLElement).closest('.model-item') as HTMLElement | null;
        if (!item) return;
        const provider = item.dataset.provider!;
        const modelId = item.dataset.modelId!;
        vscode.postMessage({ type: 'setModel', provider, modelId });
        const matched = state.availableModels.find(m => m.id === modelId && m.provider === provider);
        if (matched) {
            state.model = { provider, id: modelId, name: matched.name ?? modelId, supportsImages: matched.supportsImages };
            addToRecentModels(provider, modelId, matched.name ?? modelId, matched.supportsImages);
        }
        updateFooterModel();
        closeModelPicker();
    });

    thinkingRow.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest('.thinking-chip') as HTMLElement | null;
        if (!chip) return;
        vscode.postMessage({ type: 'setThinkingLevel', level: chip.dataset.level! });
        thinkingRow.querySelectorAll('.thinking-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.thinkingLevel = chip.dataset.level;
    });

    setTimeout(() => {
        document.addEventListener('click', onClickOutsidePicker);
    }, 0);
}

function onClickOutsidePicker(e: MouseEvent): void {
    const picker = document.getElementById('model-picker');
    if (picker && !picker.contains(e.target as Node)) {
        closeModelPicker();
    }
}

function closeModelPicker(): void {
    document.getElementById('model-picker')?.remove();
    document.removeEventListener('click', onClickOutsidePicker);
}

function updateFooterModel(): void {
    const el = document.querySelector('.footer-model');
    if (el) {
        el.textContent = state.model?.name ?? state.model?.id ?? '';
    }
}

// ── Session list ──

function renderSessionList(sessions: any[], currentId?: string): void {
    let panel = document.getElementById('session-panel');
    if (!panel) {
        panel = el('div', 'session-panel');
        panel.id = 'session-panel';
        const app = document.getElementById('app');
        const modelBar = document.getElementById('model-bar');
        if (app && modelBar?.nextSibling) {
            app.insertBefore(panel, modelBar.nextSibling);
        } else {
            app?.appendChild(panel);
        }
    }

    if (sessions.length === 0) {
        panel.innerHTML = '<div class="session-empty">No previous sessions</div>';
        return;
    }

    panel.innerHTML = `
        <div class="session-header">
            <span>Sessions</span>
            <button class="icon-btn" id="btn-close-sessions" title="Close">&times;</button>
        </div>
        <div class="session-list">
            ${sessions.map(s => `
                <div class="session-item ${s.id === currentId ? 'active' : ''}" data-path="${escHtml(s.path)}">
                    <span class="session-item-name">${escHtml(s.name ?? (s.firstMessage ? s.firstMessage.slice(0, 100) : s.id))}</span>
                </div>
            `).join('')}
        </div>
    `;

    document.getElementById('btn-close-sessions')?.addEventListener('click', () => panel?.remove());
    panel.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', () => {
            const sessionPath = (item as HTMLElement).dataset.path;
            if (sessionPath) {
                vscode.postMessage({ type: 'loadSession', sessionPath });
            }
        });
    });
}

function renderErrorMessage(msg: any): HTMLElement {
    const text = extractText(msg);
    const group = el('div', 'message-group-system');
    const errEl = el('div', 'error-message');
    errEl.textContent = text;

    if (looksLikeAuthError(text)) {
        const action = el('button', 'error-action');
        action.textContent = 'Open Settings';
        action.addEventListener('click', () => {
            vscode.postMessage({ type: 'openSettings' });
        });
        errEl.appendChild(action);
    }

    group.appendChild(errEl);
    return group;
}

function showError(message: string): void {
    const container = document.getElementById('messages');
    if (!container) return;
    const errEl = el('div', 'error-message');
    errEl.textContent = message;

    if (looksLikeAuthError(message)) {
        const action = el('button', 'error-action');
        action.textContent = 'Open Settings';
        action.addEventListener('click', () => {
            vscode.postMessage({ type: 'openSettings' });
        });
        errEl.appendChild(action);
    }

    // Place the banner just before the trailing 30vh spacer so it sits at the
    // end of the natural message flow. Appending to `container` would land it
    // *after* the spacer (visually mid-screen); inserting before #streaming-message
    // would survive only until the next applyStateSync wipes that region.
    const spacerEl = container.querySelector('.messages-spacer');
    if (spacerEl) {
        container.insertBefore(errEl, spacerEl);
    } else {
        container.appendChild(errEl);
    }
    scrollToBottom();
}

function looksLikeAuthError(message: string): boolean {
    const m = message.toLowerCase();
    return (
        m.includes('api key') ||
        m.includes('apikey') ||
        m.includes('unauthorized') ||
        m.includes('authentic') ||
        m.includes('credentials') ||
        m.includes('not signed in') ||
        m.includes('no auth') ||
        m.includes('oauth') ||
        m.includes('sign in') ||
        m.includes('login required')
    );
}

function updateStreamingUI(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    container.innerHTML = '';
}

// ── File & image attachments ──

function inferImageMimeType(file: File): string | null {
    if (SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) return file.type;
    const name = file.name.toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    return null;
}

function isImageFile(file: File): boolean {
    return inferImageMimeType(file) !== null;
}

function isTextFile(file: File): boolean {
    if (SUPPORTED_TEXT_MIME_TYPES.has(file.type)) return true;
    const name = file.name.toLowerCase();
    const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';
    return SUPPORTED_TEXT_EXTENSIONS.has(ext);
}

const SUPPORTED_BINARY_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
    '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.o', '.obj', '.class', '.pyc', '.wasm',
]);

function isBinaryByExtension(name: string): boolean {
    const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    return SUPPORTED_BINARY_EXTENSIONS.has(ext);
}

function classifyFile(file: File): 'image' | 'text' | 'binary' | 'unsupported' {
    if (isImageFile(file)) return 'image';
    if (isTextFile(file)) return 'text';
    if (isBinaryByExtension(file.name)) return 'binary';
    return 'unsupported';
}

function hasAttachableFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')
        || Array.from(dataTransfer.files ?? []).some((file) => classifyFile(file) !== 'unsupported');
}

async function handleAttachPaste(event: ClipboardEvent): Promise<void> {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
    if (files.length === 0) return;
    event.preventDefault();
    await addAttachedFiles(files);
}

async function handleAttachDrop(event: DragEvent): Promise<void> {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => classifyFile(file) !== 'unsupported');
    if (files.length === 0) return;
    event.preventDefault();
    await addAttachedFiles(files);
}

async function addAttachedFiles(files: File[]): Promise<void> {
    for (const file of files) {
        const classification = classifyFile(file);
        if (classification === 'unsupported') {
            showError(`Unsupported file type: ${file.name || file.type || 'unknown file'}`);
            continue;
        }
        if (classification === 'binary') {
            if (currentFileAttachments.length >= MAX_FILE_ATTACHMENTS) {
                showError(`You can attach up to ${MAX_FILE_ATTACHMENTS} files per message.`);
                break;
            }
            currentFileAttachments.push({
                type: 'file' as const,
                data: '',
                mimeType: file.type || 'application/octet-stream',
                name: file.name,
                size: file.size,
                binary: true,
            });
        } else if (classification === 'image') {
            if (currentImageAttachments.length >= MAX_IMAGES_PER_MESSAGE) {
                showError(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
                break;
            }
            const mimeType = inferImageMimeType(file)!;
            try {
                currentImageAttachments.push(await fileToImageAttachment(file, mimeType));
            } catch (err: any) {
                showError(`Could not attach image: ${err?.message ?? String(err)}`);
            }
        } else {
            if (currentFileAttachments.length >= MAX_FILE_ATTACHMENTS) {
                showError(`You can attach up to ${MAX_FILE_ATTACHMENTS} files per message.`);
                break;
            }
            if (file.size > MAX_FILE_SIZE_BYTES) {
                showError(`File "${file.name}" is too large (${formatBytes(file.size)}). Maximum size is ${formatBytes(MAX_FILE_SIZE_BYTES)}.`);
                continue;
            }
            try {
                currentFileAttachments.push(await fileToFileAttachment(file));
            } catch (err: any) {
                showError(`Could not attach file: ${err?.message ?? String(err)}`);
            }
        }
    }
    draftImages.set(state.activeTabId, [...currentImageAttachments]);
    draftFiles.set(state.activeTabId, [...currentFileAttachments]);
    renderAttachmentPreview();
    updateInputArea();
}

async function fileToImageAttachment(file: File, mimeType: string): Promise<ImageAttachment> {
    const prepared = await prepareImageForAttachment(file, mimeType);
    const comma = prepared.dataUrl.indexOf(',');
    const data = comma >= 0 ? prepared.dataUrl.slice(comma + 1) : prepared.dataUrl;
    return {
        type: 'image',
        data,
        mimeType: prepared.mimeType,
        name: file.name || 'pasted-image',
        size: prepared.size,
        width: prepared.width,
        height: prepared.height,
    };
}

async function fileToFileAttachment(file: File): Promise<FileAttachment> {
    const dataUrl = await readFileAsDataUrl(file);
    const comma = dataUrl.indexOf(',');
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return {
        type: 'file',
        data,
        mimeType: file.type || 'text/plain',
        name: file.name,
        size: file.size,
    };
}

async function prepareImageForAttachment(file: File, mimeType: string): Promise<{ dataUrl: string; mimeType: string; size: number; width: number; height: number }> {
    const originalDataUrl = await readFileAsDataUrl(file);
    const originalDimensions = await getImageDimensions(originalDataUrl);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(originalDimensions.width, originalDimensions.height));
    if (scale >= 1) {
        return {
            dataUrl: originalDataUrl,
            mimeType,
            size: file.size,
            width: originalDimensions.width,
            height: originalDimensions.height,
        };
    }

    const width = Math.max(1, Math.round(originalDimensions.width * scale));
    const height = Math.max(1, Math.round(originalDimensions.height * scale));
    const outputMimeType = chooseResizeMimeType(mimeType);
    const dataUrl = await resizeImageDataUrl(originalDataUrl, width, height, outputMimeType);
    const size = estimateDataUrlBytes(dataUrl);
    return { dataUrl, mimeType: getDataUrlMimeType(dataUrl) ?? outputMimeType, size, width, height };
}

function chooseResizeMimeType(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'image/jpeg';
    if (mimeType === 'image/webp') return 'image/webp';
    return 'image/png';
}

function resizeImageDataUrl(src: string, width: number, height: number, mimeType: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Canvas rendering is not available'));
                    return;
                }
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL(mimeType, mimeType === 'image/jpeg' || mimeType === 'image/webp' ? JPEG_RESIZE_QUALITY : undefined));
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => reject(new Error('Could not load image for resizing'));
        img.src = src;
    });
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.readAsDataURL(file);
    });
}

function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Could not read image dimensions'));
        img.src = src;
    });
}

function renderAttachmentPreview(): void {
    const preview = document.getElementById('attachment-preview');
    if (!preview) return;
    const totalAttachments = currentImageAttachments.length + currentFileAttachments.length;
    if (totalAttachments === 0) {
        preview.innerHTML = '';
        preview.style.display = 'none';
        return;
    }
    preview.style.display = 'flex';

    // Image chips
    const imageChips = currentImageAttachments.map((img, index) => {
        const label = img.name || `Image ${index + 1}`;
        const size = img.size ? ` · ${formatBytes(img.size)}` : '';
        const dims = img.width && img.height ? ` · ${img.width}×${img.height}` : '';
        return `<div class="attachment-chip attachment-chip--image" title="${escAttr(label + size + dims)}" data-kind="image" data-index="${index}">
            <img class="attachment-thumb" src="data:${escAttr(img.mimeType)};base64,${escAttr(img.data)}" alt="${escAttr(label)}">
            <span class="attachment-name">${escHtml(label)}</span>
            <button class="attachment-remove" title="Remove image" aria-label="Remove image">×</button>
        </div>`;
    });

    // File chips (text and binary files)
    const fileChips = currentFileAttachments.map((file, index) => {
        const label = file.name;
        const size = ` · ${formatBytes(file.size)}`;
        const isBinary = file.binary === true;
        const iconSrc = isBinary ? `${iconsBaseUri}/filebinary.png` : `${iconsBaseUri}/file.png`;
        const fileType = isBinary ? 'binary' : 'text';
        return `<div class="attachment-chip attachment-chip--file" title="${escAttr(label + size)}" data-kind="file" data-index="${index}" data-filetype="${fileType}">
            <img class="attachment-file-icon-img" src="${escAttr(iconSrc)}" alt="${fileType}">
            <span class="attachment-name">${escHtml(label)}</span>
            <button class="attachment-remove" title="Remove file" aria-label="Remove file">×</button>
        </div>`;
    });

    preview.innerHTML = [...imageChips, ...fileChips].join('');

    preview.querySelectorAll('.attachment-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const chip = (btn as HTMLElement).closest('.attachment-chip') as HTMLElement | null;
            if (!chip) return;
            const kind = chip.dataset.kind;
            const index = Number(chip.dataset.index ?? '-1');
            if (kind === 'image' && index >= 0 && index < currentImageAttachments.length) {
                currentImageAttachments.splice(index, 1);
                draftImages.set(state.activeTabId, [...currentImageAttachments]);
            } else if (kind === 'file' && index >= 0 && index < currentFileAttachments.length) {
                currentFileAttachments.splice(index, 1);
                draftFiles.set(state.activeTabId, [...currentFileAttachments]);
            }
            renderAttachmentPreview();
            updateInputArea();
        });
    });
}

function clearAttachments(): void {
    currentImageAttachments = [];
    currentFileAttachments = [];
    draftImages.delete(state.activeTabId);
    draftFiles.delete(state.activeTabId);
    renderAttachmentPreview();
    updateInputArea();
}

function currentModelSupportsImages(): boolean {
    return state.model?.supportsImages !== false;
}

function getDataUrlMimeType(dataUrl: string): string | null {
    const match = dataUrl.match(/^data:([^;,]+)[;,]/);
    return match?.[1] ?? null;
}

function estimateDataUrlBytes(dataUrl: string): number {
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return Math.ceil(base64.length * 3 / 4);
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

// ── Events ──

function bindStableEvents(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;


    input?.addEventListener('keydown', (e) => {
        if (isFileMentionMenuVisible()) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                if (fileMentionMenuItems.length > 0) {
                    fileMentionMenuIndex = Math.min(fileMentionMenuIndex + 1, fileMentionMenuItems.length - 1);
                    const menu = document.getElementById('file-mention-menu');
                    if (menu) renderFileMentionMenu(menu);
                }
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (fileMentionMenuItems.length > 0) {
                    fileMentionMenuIndex = Math.max(fileMentionMenuIndex - 1, 0);
                    const menu = document.getElementById('file-mention-menu');
                    if (menu) renderFileMentionMenu(menu);
                }
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                if (fileMentionMenuItems.length > 0) {
                    selectFileMentionItem(fileMentionMenuIndex);
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                hideFileMentionMenu();
                return;
            }
        }

        if (isSlashMenuVisible()) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                slashMenuIndex = Math.min(slashMenuIndex + 1, slashMenuItems.length - 1);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                selectSlashItem(slashMenuIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                hideSlashMenu();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (state.isStreaming) {
                const text = input.value.trim();
                if (isCompactSlashCommand(text)) {
                    if (currentImageAttachments.length > 0 || currentFileAttachments.length > 0) {
                        showError('Slash commands cannot include attachments. Remove attachments before running /compact.');
                        return;
                    }
                    vscode.postMessage({ type: 'prompt', text });
                    input.value = '';
                    input.style.height = 'auto';
                    updateInputHighlights(input);
                    return;
                }
                if (currentImageAttachments.length > 0 || currentFileAttachments.length > 0) {
                    showError('Attachments cannot be queued while the agent is streaming. Send them after the current response finishes.');
                    return;
                }
                if (text) {
                    if (e.ctrlKey || e.metaKey) {
                        vscode.postMessage({ type: 'steer', text });
                        showSteerToast(text);
                    } else {
                        vscode.postMessage({ type: 'queueMessage', text });
                    }
                    input.value = '';
                    input.style.height = 'auto';
                    updateInputHighlights(input);
                }
            } else {
                sendMessage();
            }
        }
        if (e.key === 'Escape' && state.isStreaming) {
            e.preventDefault();
            vscode.postMessage({ type: 'abort' });
        }
    });

    input?.addEventListener('input', () => {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        updateInputHighlights(input);
        updateSlashMenu(input);
        updateFileMentionMenu(input);
    });

    input?.addEventListener('scroll', () => {
        if (!input) return;
        syncInputHighlightScroll(input);
    });

    input?.addEventListener('paste', (e) => {
        void handleAttachPaste(e);
    });

    const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
    fileInput?.addEventListener('change', () => {
        const files = Array.from(fileInput.files ?? []);
        fileInput.value = '';
        void addAttachedFiles(files);
    });

    const inputContainer = document.querySelector('.input-container') as HTMLElement | null;
    inputContainer?.addEventListener('dragover', (e) => {
        if (hasAttachableFiles(e.dataTransfer)) {
            e.preventDefault();
            inputContainer.classList.add('drag-over');
        }
    });
    inputContainer?.addEventListener('dragleave', () => {
        inputContainer.classList.remove('drag-over');
    });
    inputContainer?.addEventListener('drop', (e) => {
        inputContainer.classList.remove('drag-over');
        void handleAttachDrop(e);
    });
}

function bindTabEvents(): void {
    document.querySelectorAll('.tab').forEach((tabEl) => {
        tabEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tab-close')) return;
            const tabId = (tabEl as HTMLElement).dataset.tabId;
            if (tabId && tabId !== state.activeTabId) {
                vscode.postMessage({ type: 'switchTab', tabId });
            }
        });
    });

    document.querySelectorAll('.tab-close').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = (btn as HTMLElement).dataset.tabId;
            if (tabId) {
                vscode.postMessage({ type: 'closeTab', tabId });
            }
        });
    });
}

function bindCheckpointButtons(): void {
    document.querySelectorAll('.checkpoint-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            if (turn < 1) return;
            vscode.postMessage({
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: 'Discard all changes after this checkpoint?',
                payload: { messageIndex: turn - 1 },
            });
        });
    });
}

function bindRedoButtons(): void {
    document.querySelectorAll('.redo-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
                type: 'confirmAction',
                action: 'redoCheckpoint',
                message: 'Re-apply the rolled-back changes?',
            });
        });
    });
}

function bindDiffButtons(): void {
    document.querySelectorAll('.diff-file-header:not([data-bound])').forEach((header) => {
        header.setAttribute('data-bound', '1');
        header.addEventListener('click', () => {
            const filePath = (header as HTMLElement).dataset.filepath;
            const toolCallId = (header as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function bindDiffPreviewToggles(): void {
    document.querySelectorAll('.diff-view-expandable:not([data-toggle-bound])').forEach((view) => {
        view.setAttribute('data-toggle-bound', '1');
        view.addEventListener('click', () => {
            view.classList.toggle('diff-view-collapsed');
            view.classList.toggle('diff-view-expanded');
            (view as HTMLElement).title = view.classList.contains('diff-view-collapsed')
                ? 'Click to expand the full diff'
                : 'Click to collapse the diff preview';
        });
    });
}

function bindToolClickable(): void {
    document.querySelectorAll('.tool-clickable:not([data-click-bound])').forEach((card) => {
        card.setAttribute('data-click-bound', '1');
        const headerEl = card.querySelector('.tool-header') as HTMLElement | null;
        if (!headerEl) return;
        const nameEl = headerEl.querySelector('.tool-name') as HTMLElement | null;
        if (!nameEl) return;
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const filePath = (card as HTMLElement).dataset.filepath;
            if (filePath) {
                vscode.postMessage({ type: 'openFile', filePath });
            }
        });
    });
}

function bindChangedFileItems(): void {
    document.querySelectorAll('.changed-file-item:not([data-bound])').forEach((item) => {
        item.setAttribute('data-bound', '1');
        item.addEventListener('click', () => {
            const filePath = (item as HTMLElement).dataset.filepath;
            const toolCallId = (item as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function sendMessage(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    const typedText = input.value.trim();
    const images = currentImageAttachments.length > 0 ? [...currentImageAttachments] : undefined;
    const files = currentFileAttachments.length > 0 ? [...currentFileAttachments] : undefined;
    if (!typedText && !images?.length && !files?.length) return;
    if (isCompactSlashCommand(typedText) && (images?.length || files?.length)) {
        showError('Slash commands cannot include attachments. Remove attachments before running /compact.');
        return;
    }
    if (images?.length && !currentModelSupportsImages()) {
        showError('The current model does not support images. Select an image-capable model before sending image attachments.');
        return;
    }
    let text: string;
    if (typedText) {
        text = typedText;
    } else if (images?.length && files?.length) {
        text = 'Please inspect the attached images and files.';
    } else if (images && images.length > 1) {
        text = 'Please inspect the attached images.';
    } else if (images) {
        text = 'Please inspect the attached image.';
    } else if (files && files.length > 1) {
        text = `Please inspect the attached files: ${files.map(f => f.name).join(', ')}.`;
    } else {
        text = `Please inspect the attached file: ${files![0].name}.`;
    }
    input.value = '';
    input.style.height = 'auto';
    updateInputHighlights(input);
    draftTexts.delete(state.activeTabId);
    clearAttachments();
    userHasScrolled = false;
    updateScrollButton();
    vscode.postMessage({ type: 'prompt', text, images, files });
}

function bindCopyButtons(): void {
    document.querySelectorAll('.copy-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.codeId;
            if (!id) return;
            const codeEl = document.getElementById(id);
            if (!codeEl) return;
            navigator.clipboard.writeText(codeEl.textContent ?? '').then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });
    });
}

// ── Input mention highlighting ──

function updateInputHighlights(input?: HTMLTextAreaElement | null): void {
    const textInput = input ?? document.getElementById('input') as HTMLTextAreaElement | null;
    const highlight = document.getElementById('input-highlight') as HTMLElement | null;
    if (!textInput || !highlight) return;

    highlight.innerHTML = textInput.value ? renderInputHighlightHtml(textInput.value) : '';
    syncInputHighlightScroll(textInput);
}

function syncInputHighlightScroll(input: HTMLTextAreaElement): void {
    const highlight = document.getElementById('input-highlight') as HTMLElement | null;
    if (!highlight) return;
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
}

function renderInputHighlightHtml(text: string): string {
    const mentionRegex = /@\{[^}\r\n]+\}|@[^\s{}]+/g;
    let html = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(text)) !== null) {
        const mention = match[0];
        html += escHtml(text.slice(lastIndex, match.index));
        html += `<span class="input-file-mention">${escHtml(mention)}</span>`;
        lastIndex = match.index + mention.length;
    }

    html += escHtml(text.slice(lastIndex));
    if (text.endsWith('\n')) html += '<br>';
    return html;
}

// ── Workspace file mention menu ──

let fileMentionMenuIndex = 0;
let fileMentionMenuItems: WorkspaceFileSuggestion[] = [];
let fileMentionLatestRequestId = 0;
let fileMentionSearchTimer: ReturnType<typeof setTimeout> | undefined;
let fileMentionIsIndexing = false;

function updateFileMentionMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('file-mention-menu');
    if (!menu) return;

    const token = getActiveFileMentionToken(input);
    if (!token) {
        hideFileMentionMenu();
        return;
    }

    hideSlashMenu();
    fileMentionMenuIndex = 0;
    fileMentionIsIndexing = true;
    fileMentionMenuItems = [];
    renderFileMentionMenu(menu);
    menu.style.display = '';

    if (fileMentionSearchTimer) clearTimeout(fileMentionSearchTimer);
    fileMentionSearchTimer = setTimeout(() => {
        fileMentionSearchTimer = undefined;
        const requestId = ++fileMentionLatestRequestId;
        vscode.postMessage({ type: 'searchWorkspaceFiles', query: token.query, requestId });
    }, 100);
}

function handleWorkspaceFileSuggestions(requestId: number, query: string, items: WorkspaceFileSuggestion[], isIndexing: boolean): void {
    if (requestId < fileMentionLatestRequestId) return;
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const token = input ? getActiveFileMentionToken(input) : null;
    if (!input || !token || token.query !== query) return;

    fileMentionLatestRequestId = requestId;
    fileMentionMenuItems = items ?? [];
    fileMentionIsIndexing = isIndexing;
    fileMentionMenuIndex = Math.min(fileMentionMenuIndex, Math.max(0, fileMentionMenuItems.length - 1));

    const menu = document.getElementById('file-mention-menu');
    if (!menu) return;
    renderFileMentionMenu(menu);
    menu.style.display = '';
}

function renderFileMentionMenu(menu: HTMLElement): void {
    if (fileMentionIsIndexing) {
        menu.innerHTML = '<div class="file-mention-status">Indexing workspace files...</div>';
        return;
    }

    if (fileMentionMenuItems.length === 0) {
        menu.innerHTML = '<div class="file-mention-status">No matching files</div>';
        return;
    }

    fileMentionMenuIndex = Math.max(0, Math.min(fileMentionMenuIndex, fileMentionMenuItems.length - 1));
    menu.innerHTML = fileMentionMenuItems.map((item, i) => {
        const active = i === fileMentionMenuIndex ? ' file-mention-item-active' : '';
        return `<div class="file-mention-item${active}" data-index="${i}">
            <span class="file-mention-name">${escHtml(item.basename)}</span>
            <span class="file-mention-path">${escHtml(item.relativePath)}</span>
        </div>`;
    }).join('');

    menu.querySelectorAll('.file-mention-item').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            selectFileMentionItem(idx);
        });
    });

    scrollActiveFileMentionItemIntoView(menu);
}

function scrollActiveFileMentionItemIntoView(menu: HTMLElement): void {
    const active = menu.querySelector('.file-mention-item-active') as HTMLElement | null;
    if (!active) return;
    active.scrollIntoView({ block: 'nearest' });
}

function selectFileMentionItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;

    const item = fileMentionMenuItems[index];
    if (!item) return;

    const token = getActiveFileMentionToken(input);
    if (!token) return;

    const text = input.value;
    input.value = text.slice(0, token.matchStart) + item.insertText + text.slice(token.cursorPos);
    const newPos = token.matchStart + item.insertText.length;
    input.setSelectionRange(newPos, newPos);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    updateInputHighlights(input);

    hideFileMentionMenu();
    input.focus();
}

function hideFileMentionMenu(): void {
    if (fileMentionSearchTimer) {
        clearTimeout(fileMentionSearchTimer);
        fileMentionSearchTimer = undefined;
    }
    const menu = document.getElementById('file-mention-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    fileMentionMenuItems = [];
    fileMentionMenuIndex = 0;
    fileMentionIsIndexing = false;
}

function isFileMentionMenuVisible(): boolean {
    const menu = document.getElementById('file-mention-menu');
    return !!menu && menu.style.display !== 'none';
}

function getActiveFileMentionToken(input: HTMLTextAreaElement): { matchStart: number; cursorPos: number; query: string } | null {
    const text = input.value;
    const cursorPos = input.selectionStart;
    if (cursorPos !== input.selectionEnd) return null;

    const beforeCursor = text.slice(0, cursorPos);
    const match = beforeCursor.match(/(?:^|[\s([{:,;])(@\{([^}\r\n]*)$|@([^\s{}]*))$/);
    if (!match) return null;

    const token = match[1];
    const query = match[2] ?? match[3] ?? '';
    return {
        matchStart: beforeCursor.length - token.length,
        cursorPos,
        query,
    };
}

// ── Slash command menu ──

let slashMenuIndex = 0;
let slashMenuItems: SlashMenuItem[] = [];

function updateSlashMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('slash-menu');
    if (!menu) return;

    const text = input.value;
    const cursorPos = input.selectionStart;

    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (!slashMatch) {
        hideSlashMenu();
        return;
    }

    const query = slashMatch[1].slice(1).toLowerCase();
    const skillCommands: SlashMenuItem[] = state.skills.map((skill) => ({
        kind: 'skill',
        name: skill.name,
        displayName: `/skill:${skill.name}`,
        description: skill.description,
        insertText: `/skill:${skill.name} `,
    }));
    slashMenuItems = [...BUILTIN_SLASH_COMMANDS, ...skillCommands].filter(item =>
        item.name.toLowerCase().includes(query) ||
        item.displayName.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
    );

    if (slashMenuItems.length === 0) {
        hideSlashMenu();
        return;
    }

    slashMenuIndex = Math.min(slashMenuIndex, slashMenuItems.length - 1);
    renderSlashMenu(menu);
    menu.style.display = '';
}

function renderSlashMenu(menu: HTMLElement): void {
    menu.innerHTML = slashMenuItems.map((item, i) => {
        const active = i === slashMenuIndex ? ' slash-item-active' : '';
        const desc = item.description
            ? `<span class="slash-item-desc">${escHtml(item.description)}</span>`
            : '';
        return `<div class="slash-item${active}" data-index="${i}">
            <span class="slash-item-name">${escHtml(item.displayName)}</span>
            ${desc}
        </div>`;
    }).join('');

    menu.querySelectorAll('.slash-item').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            selectSlashItem(idx);
        });
    });

    scrollActiveSlashItemIntoView(menu);
}

function scrollActiveSlashItemIntoView(menu: HTMLElement): void {
    const active = menu.querySelector('.slash-item-active') as HTMLElement | null;
    if (!active) return;
    active.scrollIntoView({ block: 'nearest' });
}

function selectSlashItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;

    const item = slashMenuItems[index];
    if (!item) return;

    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (slashMatch) {
        const matchStart = beforeCursor.length - slashMatch[1].length;
        const replacement = item.insertText;
        input.value = text.slice(0, matchStart) + replacement + text.slice(cursorPos);
        const newPos = matchStart + replacement.length;
        input.setSelectionRange(newPos, newPos);
        updateInputHighlights(input);
    }

    hideSlashMenu();
    input.focus();
}

function hideSlashMenu(): void {
    const menu = document.getElementById('slash-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    slashMenuItems = [];
    slashMenuIndex = 0;
}

function isSlashMenuVisible(): boolean {
    const menu = document.getElementById('slash-menu');
    return !!menu && menu.style.display !== 'none' && slashMenuItems.length > 0;
}

// ── Helpers ──

function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function escHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isCompactSlashCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === '/compact' || trimmed.startsWith('/compact ');
}

function getThinkingPreview(text: string): string {
    const firstLine = text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) ?? '';
    return firstLine.replace(/\s+/g, ' ');
}

function formatTimestamp(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildMessageFooter(msg: any, index: number): HTMLElement | null {
    const role = msg.role ?? 'unknown';
    if (role !== 'user' && role !== 'assistant') return null;

    const parts: string[] = [];

    const ts = msg.timestamp;
    if (ts) {
        parts.push(formatTimestamp(ts));
    }

    if (role === 'user') {
        // Show input tokens from the next assistant message's usage
        for (let j = index + 1; j < state.messages.length; j++) {
            const next = state.messages[j];
            if (next.role === 'assistant' && next.usage && next.usage.input > 0) {
                parts.push(`${next.usage.input.toLocaleString()} input tokens`);
                break;
            }
            if (next.role === 'user') break;
        }
    }

    if (role === 'assistant') {
        if (msg._messageEndTime && msg.timestamp) {
            const startMs = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
            const durationSec = (msg._messageEndTime - startMs) / 1000;
            const usage = msg.usage;
            if (usage && usage.output > 0 && durationSec > 0) {
                const tokPerSec = usage.output / durationSec;
                parts.push(`${tokPerSec.toFixed(1)} tok/s`);
            }
        }

        const turnDurationMs = durationNumber(msg._turnDurationMs);
        const totalTurnDurationMs = durationNumber(msg._totalTurnDurationMs);
        if (turnDurationMs > 0) {
            parts.push(`turn ${formatDuration(turnDurationMs)}`);
        }
        if (totalTurnDurationMs > 0) {
            parts.push(`turns total ${formatDuration(totalTurnDurationMs)}`);
        }

        const usage = msg.usage;
        if (usage) {
            parts.push(...formatFullUsageParts(usage));
        }

        const turn = msg._codexTurnUsage;
        if (turn) {
            parts.push(...formatCodexTurnParts(turn));
        }
    }

    if (parts.length === 0) return null;

    const footer = el('div', 'message-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

function formatFullUsageParts(usage: any): string[] {
    const input = usageNumber(usage.input);
    const output = usageNumber(usage.output);
    const cacheRead = usageNumber(usage.cacheRead);
    const cacheWrite = usageNumber(usage.cacheWrite);
    const total = usageNumber(usage.totalTokens, input + output + cacheRead + cacheWrite);

    return [
        `${total.toLocaleString()} total tokens`,
        `${output.toLocaleString()} out`,
        `${input.toLocaleString()} in`,
        `${cacheWrite.toLocaleString()} cache+`,
        `${cacheRead.toLocaleString()} cache-`,
    ];
}

function usageNumber(value: any, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function durationNumber(value: any): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function formatCodexTurnParts(turn: any): string[] {
    if (!turn) return [];
    const parts: string[] = [];
    if (turn.primary) {
        parts.push(`${formatCodexWindow(turn.primary.windowMinutes)} +${turn.primary.deltaPercent.toFixed(1)}%`);
    }
    if (turn.secondary) {
        parts.push(`${formatCodexWindow(turn.secondary.windowMinutes)} +${turn.secondary.deltaPercent.toFixed(1)}%`);
    }
    return parts;
}

function extractThinking(msg: any): string {
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'thinking')
            .map((c: any) => c.thinking ?? c.text ?? '')
            .join('');
    }
    return msg.thinking ?? '';
}

function parseSkillFromUserMessage(text: string): { skillName: string | null; userText: string } {
    const match = text.match(/^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
    if (!match) return { skillName: null, userText: text };
    return { skillName: match[1], userText: match[2]?.trim() ?? '' };
}

function extractText(msg: any): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
    }
    return msg.text ?? '';
}

/** Pattern for file blocks inserted by _augmentTextWithFiles.
 *  Binary files: [File: name] (binary file)\n[/File]\n
 *  Text files:   [File: name]\ncontent\n[/File]\n */
const FILE_BLOCK_RE = /\[File:\s*(.+?)\]\s*(?:\(binary file\))?[\s\S]*?\[\/File\]\s*\n?/g;

/** Pattern for the Plan Mode prefix injected by chat-controller when entering
 *  the PLAN or EXEC phase. Always lives at the very start of the prompt. Keep
 *  in sync with the wrapper tags in chat-controller.ts. */
const PLAN_MODE_BLOCK_RE = /^<plan-mode-instructions>[\s\S]*?<\/plan-mode-instructions>\s*\n?/;

/** Pattern for the agent's plan-complete signal. Matches the marker plus any
 *  surrounding whitespace so the surrounding lines don't end up with a blank
 *  trailing paragraph after stripping. Kept lenient on whitespace and the
 *  optional self-closing slash. */
const PLAN_COMPLETE_MARKER_RE = /\s*<\s*plan-complete\s*\/?\s*>\s*/gi;

interface StrippedFileInfo {
    cleanText: string;
    fileNames: string[];
}

/** Remove [File: name]...[/File] blocks from the text and extract file names. */
function stripFileBlocks(text: string): StrippedFileInfo {
    const fileNames: string[] = [];
    const cleanText = text.replace(FILE_BLOCK_RE, (_, name: string) => {
        fileNames.push(name.trim());
        return '';
    });
    return { cleanText, fileNames };
}

/** Strip the leading <plan-mode-instructions>...</plan-mode-instructions> block
 *  so the chat bubble shows only what the user typed. */
function stripPlanModeBlock(text: string): string {
    return text.replace(PLAN_MODE_BLOCK_RE, '');
}

/** Strip the agent's `<plan-complete/>` completion marker from assistant text
 *  before rendering. The marker is a control signal for the chat controller,
 *  not user-facing content. */
function stripPlanCompleteMarker(text: string): string {
    return text.replace(PLAN_COMPLETE_MARKER_RE, '');
}

function extractImages(msg: any): ImageAttachment[] {
    if (!Array.isArray(msg.content)) return [];
    return msg.content
        .filter((c: any) => c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string')
        .map((c: any) => ({
            type: 'image',
            data: c.data,
            mimeType: c.mimeType,
            name: c.name,
            size: c.size,
            width: c.width,
            height: c.height,
        }));
}

function buildMessageAttachmentChips(images: ImageAttachment[], fileNames: string[]): HTMLElement {
    const container = el('div', 'message-attachments');

    // File chips
    for (const name of fileNames) {
        const isBinary = isBinaryByExtension(name);
        const iconSrc = isBinary ? `${iconsBaseUri}/filebinary.png` : `${iconsBaseUri}/file.png`;
        const label = isBinary ? 'Binary file' : 'Text file';
        const chip = el('span', 'message-attachment-chip');
        chip.innerHTML = `<img class="message-attachment-icon" src="${escAttr(iconSrc)}" alt="${label}"><span class="message-attachment-name">${escHtml(name)}</span>`;
        chip.title = `${label}: ${name}`;
        container.appendChild(chip);
    }

    // Image chips (clickable to toggle preview)
    for (const img of images) {
        const label = img.name || 'Image';
        const src = `data:${img.mimeType};base64,${img.data}`;
        const chip = el('span', 'message-attachment-chip message-attachment-chip--image');
        chip.innerHTML = `<img class="message-attachment-icon" src="${iconsBaseUri}/picture.png" alt="Image"><span class="message-attachment-name">${escHtml(label)}</span>`;
        chip.title = `Click to preview: ${label}`;

        // Hidden preview
        const preview = el('div', 'message-image-preview');
        preview.style.display = 'none';
        const imgEl = document.createElement('img');
        imgEl.className = 'message-image';
        imgEl.src = src;
        imgEl.alt = label;
        preview.appendChild(imgEl);

        chip.addEventListener('click', () => {
            if (preview.style.display === 'none') {
                preview.style.display = 'block';
                chip.classList.add('message-attachment-chip--expanded');
            } else {
                preview.style.display = 'none';
                chip.classList.remove('message-attachment-chip--expanded');
            }
        });

        container.appendChild(chip);
        container.appendChild(preview);
    }

    return container;
}

function buildMessageImageGrid(images: ImageAttachment[]): HTMLElement {
    const grid = el('div', 'message-images');
    for (const img of images) {
        const src = `data:${img.mimeType};base64,${img.data}`;
        const imageEl = document.createElement('img');
        imageEl.className = 'message-image';
        imageEl.src = src;
        imageEl.alt = img.name ?? 'Attached image';
        imageEl.title = img.name ?? 'Attached image';
        grid.appendChild(imageEl);
    }
    return grid;
}

function buildMessageFileChips(fileNames: string[]): HTMLElement {
    const container = el('div', 'message-files');
    for (const name of fileNames) {
        const isBinary = isBinaryByExtension(name);
        const iconSrc = isBinary ? `${iconsBaseUri}/filebinary.png` : `${iconsBaseUri}/file.png`;
        const label = isBinary ? 'Binary file' : 'Text file';
        const chip = el('span', 'message-file-chip');
        chip.innerHTML = `<img class="message-file-icon" src="${escAttr(iconSrc)}" alt="${label}"><span class="message-file-name">${escHtml(name)}</span>`;
        chip.title = `${label}: ${name}`;
        container.appendChild(chip);
    }
    return container;
}

function formatTokenCount(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

function tryParseJSON(s: string): any {
    try { return JSON.parse(s); } catch { return s; }
}

let userHasScrolled = false;
let isProgrammaticScroll = false;

function scrollToBottom(force = false): void {
    if (userHasScrolled && !force) return;
    const messages = document.getElementById('messages');
    if (messages) {
        isProgrammaticScroll = true;
        messages.scrollTop = messages.scrollHeight;
    }
}

function isNearBottom(): boolean {
    const messages = document.getElementById('messages');
    if (!messages) return true;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
}

function updateScrollButton(): void {
    const btn = document.getElementById('btn-scroll-bottom');
    if (!btn) return;
    if (userHasScrolled) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
}

function bindScrollListener(): void {
    const messages = document.getElementById('messages');
    if (!messages) return;

    // Detect user-initiated scroll intent immediately
    messages.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
            userHasScrolled = true;
            updateScrollButton();
        }
    }, { passive: true });

    messages.addEventListener('touchstart', () => {
        userHasScrolled = true;
        updateScrollButton();
    }, { passive: true });

    // The scroll event handles resetting when user reaches bottom
    messages.addEventListener('scroll', () => {
        if (isProgrammaticScroll) {
            isProgrammaticScroll = false;
            return;
        }
        if (isNearBottom()) {
            userHasScrolled = false;
        }
        updateScrollButton();
    });
}

// ── Init ──
render();

// Proactively request state — the 'ready' message from the extension may
// have been posted before this script loaded, so don't rely on it.
vscode.postMessage({ type: 'getState' });
vscode.postMessage({ type: 'getSkills' });
