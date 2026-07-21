import { requestInitialAgentState } from '../../../src/shared/agent-connection-client';
import type {
    AgentClientMessage,
    FileChangeInfo,
    ModelInfo,
    SerializedAgentState,
    SessionInfo,
} from '../../../src/shared/agent-protocol';
import type { AgentEventEnvelope } from '../../../src/shared/connection-protocol';
import type {
    DesktopPreloadApi,
    DesktopShellResponse,
    DesktopShellState,
} from '../src/ipc-contract';
import { DesktopAgentConnection } from '../src/renderer-connection';
import {
    applyAgentEvent,
    applyStateSnapshot,
    createLivePresentation,
    getTodoProgress,
    getVisibleTools,
    projectFeedItems,
    resolveComposerAction,
    resolveNewWindowControl,
    THINKING_LEVELS,
    type FeedItem,
    type LivePresentation,
    type RendererSnapshotSelection,
} from './presentation';

declare global {
    interface Window {
        piCode?: DesktopPreloadApi;
    }
}

const welcomeView = requiredElement<HTMLElement>('welcome-view');
const workspaceView = requiredElement<HTMLElement>('workspace-view');
const status = requiredElement<HTMLElement>('status');
const details = requiredElement<HTMLElement>('details');
const actions = requiredElement<HTMLElement>('actions');
const openWorkspaceButton = requiredElement<HTMLButtonElement>('open-workspace');
const newWindowButton = requiredElement<HTMLButtonElement>('new-window');
const composer = requiredElement<HTMLTextAreaElement>('composer');
const feed = requiredElement<HTMLElement>('feed');
const feedItems = requiredElement<HTMLElement>('feed-items');
const liveItems = requiredElement<HTMLElement>('live-items');
const sendButton = requiredElement<HTMLButtonElement>('send-command');
const stopButton = requiredElement<HTMLButtonElement>('stop-command');
const toast = requiredElement<HTMLElement>('toast');
const modelSelect = requiredElement<HTMLSelectElement>('model-select');
const thinkingSelect = requiredElement<HTMLSelectElement>('thinking-select');

let agentConnection: DesktopAgentConnection | undefined;
let closeAgentSubscription: (() => void) | undefined;
let selection: RendererSnapshotSelection | undefined;
let attemptedSuggestedWorkspace = false;
let commandPending = false;
let workspacePath = '';
let models: ModelInfo[] = [];
let sessions: SessionInfo[] = [];
let liveByTab: Record<string, LivePresentation> = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let shellPhase: DesktopShellState['phase'] = 'welcome';
let agentReady = false;
let newWindowLaunchPending = false;
let panelOpen = localStorage.getItem('pi-code.desktop.panel-open') !== 'false';
let playSound = localStorage.getItem('pi-code.desktop.play-sound') !== 'false';
let todoCollapsed = false;
let subagentsCollapsed = false;
let toolFilter = '';
let clockTimer: ReturnType<typeof setInterval> | undefined;

const api = window.piCode;
initializeCrtPreference();
applyPanelState();
updateClock();
clockTimer = setInterval(updateClock, 1_000);
bindStaticEvents();

if (!api) {
    showWelcome('PRELOAD BRIDGE OFFLINE', 'The sandboxed desktop bridge was not installed.', false);
} else {
    const closeShellSubscription = api.subscribeShell(applyShellState);
    void api.getLaunchState().then(applyShellResponse);
    window.addEventListener('pagehide', () => {
        closeShellSubscription();
        closeAgentSubscription?.();
        if (clockTimer) clearInterval(clockTimer);
        void agentConnection?.close();
    }, { once: true });
}

function bindStaticEvents(): void {
    openWorkspaceButton.addEventListener('click', () => {
        if (!api) return;
        showWelcome('SELECTING WORKSPACE', '', true);
        void api.selectWorkspace().then(applyShellResponse);
    });
    newWindowButton.addEventListener('click', openNewWindow);
    requiredElement<HTMLButtonElement>('rail-new-window').addEventListener('click', openNewWindow);
    requiredElement<HTMLButtonElement>('new-chat').addEventListener('click', () => {
        playUiBeep(760);
        void createTab();
    });
    requiredElement<HTMLButtonElement>('panel-toggle').addEventListener('click', () => {
        panelOpen = !panelOpen;
        localStorage.setItem('pi-code.desktop.panel-open', String(panelOpen));
        applyPanelState();
        playUiBeep(560);
    });
    requiredElement<HTMLButtonElement>('refresh-history').addEventListener('click', () => void refreshSessions());
    requiredElement<HTMLButtonElement>('crt-level').addEventListener('click', cycleCrtLevel);
    requiredElement<HTMLButtonElement>('cache-mode').addEventListener('click', cycleCacheMode);
    requiredElement<HTMLButtonElement>('plan-mode-toggle').addEventListener('click', () => void togglePlanMode());
    requiredElement<HTMLButtonElement>('file-undo-toggle').addEventListener('click', () => void toggleFileUndoView());
    requiredElement<HTMLButtonElement>('file-undo-action').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void applyFileUndoAction();
    });
    requiredElement<HTMLButtonElement>('todo-enabled-toggle').addEventListener('click', () => void toggleTodo());
    requiredElement<HTMLButtonElement>('subagents-enabled-toggle').addEventListener('click', () => void toggleSubagents());
    requiredElement<HTMLButtonElement>('play-sound-toggle').addEventListener('click', () => {
        playSound = !playSound;
        localStorage.setItem('pi-code.desktop.play-sound', String(playSound));
        renderSidebar();
        playUiBeep(620);
    });
    requiredElement<HTMLButtonElement>('todo-collapse').addEventListener('click', () => {
        todoCollapsed = !todoCollapsed;
        renderSidebar();
    });
    requiredElement<HTMLButtonElement>('subagents-collapse').addEventListener('click', () => {
        subagentsCollapsed = !subagentsCollapsed;
        renderSidebar();
    });
    requiredElement<HTMLInputElement>('tool-filter').addEventListener('input', (event) => {
        toolFilter = (event.currentTarget as HTMLInputElement).value;
        renderTools();
    });
    requiredElement<HTMLButtonElement>('enable-all-tools').addEventListener('click', () => void setAllTools(false));
    requiredElement<HTMLButtonElement>('disable-all-tools').addEventListener('click', () => void setAllTools(true));

    sendButton.addEventListener('click', () => void submitComposer(false));
    stopButton.addEventListener('click', () => void dispatchAbort());
    requiredElement<HTMLButtonElement>('scroll-latest').addEventListener('click', () => scrollToLatest(true));
    composer.addEventListener('input', () => {
        resizeComposer();
        updateComposerControls();
    });
    composer.addEventListener('keydown', (event) => {
        const state = activeState();
        const action = resolveComposerAction({
            key: event.key,
            shiftKey: event.shiftKey,
            modifierKey: event.ctrlKey || event.metaKey,
            isBusy: Boolean(state?.isStreaming || state?.isCompacting),
            hasText: composer.value.trim().length > 0,
        });
        if (action === 'newline' || action === 'none') return;
        event.preventDefault();
        if (action === 'abort') void dispatchAbort();
        else void submitComposer(action === 'steer');
    });
    feed.addEventListener('scroll', updateScrollButton, { passive: true });
    modelSelect.addEventListener('change', () => void setSelectedModel());
    thinkingSelect.addEventListener('change', () => void setThinkingLevel());
}

function applyShellResponse(response: DesktopShellResponse): void {
    applyShellState(response.state);
    if (!response.ok) showToast(response.error.message, true);
}

function applyShellState(state: DesktopShellState): void {
    shellPhase = state.phase;
    if (state.phase !== 'ready') agentReady = false;
    updateNewWindowControls();
    switch (state.phase) {
        case 'welcome':
            showWelcome(
                'SELECT A WORKSPACE',
                state.secureStorageAvailable === false
                    ? 'Open a trusted project to start. Secure credential storage is unavailable; plaintext storage is disabled.'
                    : 'Open a trusted project to start Pi Code Terminal.',
                false,
            );
            if (state.suggestedWorkspace && !attemptedSuggestedWorkspace && api) {
                attemptedSuggestedWorkspace = true;
                setWelcomeActionsDisabled(true);
                void api.openWorkspace(state.suggestedWorkspace).then(applyShellResponse);
            }
            break;
        case 'opening':
            showWelcome('INITIALIZING AGENT HOST', state.workspacePath, true);
            break;
        case 'ready':
            workspacePath = state.workspacePath;
            welcomeView.hidden = true;
            workspaceView.hidden = false;
            requiredElement<HTMLElement>('workspace-name').textContent = workspaceBasename(state.workspacePath);
            requiredElement<HTMLElement>('workspace-name').title = state.workspacePath;
            setConnectionStatus('CONNECTING', 'pending');
            connectAgent();
            break;
        case 'error':
            showWelcome('WORKSPACE FAILED TO OPEN', state.message, false);
            break;
    }
}

function showWelcome(title: string, detail: string, busy: boolean): void {
    welcomeView.hidden = false;
    workspaceView.hidden = true;
    status.textContent = title;
    details.textContent = detail;
    actions.hidden = false;
    openWorkspaceButton.hidden = false;
    setWelcomeActionsDisabled(busy);
}

function setWelcomeActionsDisabled(disabled: boolean): void {
    openWorkspaceButton.disabled = disabled;
    newWindowButton.disabled = disabled;
}

function openNewWindow(): void {
    if (!api || newWindowLaunchPending || !resolveNewWindowControl({
        shellPhase,
        agentReady,
        launchPending: false,
    }).visible) return;
    newWindowLaunchPending = true;
    updateNewWindowControls();
    void api.newWindow().then((response) => {
        if (!response.ok) showToast(response.error.message, true);
    }).finally(() => {
        newWindowLaunchPending = false;
        updateNewWindowControls();
    });
}

function connectAgent(): void {
    if (!api || agentConnection) return;
    const connection = new DesktopAgentConnection(api);
    agentConnection = connection;
    closeAgentSubscription = connection.subscribe(handleAgentEnvelope);
    void requestInitialAgentState(connection).then(async (response) => {
        if (!response.ok) {
            agentReady = false;
            updateNewWindowControls();
            setConnectionStatus('HOST UNAVAILABLE', 'error');
            showToast(response.error.message, true);
            return;
        }
        agentReady = true;
        updateNewWindowControls();
        setConnectionStatus('HOST ONLINE', 'online');
        await Promise.all([refreshModels(), refreshSessions()]);
    });
}

function handleAgentEnvelope(envelope: AgentEventEnvelope): void {
    const payload = envelope.payload as Record<string, unknown>;
    if (envelope.type === 'stateSync') {
        const snapshot = payload.state as SerializedAgentState;
        selection = applyStateSnapshot(selection, envelope.tabId, snapshot);
        const ownerTabId = envelope.tabId ?? snapshot.activeTabId;
        if (ownerTabId) {
            liveByTab = { ...liveByTab, [ownerTabId]: createLivePresentation(snapshot) };
        }
        agentReady = true;
        updateNewWindowControls();
        setConnectionStatus('HOST ONLINE', 'online');
        renderAgentState();
        return;
    }

    if (envelope.type === 'turnCompleted') {
        playUiBeep(740);
        return;
    }

    if (envelope.type === 'agentEvent') {
        const ownerTabId = envelope.tabId ?? selection?.activeTabId;
        if (!ownerTabId) return;
        const previous = liveByTab[ownerTabId]
            ?? createLivePresentation(selection?.snapshots[ownerTabId] ?? emptySnapshot());
        liveByTab = {
            ...liveByTab,
            [ownerTabId]: applyAgentEvent(previous, payload.event, Date.now()),
        };
        if (ownerTabId === selection?.activeTabId) renderLiveActivity();
        return;
    }

    if (envelope.type === 'models') {
        models = (payload.models as ModelInfo[] | undefined) ?? [];
        const current = payload.current as ModelInfo | undefined;
        if (current) updateVisibleSnapshot({ model: current });
        if (typeof payload.thinkingLevel === 'string') {
            updateVisibleSnapshot({ thinkingLevel: payload.thinkingLevel });
        }
        renderModelControls();
        return;
    }

    if (envelope.type === 'modelChanged') {
        const model = payload.model as ModelInfo;
        updateVisibleSnapshot({
            model,
            ...(typeof payload.thinkingLevel === 'string'
                ? { thinkingLevel: payload.thinkingLevel }
                : {}),
        });
        renderModelControls();
        renderStatusBar();
        return;
    }

    if (envelope.type === 'sessions') {
        sessions = (payload.sessions as SessionInfo[] | undefined) ?? [];
        renderSessions();
        return;
    }

    if (envelope.type === 'fileChange') {
        appendFileChange(payload.change as FileChangeInfo, envelope.tabId);
        return;
    }

    if (envelope.type === 'error') {
        showToast(String(payload.message ?? 'Unknown agent error'), payload.severity !== 'info');
    }
}

async function sendAgentCommand(
    message: AgentClientMessage,
    tabId = selection?.activeTabId,
    options: { refresh?: boolean; pendingLabel?: string } = {},
): Promise<boolean> {
    if (!agentConnection) {
        showToast('Agent host is not connected.', true);
        return false;
    }
    commandPending = true;
    requiredElement<HTMLElement>('command-state').textContent = options.pendingLabel ?? 'WORKING';
    updateComposerControls();
    try {
        const response = await agentConnection.request(message, tabId ? { tabId } : undefined);
        if (!response.ok) {
            showToast(response.error.message, true);
            return false;
        }
        if (options.refresh) await refreshState(tabId);
        return true;
    } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), true);
        return false;
    } finally {
        commandPending = false;
        updateComposerControls();
        renderStatusBar();
    }
}

async function refreshState(tabId?: string): Promise<void> {
    if (!agentConnection) return;
    const response = await agentConnection.request({ type: 'getState' }, tabId ? { tabId } : undefined);
    if (!response.ok) showToast(response.error.message, true);
}

async function createTab(): Promise<void> {
    if (await sendAgentCommand({ type: 'createTab' }, selection?.activeTabId, { pendingLabel: 'CREATING TAB' })) {
        await refreshState();
    }
}

async function switchTab(tabId: string, focusAfterSwitch = false): Promise<void> {
    if (tabId === selection?.activeTabId) return;
    const previousTabId = selection?.activeTabId;
    if (await sendAgentCommand({ type: 'switchTab', tabId }, previousTabId, { pendingLabel: 'SWITCHING TAB' })) {
        await refreshState(tabId);
        if (focusAfterSwitch) document.getElementById(tabButtonId(tabId))?.focus();
    }
}

async function closeTab(tabId: string): Promise<void> {
    if (await sendAgentCommand({ type: 'closeTab', tabId }, selection?.activeTabId, { pendingLabel: 'CLOSING TAB' })) {
        const snapshots = { ...(selection?.snapshots ?? {}) };
        delete snapshots[tabId];
        if (selection) selection = { ...selection, snapshots };
        await refreshState();
    }
}

async function submitComposer(forceSteer: boolean): Promise<void> {
    const text = composer.value.trim();
    const state = activeState();
    const tabId = selection?.activeTabId;
    if (!text || !state || !tabId || commandPending) return;

    const isBusy = state.isStreaming || state.isCompacting;
    const message: AgentClientMessage = forceSteer && isBusy
        ? { type: 'steer', text }
        : isBusy
            ? { type: 'queueMessage', text }
            : { type: 'prompt', text };
    const accepted = await sendAgentCommand(message, tabId, {
        refresh: message.type === 'queueMessage',
        pendingLabel: message.type === 'steer' ? 'STEERING' : message.type === 'queueMessage' ? 'QUEUEING' : 'SENDING',
    });
    if (!accepted) return;
    composer.value = '';
    resizeComposer();
    updateComposerControls();
    composer.focus();
}

async function dispatchAbort(): Promise<void> {
    const state = activeState();
    if (!state || (!state.isStreaming && !state.isCompacting)) return;
    await sendAgentCommand({ type: 'abort' }, selection?.activeTabId, { pendingLabel: 'STOPPING' });
}

async function refreshModels(): Promise<void> {
    await sendAgentCommand({ type: 'getModels' }, selection?.activeTabId, { pendingLabel: 'LOADING MODELS' });
}

async function refreshSessions(): Promise<void> {
    await sendAgentCommand({ type: 'getSessions' }, selection?.activeTabId, { pendingLabel: 'LOADING HISTORY' });
}

async function setSelectedModel(): Promise<void> {
    const separator = modelSelect.value.indexOf('\u0000');
    if (separator < 0) return;
    const provider = modelSelect.value.slice(0, separator);
    const modelId = modelSelect.value.slice(separator + 1);
    await sendAgentCommand({ type: 'setModel', provider, modelId }, selection?.activeTabId, {
        refresh: true,
        pendingLabel: 'CHANGING MODEL',
    });
}

async function setThinkingLevel(): Promise<void> {
    if (!thinkingSelect.value) return;
    await sendAgentCommand({ type: 'setThinkingLevel', level: thinkingSelect.value }, selection?.activeTabId, {
        refresh: true,
        pendingLabel: 'CHANGING THINKING',
    });
}

async function cycleCacheMode(): Promise<void> {
    const state = activeState();
    if (!state) return;
    const modes = ['auto', 'short', 'long'] as const;
    const currentIndex = modes.indexOf(state.cacheMode ?? 'auto');
    const mode = modes[(currentIndex + 1) % modes.length];
    await sendAgentCommand({ type: 'setCacheMode', mode }, selection?.activeTabId, {
        refresh: true,
        pendingLabel: 'CHANGING CACHE',
    });
}

async function togglePlanMode(): Promise<void> {
    const controls = activeState()?.controls;
    if (!controls || controls.planModeToggleDisabled) return;
    playUiBeep(600);
    await sendAgentCommand(
        { type: 'setPlanModeEnabled', enabled: !controls.planModeEnabled },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UPDATING PLAN MODE' },
    );
}

async function toggleFileUndoView(): Promise<void> {
    const state = activeState();
    if (!state) return;
    playUiBeep(600);
    await sendAgentCommand(
        { type: 'setFileUndoViewEnabled', enabled: !state.fileUndoViewEnabled },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UPDATING FILE UNDO' },
    );
}

async function toggleTodo(): Promise<void> {
    const controls = activeState()?.controls;
    if (!controls || controls.todoToggleDisabled) return;
    playUiBeep(600);
    await sendAgentCommand(
        { type: 'setTodoEnabled', enabled: !controls.todoEnabled },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UPDATING TODO' },
    );
}

async function toggleSubagents(): Promise<void> {
    const controls = activeState()?.controls;
    if (!controls || controls.subagents.toggleDisabled) return;
    playUiBeep(600);
    await sendAgentCommand(
        { type: 'setSubagentsEnabled', enabled: !controls.subagents.enabled },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UPDATING SUBAGENTS' },
    );
}

async function setAllTools(disable: boolean): Promise<void> {
    const controls = activeState()?.controls;
    if (!controls || controls.toolSelection.toggleDisabled) return;
    const disabled = disable
        ? controls.toolSelection.registered.map((tool) => tool.name)
        : [];
    playUiBeep(disable ? 440 : 680);
    await sendAgentCommand(
        { type: 'setToolsBulk', disabled },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UPDATING TOOLS' },
    );
}

async function toggleTool(toolName: string, enabled: boolean): Promise<void> {
    const controls = activeState()?.controls;
    if (!controls || controls.toolSelection.toggleDisabled) return;
    playUiBeep(enabled ? 440 : 680);
    await sendAgentCommand(
        { type: 'setToolDisabled', toolName, disabled: enabled },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UPDATING TOOL' },
    );
}

function applyPanelState(): void {
    workspaceView.classList.toggle('panel-collapsed', !panelOpen);
    const button = document.getElementById('panel-toggle');
    if (button) {
        button.textContent = panelOpen ? '◀' : '▶';
        button.setAttribute('aria-expanded', String(panelOpen));
    }
}

function updateClock(): void {
    const clock = document.getElementById('terminal-clock');
    if (!clock) return;
    clock.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
}

function playUiBeep(frequency: number): void {
    if (!playSound) return;
    try {
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'square';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.025, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.045);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.05);
        oscillator.addEventListener('ended', () => void audio.close(), { once: true });
    } catch {
        // Audio is optional and may be blocked until the renderer receives user activation.
    }
}

function renderAgentState(): void {
    const shouldFollow = isNearFeedBottom();
    renderTabs();
    renderFeed();
    renderLiveActivity();
    renderSidebar();
    renderFileUndoBar();
    renderQueue();
    renderModelControls();
    renderStatusBar();
    updateComposerControls();
    if (shouldFollow) scrollToLatest(false);
    else updateScrollButton();
}

function renderTabs(): void {
    const list = requiredElement<HTMLElement>('tab-list');
    list.replaceChildren();
    const tabs = selection?.tabs ?? [];
    for (const [index, tab] of tabs.entries()) {
        const isActive = tab.id === selection?.activeTabId;
        const container = document.createElement('div');
        container.className = `chat-tab${isActive ? ' is-active' : ''}${tab.isStreaming ? ' is-streaming' : ''}`;

        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.id = tabButtonId(tab.id);
        selectButton.className = 'chat-tab-select';
        selectButton.title = tab.name;
        selectButton.setAttribute('role', 'tab');
        selectButton.setAttribute('aria-selected', String(isActive));
        selectButton.setAttribute('aria-controls', 'feed');
        selectButton.tabIndex = isActive ? 0 : -1;
        selectButton.addEventListener('click', () => void switchTab(tab.id));
        selectButton.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const offset = event.key === 'ArrowRight' ? 1 : -1;
            const target = tabs[(index + offset + tabs.length) % tabs.length];
            if (target) void switchTab(target.id, true);
        });
        selectButton.append(
            textSpan('tab-glyph', tab.isStreaming ? '◌' : 'π'),
            textSpan('tab-title', tab.name),
        );
        if (tab.hasNotification) selectButton.appendChild(textSpan('tab-notification', ''));
        container.appendChild(selectButton);

        if (tabs.length > 1) {
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'tab-close';
            close.title = `Close ${tab.name}`;
            close.setAttribute('aria-label', `Close ${tab.name}`);
            close.textContent = '×';
            close.addEventListener('click', () => void closeTab(tab.id));
            container.appendChild(close);
        }
        list.appendChild(container);
    }
    const activeTabId = selection?.activeTabId;
    if (activeTabId) feed.setAttribute('aria-labelledby', tabButtonId(activeTabId));
    else feed.removeAttribute('aria-labelledby');
}

function renderFeed(): void {
    feedItems.replaceChildren();
    const state = activeState();
    if (!state) {
        feedItems.appendChild(emptyFeed('SYNCHRONIZING SESSION', 'Waiting for the first authoritative state snapshot.'));
        return;
    }

    if (state.interruptedTurn) {
        feedItems.appendChild(errorBlock('⚠ PREVIOUS TURN INTERRUPTED — no prompt or tool was replayed.'));
    }

    const items = projectFeedItems(state);
    if (items.length === 0 && (state.fileChanges?.length ?? 0) === 0 && !state.isStreaming) {
        feedItems.appendChild(emptyFeed('PI CODE TERMINAL READY', 'Send a prompt to begin an isolated workspace turn.'));
    } else {
        for (const item of items) feedItems.appendChild(renderFeedItem(item));
    }

    for (const change of state.fileChanges ?? []) {
        feedItems.appendChild(renderDiffCard(change));
    }
}

function renderFeedItem(item: FeedItem): HTMLElement {
    if (item.kind === 'user') {
        const content = textSpan('row-content', item.text);
        if (item.timestamp) content.appendChild(textSpan('row-meta', formatTime(item.timestamp)));
        return terminalRow('USER', content, 'is-user');
    }
    if (item.kind === 'error') {
        return terminalRow('', textSpan('row-content', `✖ ${item.text}`), 'is-error');
    }
    if (item.kind === 'compaction') {
        const detailsElement = document.createElement('details');
        detailsElement.className = 'thinking-details';
        const summary = document.createElement('summary');
        summary.textContent = `◇ CONTEXT COMPACTED${item.meta ? ` · ${item.meta}` : ''}`;
        detailsElement.append(summary, textPre('detail-output', item.text));
        return terminalRow('', detailsElement);
    }
    if (item.kind === 'tool') {
        const detailsElement = document.createElement('details');
        detailsElement.className = 'tool-details';
        detailsElement.open = item.isError === true;
        const summary = document.createElement('summary');
        summary.textContent = `${item.isError ? '✖' : '⌁'} ${item.title ?? 'Tool result'}`;
        if (item.text) detailsElement.appendChild(textPre('detail-output', item.text));
        return terminalRow('', detailsElement, item.isError ? 'is-error' : '');
    }

    const content = document.createElement('div');
    content.className = 'row-content';
    if (item.thinking) {
        const thinking = document.createElement('details');
        thinking.className = 'thinking-details';
        const summary = document.createElement('summary');
        summary.textContent = '◉ THOUGHT';
        thinking.append(summary, textPre('detail-output', item.thinking));
        content.appendChild(thinking);
    }
    if (item.text) content.appendChild(textDiv('', item.text));
    if (item.timestamp) content.appendChild(textSpan('row-meta', formatTime(item.timestamp)));
    return terminalRow('', content);
}

function renderLiveActivity(): void {
    liveItems.replaceChildren();
    const state = activeState();
    const tabId = selection?.activeTabId;
    if (!state || !tabId) return;
    const live = liveByTab[tabId] ?? createLivePresentation(state);

    for (const tool of Object.values(live.tools)) {
        const detailsElement = document.createElement('details');
        detailsElement.className = 'tool-details';
        detailsElement.open = tool.status === 'error';
        const summary = document.createElement('summary');
        summary.className = tool.status === 'running' ? 'status-running' : tool.status === 'error' ? 'status-error' : '';
        summary.textContent = `${tool.status === 'running' ? '◌' : tool.status === 'error' ? '✖' : '⌁'} ${tool.label}`;
        if (tool.output) detailsElement.appendChild(textPre('detail-output', tool.output));
        liveItems.appendChild(terminalRow('', detailsElement));
    }

    if (live.streamingThinking) {
        const thinking = document.createElement('details');
        thinking.className = 'thinking-details';
        thinking.open = live.isThinking;
        const summary = document.createElement('summary');
        summary.className = live.isThinking ? 'status-running' : '';
        summary.textContent = live.isThinking ? '◉ THINKING…' : '◉ THOUGHT';
        thinking.append(summary, textPre('detail-output', live.streamingThinking));
        liveItems.appendChild(terminalRow('', thinking));
    }
    if (live.streamingText) {
        liveItems.appendChild(terminalRow('', textSpan('row-content', live.streamingText)));
    } else if (state.isStreaming && Object.keys(live.tools).length === 0 && !live.streamingThinking) {
        liveItems.appendChild(terminalRow('', textSpan('row-content status-running', '◌ PREPARING NEXT MOVE…')));
    } else if (state.isCompacting) {
        liveItems.appendChild(terminalRow('', textSpan('row-content status-running', '◇ COMPACTING CONTEXT…')));
    }
}

function renderSidebar(): void {
    const state = activeState();
    const controls = state?.controls;
    setToggle('plan-mode-toggle', controls?.planModeEnabled ?? false, !controls || controls.planModeToggleDisabled);
    setToggle(
        'file-undo-toggle',
        state?.fileUndoViewEnabled ?? false,
        !state || Boolean(state.isStreaming || state.isCompacting),
    );
    setToggle('play-sound-toggle', playSound, false);
    setToggle('todo-enabled-toggle', controls?.todoEnabled ?? false, !controls || controls.todoToggleDisabled);
    setToggle('subagents-enabled-toggle', controls?.subagents.enabled ?? false, !controls || controls.subagents.toggleDisabled);

    const todoTitle = requiredElement<HTMLButtonElement>('todo-collapse');
    todoTitle.textContent = `${todoCollapsed ? '▸' : '▾'} TODO`;
    todoTitle.setAttribute('aria-expanded', String(!todoCollapsed));
    todoTitle.disabled = !controls?.todoEnabled;
    const todoList = requiredElement<HTMLElement>('todo-list');
    todoList.hidden = todoCollapsed || !controls?.todoEnabled;
    todoList.replaceChildren();
    const progress = controls ? getTodoProgress(controls.todos) : { completed: 0, total: 0 };
    requiredElement<HTMLElement>('todo-progress').textContent = `${progress.completed}/${progress.total}`;
    const tasks = controls?.todos.tasks.filter((task) => task.status !== 'deleted') ?? [];
    if (tasks.length === 0) {
        todoList.className = 'panel-list todo-list pb-scroll empty-copy';
        todoList.textContent = 'No tasks yet.';
    } else {
        todoList.className = 'panel-list todo-list pb-scroll';
        for (const task of tasks) {
            const row = document.createElement('div');
            row.className = `todo-row${task.status === 'completed' ? ' is-completed' : ''}${task.status === 'in_progress' ? ' is-active' : ''}`;
            row.title = task.description ?? task.subject;
            row.append(
                textSpan('todo-mark', task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '•' : '○'),
                textSpan('todo-subject', task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject),
                textSpan('todo-badge', `#${task.id}`),
            );
            todoList.appendChild(row);
        }
    }

    const subTitle = requiredElement<HTMLButtonElement>('subagents-collapse');
    subTitle.textContent = `${subagentsCollapsed ? '▸' : '▾'} SUBAGENTS`;
    subTitle.setAttribute('aria-expanded', String(!subagentsCollapsed));
    subTitle.disabled = !controls?.subagents.enabled;
    requiredElement<HTMLElement>('subagent-count').textContent = controls
        ? String(controls.subagents.activeCount + controls.subagents.queuedCount)
        : '0';
    const subList = requiredElement<HTMLElement>('subagent-list');
    subList.hidden = subagentsCollapsed || !controls?.subagents.enabled;
    subList.replaceChildren();
    if (!controls?.subagents.runs.length) {
        subList.className = 'panel-list empty-copy';
        subList.textContent = 'No subagent runs yet.';
    } else {
        subList.className = 'panel-list';
        for (const run of controls.subagents.runs) {
            const row = document.createElement('div');
            row.className = 'subagent-row';
            const head = document.createElement('div');
            head.className = 'subagent-head';
            head.append(
                textSpan('subagent-name', run.name),
                textSpan(`subagent-status${run.status === 'failed' ? ' is-failed' : ''}`, run.status),
            );
            row.append(head, textDiv('subagent-meta', run.activity ?? run.currentTool ?? run.taskPreview));
            subList.appendChild(row);
        }
    }
    renderTools();
}

function renderTools(): void {
    const controls = activeState()?.controls;
    const list = requiredElement<HTMLElement>('tools-list');
    list.replaceChildren();
    const tools = controls ? getVisibleTools(controls.toolSelection, toolFilter) : [];
    const enabledCount = controls
        ? controls.toolSelection.registered.filter((tool) => !controls.toolSelection.disabled.includes(tool.name)).length
        : 0;
    const totalCount = controls?.toolSelection.registered.length ?? 0;
    requiredElement<HTMLElement>('tools-section-count').textContent = `${enabledCount}/${totalCount}`;
    requiredElement<HTMLButtonElement>('enable-all-tools').disabled = !controls || controls.toolSelection.toggleDisabled;
    requiredElement<HTMLButtonElement>('disable-all-tools').disabled = !controls || controls.toolSelection.toggleDisabled;
    if (tools.length === 0) {
        list.className = 'panel-list tool-list empty-copy';
        list.textContent = totalCount > 0 ? 'No matching tools.' : 'No tools reported.';
        return;
    }
    list.className = 'panel-list tool-list';
    for (const tool of tools) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `tool-row${tool.enabled ? ' is-enabled' : ''}`;
        row.disabled = controls?.toolSelection.toggleDisabled ?? true;
        row.append(
            textSpan('tool-check', tool.enabled ? '✓' : ''),
            textSpan('tool-name', tool.name),
        );
        row.addEventListener('click', () => void toggleTool(tool.name, tool.enabled));
        list.appendChild(row);
    }
}

function setToggle(buttonId: string, enabled: boolean, disabled: boolean): void {
    const button = requiredElement<HTMLButtonElement>(buttonId);
    button.disabled = disabled;
    button.setAttribute('aria-pressed', String(enabled));
    button.querySelector('.square-toggle')?.classList.toggle('is-on', enabled);
}

async function applyFileUndoAction(): Promise<void> {
    const state = activeState();
    if (!state || state.isStreaming || state.isCompacting) return;
    if (state.rollbackPoint !== null && state.rollbackPoint !== undefined) {
        await sendAgentCommand(
            { type: 'redoCheckpoint' },
            selection?.activeTabId,
            { refresh: true, pendingLabel: 'REDOING CHANGES' },
        );
        return;
    }
    const userTurns = state.messages.filter((message) => message?.role === 'user').length;
    if (userTurns < 1 || !(state.fileChanges?.length)) return;
    await sendAgentCommand(
        { type: 'restoreCheckpoint', messageIndex: userTurns - 1 },
        selection?.activeTabId,
        { refresh: true, pendingLabel: 'UNDOING CHANGES' },
    );
}

function renderFileUndoBar(): void {
    const state = activeState();
    const bar = requiredElement<HTMLDetailsElement>('file-undo-bar');
    const changes = state?.fileChanges ?? [];
    const hasRedo = state?.rollbackPoint !== null && state?.rollbackPoint !== undefined;
    bar.hidden = !state?.fileUndoViewEnabled || (changes.length === 0 && !hasRedo);
    if (bar.hidden) return;

    const unique = new Map<string, FileChangeInfo>();
    for (const change of changes) unique.set(change.filePath, change);
    requiredElement<HTMLElement>('file-undo-summary').textContent = hasRedo
        ? 'CHANGES UNDONE'
        : `${unique.size} FILE${unique.size === 1 ? '' : 'S'}`;
    const action = requiredElement<HTMLButtonElement>('file-undo-action');
    action.textContent = hasRedo ? 'REDO' : 'UNDO';
    action.disabled = Boolean(state?.isStreaming || state?.isCompacting || (!hasRedo && unique.size === 0));
    action.title = action.disabled ? 'Wait for the active turn to finish' : `${action.textContent} last turn changes`;

    const list = requiredElement<HTMLElement>('file-undo-list');
    list.replaceChildren();
    for (const change of unique.values()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'file-undo-item';
        item.title = change.filePath;
        item.append(
            textSpan('file-undo-name', change.filePath.split(/[\\/]/).pop() ?? change.filePath),
            textSpan('file-undo-stat', `+${change.addedLines}/−${change.removedLines}`),
        );
        item.addEventListener('click', () => {
            document.getElementById(`diff-${safeDomId(change.toolCallId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        list.appendChild(item);
    }
}

function renderQueue(): void {
    const strip = requiredElement<HTMLElement>('queue-strip');
    const queue = activeState()?.queuedMessages ?? [];
    strip.hidden = queue.length === 0;
    strip.replaceChildren();
    queue.forEach((text, index) => {
        const row = document.createElement('div');
        row.className = 'queue-row';
        row.append(
            textSpan('queue-index', `Q${index + 1}`),
            textSpan('queue-text', text),
        );
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'queue-remove';
        remove.title = 'Remove queued prompt';
        remove.setAttribute('aria-label', `Remove queued prompt ${index + 1}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => void sendAgentCommand(
            { type: 'removeQueuedMessage', index },
            selection?.activeTabId,
            { refresh: true, pendingLabel: 'UPDATING QUEUE' },
        ));
        row.appendChild(remove);
        strip.appendChild(row);
    });
}

function renderModelControls(): void {
    const state = activeState();
    const currentModelKey = state?.model ? `${state.model.provider}\u0000${state.model.id}` : '';
    modelSelect.replaceChildren();
    if (models.length === 0) {
        modelSelect.appendChild(optionElement('', state?.model?.name ?? state?.model?.id ?? 'MODEL: —'));
    } else {
        for (const model of models) {
            modelSelect.appendChild(optionElement(
                `${model.provider}\u0000${model.id}`,
                model.name ?? model.id,
            ));
        }
        modelSelect.value = currentModelKey;
    }

    thinkingSelect.replaceChildren();
    for (const level of THINKING_LEVELS) {
        thinkingSelect.appendChild(optionElement(level, `THINKING: ${level.toUpperCase()}`));
    }
    thinkingSelect.value = state?.thinkingLevel ?? 'off';
    const controlsDisabled = !state || state.isStreaming || state.isCompacting || commandPending;
    modelSelect.disabled = Boolean(controlsDisabled);
    thinkingSelect.disabled = Boolean(controlsDisabled);
}

function renderStatusBar(): void {
    const state = activeState();
    const usage = state?.contextUsage;
    const contextText = usage
        ? `${usage.estimated ? '~' : ''}${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} · ${formatPercent(usage.percent)}`
        : 'CONTEXT: —';
    requiredElement<HTMLElement>('context-usage').textContent = contextText;
    requiredElement<HTMLButtonElement>('cache-mode').textContent = `CACHE: ${(state?.cacheMode ?? 'auto').toUpperCase()}${state?.cacheEffective ? `-${state.cacheEffective.toUpperCase()}` : ''}`;
    requiredElement<HTMLElement>('session-title').textContent = state?.sessionName ?? selection?.tabs.find((tab) => tab.id === selection?.activeTabId)?.name ?? 'ACTIVE SESSION';
    requiredElement<HTMLElement>('command-state').textContent = commandPending
        ? requiredElement<HTMLElement>('command-state').textContent
        : state?.isCompacting ? 'COMPACTING' : state?.isStreaming ? 'AGENT ACTIVE' : 'READY';
}

function renderSessions(): void {
    requiredElement<HTMLElement>('history-count').textContent = String(sessions.length);
    const list = requiredElement<HTMLElement>('history-list');
    list.replaceChildren();
    if (sessions.length === 0) {
        list.className = 'panel-list empty-copy';
        list.textContent = 'No saved sessions';
        return;
    }
    list.className = 'panel-list';
    for (const session of sessions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'history-row';
        button.title = session.path;
        const label = session.name ?? session.firstMessage ?? session.id;
        button.append(
            textSpan('history-row-name', label),
            textSpan('history-row-meta', session.lastModified ? formatShortDate(session.lastModified) : ''),
        );
        button.addEventListener('click', async () => {
            if (await sendAgentCommand(
                { type: 'loadSession', sessionPath: session.path },
                selection?.activeTabId,
                { pendingLabel: 'LOADING SESSION' },
            )) {
                await refreshState(selection?.activeTabId);
            }
        });
        list.appendChild(button);
    }
}

function renderDiffCard(change: FileChangeInfo): HTMLElement {
    const detailsElement = document.createElement('details');
    detailsElement.className = 'diff-details';
    detailsElement.id = `diff-${safeDomId(change.toolCallId)}`;
    const summary = document.createElement('summary');
    summary.textContent = `${change.toolName === 'write' ? 'WRITE' : 'EDIT'} ${change.filePath} (+${change.addedLines}/−${change.removedLines})${change.isNew ? ' NEW' : ''}`;
    detailsElement.appendChild(summary);
    if (change.diff) detailsElement.appendChild(textPre('detail-output', change.diff));
    return terminalRow('', detailsElement);
}

function appendFileChange(change: FileChangeInfo, tabId?: string): void {
    const ownerTabId = tabId ?? selection?.activeTabId;
    if (!selection || !ownerTabId) return;
    const current = selection.snapshots[ownerTabId];
    if (!current) return;
    const fileChanges = [...(current.fileChanges ?? []).filter((item) => item.toolCallId !== change.toolCallId), change];
    const next = { ...current, fileChanges };
    const snapshots = { ...selection.snapshots, [ownerTabId]: next };
    selection = {
        ...selection,
        snapshots,
        ...(ownerTabId === selection.activeTabId ? { visibleState: next } : {}),
    };
    if (ownerTabId === selection.activeTabId) renderAgentState();
}

function updateVisibleSnapshot(update: Partial<SerializedAgentState>): void {
    if (!selection?.visibleState) return;
    const next = { ...selection.visibleState, ...update };
    const activeTabId = selection.activeTabId;
    selection = {
        ...selection,
        visibleState: next,
        snapshots: activeTabId
            ? { ...selection.snapshots, [activeTabId]: next }
            : selection.snapshots,
    };
}

function updateComposerControls(): void {
    const state = activeState();
    const busy = Boolean(state?.isStreaming || state?.isCompacting);
    const hasText = composer.value.trim().length > 0;
    sendButton.textContent = '↵';
    sendButton.title = busy ? 'Queue command (Ctrl+Enter steers)' : 'Submit command';
    sendButton.disabled = commandPending || !state || !hasText;
    stopButton.disabled = commandPending || !busy;
    composer.disabled = !state;
}

function updateNewWindowControls(): void {
    const state = resolveNewWindowControl({
        shellPhase,
        agentReady,
        launchPending: newWindowLaunchPending,
    });
    for (const id of ['new-window', 'rail-new-window']) {
        const button = requiredElement<HTMLButtonElement>(id);
        button.hidden = !state.visible;
        button.disabled = state.disabled;
        button.setAttribute('aria-busy', String(newWindowLaunchPending));
    }
    newWindowButton.textContent = state.label;
}

function setConnectionStatus(label: string, kind: 'pending' | 'online' | 'error'): void {
    requiredElement<HTMLElement>('connection-label').textContent = label;
    const indicator = requiredElement<HTMLElement>('host-indicator');
    indicator.textContent = kind === 'online' ? 'LINK OK' : kind === 'error' ? 'LINK ERR' : 'LINK';
    indicator.className = `host-indicator signal-${kind}`;
}

function activeState(): SerializedAgentState | undefined {
    return selection?.visibleState;
}

function initializeCrtPreference(): void {
    const stored = localStorage.getItem('pi-code.desktop.crt-level');
    applyCrtLevel(stored === 'low' || stored === 'high' ? stored : 'med');
}

function cycleCrtLevel(): void {
    const current = document.body.classList.contains('crt-low')
        ? 'low'
        : document.body.classList.contains('crt-high') ? 'high' : 'med';
    const next = current === 'low' ? 'med' : current === 'med' ? 'high' : 'low';
    applyCrtLevel(next);
    localStorage.setItem('pi-code.desktop.crt-level', next);
}

function applyCrtLevel(level: 'low' | 'med' | 'high'): void {
    document.body.classList.remove('crt-low', 'crt-med', 'crt-high');
    document.body.classList.add(`crt-${level}`);
    const button = document.getElementById('crt-level');
    if (button) button.textContent = level === 'low' ? 'L' : level === 'high' ? 'H' : 'M';
}

function resizeComposer(): void {
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(composer.scrollHeight, 84)}px`;
}

function isNearFeedBottom(): boolean {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
}

function scrollToLatest(smooth: boolean): void {
    feed.scrollTo({ top: feed.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    requiredElement<HTMLButtonElement>('scroll-latest').hidden = true;
}

function updateScrollButton(): void {
    requiredElement<HTMLButtonElement>('scroll-latest').hidden = isNearFeedBottom();
}

function showToast(message: string, isError = false): void {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = `${isError ? '✖ ' : ''}${message}`;
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
        toast.hidden = true;
    }, 6_000);
}

function emptyFeed(title: string, copy: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-feed';
    const content = document.createElement('div');
    content.append(
        textDiv('empty-feed-mark', 'π'),
        textDiv('empty-feed-title', title),
        textDiv('empty-feed-copy', copy),
    );
    wrapper.appendChild(content);
    return wrapper;
}

function terminalRow(who: string, content: HTMLElement, modifier = ''): HTMLElement {
    const row = document.createElement('div');
    row.className = `terminal-row${modifier ? ` ${modifier}` : ''}`;
    row.append(textSpan('row-who', who), content);
    return row;
}

function errorBlock(message: string): HTMLElement {
    return terminalRow('', textSpan('row-content', message), 'is-error');
}

function statusLabel(status: 'running' | 'done' | 'error'): HTMLElement {
    const label = textSpan(`status-label status-${status}`, status.toUpperCase());
    label.setAttribute('aria-label', `Status: ${status}`);
    return label;
}

function textDiv(className: string, text: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
}

function textSpan(className: string, text: string): HTMLSpanElement {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
}

function textPre(className: string, text: string): HTMLPreElement {
    const element = document.createElement('pre');
    element.className = className;
    element.textContent = text;
    return element;
}

function optionElement(value: string, label: string): HTMLOptionElement {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatShortDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatPercent(percent: number | null | undefined): string {
    return percent === null || percent === undefined ? '—' : `${Math.round(percent)}%`;
}

function formatTokenCount(tokens: number | null): string {
    if (tokens === null) return '—';
    return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k` : String(tokens);
}

function workspaceBasename(path: string): string {
    return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

function safeDomId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function tabButtonId(tabId: string): string {
    return `chat-tab-${safeDomId(tabId)}`;
}

function emptySnapshot(): SerializedAgentState {
    return { messages: [], isStreaming: false, tools: [] };
}

function requiredElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing renderer element: ${id}`);
    return element as T;
}
