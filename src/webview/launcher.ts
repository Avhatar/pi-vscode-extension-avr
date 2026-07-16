import type {
    LauncherClientMessage, LauncherServerMessage, LauncherState,
    LauncherSessionInfo, TaskInfo, TaskStatus, TodoSnapshot,
    RegisteredToolInfo, ToolSelectionSnapshot, LauncherSubagentRun,
    LauncherSubagentStatus, LauncherSubagentSnapshot,
} from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: LauncherClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

const iconsBaseUri = document.getElementById('launcher')?.dataset.iconsUri ?? '';

let currentState: LauncherState = {
    tabs: [],
    recentSessions: [],
    historyCollapsed: true,
    notificationSettings: { showPopup: false, playSound: false },
    notificationsCollapsed: false,
    todoCollapsed: false,
    subagentsCollapsed: false,
    toolsCollapsed: true,
};
let stateReceivedAt = Date.now();

// UI-local state for the Tools panel (search filter + per-group collapse).
// Not persisted — resets on window reload, but survives launcher re-renders.
let toolsSearch = '';
const toolGroupsCollapsed = new Map<string, boolean>();

window.addEventListener('message', (event) => {
    const msg = event.data as LauncherServerMessage;
    if (msg.type === 'launcherState') {
        currentState = msg.state;
        stateReceivedAt = Date.now();
        render();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    vscode.postMessage({ type: 'getLauncherState' });
});

// ── Helpers ──

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]!));
}

function formatRelative(ts?: number): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
}

// ── Render ──

/** Snapshot of transient UI state that `render()` rebuilds from scratch
 *  every call (scroll positions, focused input, cursor). Captured before
 *  wiping the DOM and restored on the fresh tree so a state push from the
 *  host doesn't yank the user's scroll position or steal focus mid-typing. */
interface RenderPreservation {
    subagentsBodyScrollTop: number;
    toolsBodyScrollTop: number;
    toolsSearchFocused: boolean;
    toolsSearchSelectionStart: number | null;
    toolsSearchSelectionEnd: number | null;
}

function captureRenderState(): RenderPreservation {
    const root = document.getElementById('launcher');
    const subagentsBody = root?.querySelector('.subagent-list') as HTMLElement | null;
    const body = root?.querySelector('.tools-body') as HTMLElement | null;
    const search = root?.querySelector('.tools-search') as HTMLInputElement | null;
    const searchFocused = search !== null && document.activeElement === search;
    return {
        subagentsBodyScrollTop: subagentsBody?.scrollTop ?? 0,
        toolsBodyScrollTop: body?.scrollTop ?? 0,
        toolsSearchFocused: searchFocused,
        toolsSearchSelectionStart: searchFocused ? search!.selectionStart : null,
        toolsSearchSelectionEnd: searchFocused ? search!.selectionEnd : null,
    };
}

function restoreRenderState(prev: RenderPreservation): void {
    const root = document.getElementById('launcher');
    if (!root) return;
    const subagentsBody = root.querySelector('.subagent-list') as HTMLElement | null;
    if (subagentsBody && prev.subagentsBodyScrollTop > 0) {
        subagentsBody.scrollTop = prev.subagentsBodyScrollTop;
    }
    const body = root.querySelector('.tools-body') as HTMLElement | null;
    if (body && prev.toolsBodyScrollTop > 0) {
        body.scrollTop = prev.toolsBodyScrollTop;
    }
    if (prev.toolsSearchFocused) {
        const search = root.querySelector('.tools-search') as HTMLInputElement | null;
        if (search) {
            search.focus();
            if (prev.toolsSearchSelectionStart !== null && prev.toolsSearchSelectionEnd !== null) {
                try { search.setSelectionRange(prev.toolsSearchSelectionStart, prev.toolsSearchSelectionEnd); }
                catch { /* some input types don't support setSelectionRange */ }
            }
        }
    }
}

function render(): void {
    const preserved = captureRenderState();

    const root = document.getElementById('launcher')!;
    root.innerHTML = '';

    root.appendChild(renderToolbar());
    const planMode = renderPlanMode();
    if (planMode) root.appendChild(planMode);
    const fileUndoView = renderFileUndoView();
    if (fileUndoView) root.appendChild(fileUndoView);
    root.appendChild(renderNotifications());
    const todos = renderTodos();
    if (todos) root.appendChild(todos);
    const subagents = renderSubagents();
    if (subagents) root.appendChild(subagents);
    root.appendChild(renderRecentSessions());
    const tools = renderTools();
    if (tools) root.appendChild(tools);

    restoreRenderState(preserved);
}

function renderToolbar(): HTMLElement {
    const bar = el('div', 'toolbar');

    const newBtn = el('button', 'toolbar-btn primary');
    newBtn.title = 'Start a new chat in a new editor tab';
    newBtn.innerHTML = '<span class="toolbar-icon">+</span><span>New chat</span>';
    newBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'createTab' });
    });
    bar.appendChild(newBtn);

    const settingsBtn = el('button', 'toolbar-btn icon-only');
    settingsBtn.title = 'Settings';
    settingsBtn.innerHTML = `<img class="toolbar-icon-img" src="${iconsBaseUri}/settings.png" alt="Settings">`;
    settingsBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openSettings' });
    });
    bar.appendChild(settingsBtn);

    return bar;
}

function setHistoryCollapsed(collapsed: boolean): void {
    currentState = { ...currentState, historyCollapsed: collapsed };
    render();
    vscode.postMessage({ type: 'setHistoryCollapsed', collapsed });
}

// ── Plan Mode section ──
//
// A compact toggle row above ToDo. When ON, the agent studies the
// task with read-only tools, proposes a plan, and asks clarifying
// questions before executing. Simple toggle — no collapsible body.

function renderPlanMode(): HTMLElement | undefined {
    // Only show when there's an active panel (planModeEnabled is defined).
    if (currentState.planModeEnabled === undefined) return undefined;

    const enabled = currentState.planModeEnabled === true;
    const toggleDisabled = currentState.planModeToggleDisabled === true;

    const section = el('div', 'section plan-mode-section');

    const heading = el('div', 'section-heading plan-mode-heading');
    heading.title = 'When enabled, the agent studies your request with read-only tools and proposes a plan before making any changes.';
    // Empty chevron-width spacer keeps the title aligned with the ToDo /
    // History headings, which start their text after a real chevron.
    heading.appendChild(el('span', 'section-chevron'));
    heading.appendChild(el('span', 'section-title', 'Plan Mode'));

    const toggleHost = el('span', 'todo-toggle-host');
    toggleHost.addEventListener('click', (e) => e.stopPropagation());
    toggleHost.appendChild(renderPlanModeToggle(enabled, toggleDisabled));
    heading.appendChild(toggleHost);

    section.appendChild(heading);
    return section;
}

function renderPlanModeToggle(enabled: boolean, disabled: boolean): HTMLElement {
    const wrap = el('label', `todo-toggle${disabled ? ' todo-toggle-disabled' : ''}`);
    wrap.title = disabled
        ? 'Wait for the agent to finish before toggling Plan Mode'
        : enabled
            ? 'Disable Plan Mode — agent executes immediately'
            : 'Enable Plan Mode — agent plans before making changes';

    const input = el('input', 'todo-toggle-input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = enabled;
    input.disabled = disabled;
    input.addEventListener('change', () => {
        if (disabled) return;
        const next = input.checked;
        currentState = { ...currentState, planModeEnabled: next };
        render();
        vscode.postMessage({ type: 'setPlanModeEnabled', enabled: next });
    });
    wrap.appendChild(input);

    const track = el('span', 'todo-toggle-track');
    const thumb = el('span', 'todo-toggle-thumb');
    track.appendChild(thumb);
    wrap.appendChild(track);

    return wrap;
}

// ── File Undo View section ──
//
// A compact toggle row mirroring Plan Mode. When ON, the chat panel
// shows the changed-files bar (with Undo/Redo/Review buttons) above
// the prompt input. The toggle is purely cosmetic — agent edits and
// per-message diffs work the same regardless of this flag.

function renderFileUndoView(): HTMLElement | undefined {
    if (currentState.fileUndoViewEnabled === undefined) return undefined;

    const enabled = currentState.fileUndoViewEnabled === true;

    const section = el('div', 'section plan-mode-section file-undo-view-section');

    const heading = el('div', 'section-heading plan-mode-heading file-undo-view-heading');
    heading.title = 'When enabled, the bar above the input lists files the agent changed, with Undo / Redo / Review buttons.';
    heading.appendChild(el('span', 'section-chevron'));
    heading.appendChild(el('span', 'section-title', 'File Undo View'));

    const toggleHost = el('span', 'todo-toggle-host');
    toggleHost.addEventListener('click', (e) => e.stopPropagation());
    toggleHost.appendChild(renderFileUndoViewToggle(enabled));
    heading.appendChild(toggleHost);

    section.appendChild(heading);
    return section;
}

function renderFileUndoViewToggle(enabled: boolean): HTMLElement {
    const wrap = el('label', 'todo-toggle');
    wrap.title = enabled
        ? 'Hide the changed-files bar above the chat input'
        : 'Show the changed-files bar above the chat input (Undo / Redo / Review)';

    const input = el('input', 'todo-toggle-input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = enabled;
    input.addEventListener('change', () => {
        const next = input.checked;
        currentState = { ...currentState, fileUndoViewEnabled: next };
        render();
        vscode.postMessage({ type: 'setFileUndoViewEnabled', enabled: next });
    });
    wrap.appendChild(input);

    const track = el('span', 'todo-toggle-track');
    const thumb = el('span', 'todo-toggle-thumb');
    track.appendChild(thumb);
    wrap.appendChild(track);

    return wrap;
}

// ── Notifications section ──

function setNotificationsCollapsed(collapsed: boolean): void {
    currentState = { ...currentState, notificationsCollapsed: collapsed };
    render();
    vscode.postMessage({ type: 'setNotificationsCollapsed', collapsed });
}

function renderNotifications(): HTMLElement {
    const collapsed = currentState.notificationsCollapsed === true;
    const section = el('div', 'section notifications-section');
    const heading = el('button', 'section-heading section-heading-button notifications-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!collapsed));
    heading.title = collapsed
        ? 'Expand turn-completion notifications'
        : 'Collapse turn-completion notifications';
    heading.appendChild(el('span', 'section-chevron', collapsed ? '▶' : '▼'));
    heading.appendChild(el('span', 'section-title', 'Notifications'));
    heading.addEventListener('click', () => setNotificationsCollapsed(!collapsed));
    section.appendChild(heading);

    if (collapsed) return section;

    const list = el('div', 'notifications-list');
    list.appendChild(renderNotificationRow(
        'Show Popup',
        'Show a native Windows notification outside VS Code when an agent turn finishes',
        currentState.notificationSettings.showPopup,
        'setNotificationShowPopup',
    ));
    list.appendChild(renderNotificationRow(
        'Play Sound',
        'Play the standard Windows notification sound when an agent turn finishes',
        currentState.notificationSettings.playSound,
        'setNotificationPlaySound',
    ));
    section.appendChild(list);
    return section;
}

function renderNotificationRow(
    label: string,
    description: string,
    enabled: boolean,
    messageType: 'setNotificationShowPopup' | 'setNotificationPlaySound',
): HTMLElement {
    const row = el('div', 'notification-row');
    row.title = description;
    row.appendChild(el('span', 'notification-label', label));

    const toggleHost = el('span', 'todo-toggle-host');
    const toggle = el('label', 'todo-toggle');
    toggle.title = description;
    const input = el('input', 'todo-toggle-input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = enabled;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
        const next = input.checked;
        currentState = {
            ...currentState,
            notificationSettings: {
                ...currentState.notificationSettings,
                ...(messageType === 'setNotificationShowPopup'
                    ? { showPopup: next }
                    : { playSound: next }),
            },
        };
        render();
        vscode.postMessage({ type: messageType, enabled: next });
    });
    toggle.appendChild(input);
    const track = el('span', 'todo-toggle-track');
    track.appendChild(el('span', 'todo-toggle-thumb'));
    toggle.appendChild(track);
    toggleHost.appendChild(toggle);
    row.appendChild(toggleHost);
    return row;
}

// ── Subagents section ──

const SUBAGENT_STATUS_ICON: Record<LauncherSubagentStatus, string> = {
    queued: 'agentinprogress.png',
    starting: 'agentinprogress.png',
    running: 'agentinprogress.png',
    waiting_for_permission: 'agentinprogress.png',
    retrying: 'agentinprogress.png',
    completed: 'check.png',
    failed: 'cross.png',
    cancelled: 'cross.png',
};
const ACTIVE_SUBAGENT_STATUSES = new Set<LauncherSubagentStatus>([
    'queued', 'starting', 'running', 'waiting_for_permission', 'retrying',
]);

function setSubagentsCollapsed(collapsed: boolean): void {
    currentState = { ...currentState, subagentsCollapsed: collapsed };
    render();
    vscode.postMessage({ type: 'setSubagentsCollapsed', collapsed });
}

function renderSubagents(): HTMLElement | undefined {
    const snapshot: LauncherSubagentSnapshot | undefined = currentState.subagents;
    if (!snapshot) return undefined;
    const collapsed = currentState.subagentsCollapsed === true;

    const section = el('div', 'section subagents-section');
    const heading = el('button', 'section-heading section-heading-button subagents-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!collapsed));
    heading.title = collapsed ? 'Expand Subagents' : 'Collapse Subagents';
    heading.appendChild(el('span', 'section-chevron', collapsed ? '▶' : '▼'));
    heading.appendChild(el('span', 'section-title', 'Subagents'));
    if (snapshot.activeCount > 0) {
        heading.appendChild(el('span', 'section-count', `${snapshot.activeCount} active`));
    }
    if (snapshot.smokeSimulation) {
        const dismiss = el('span', 'subagent-smoke-dismiss', 'Reset');
        dismiss.setAttribute('role', 'button');
        dismiss.setAttribute('tabindex', '0');
        dismiss.title = 'Dismiss simulated lifecycle rows and return to live state';
        const reset = (): void => vscode.postMessage({ type: 'dismissSubagentSmoke' });
        dismiss.addEventListener('click', (event) => {
            event.stopPropagation();
            reset();
        });
        dismiss.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                reset();
            }
        });
        heading.appendChild(dismiss);
    }
    const toggleHost = el('span', 'todo-toggle-host');
    toggleHost.addEventListener('click', (event) => event.stopPropagation());
    toggleHost.appendChild(renderSubagentsToggle(snapshot));
    heading.appendChild(toggleHost);
    heading.addEventListener('click', () => setSubagentsCollapsed(!collapsed));
    section.appendChild(heading);

    if (collapsed || !snapshot.enabled) return section;
    if (snapshot.runs.length === 0) {
        section.appendChild(el('div', 'empty', 'No subagent runs yet.'));
        return section;
    }

    const list = el('div', 'subagent-list');
    for (const run of snapshot.runs) list.appendChild(renderSubagentRow(run));
    section.appendChild(list);
    return section;
}

function renderSubagentsToggle(snapshot: LauncherSubagentSnapshot): HTMLElement {
    const disabled = snapshot.toggleDisabled || snapshot.smokeSimulation === true;
    const wrap = el('label', `todo-toggle${disabled ? ' todo-toggle-disabled' : ''}`);
    wrap.title = snapshot.smokeSimulation
        ? 'The deterministic smoke snapshot is read-only; click Reset to return to live state'
        : disabled
            ? 'Wait for the parent agent to finish before changing subagent access'
            : snapshot.enabled
                ? 'Disable subagent delegation for this chat'
                : 'Enable subagent delegation for this chat';
    const input = el('input', 'todo-toggle-input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = snapshot.enabled;
    input.disabled = disabled;
    input.setAttribute('aria-label', 'Enable subagent delegation');
    input.addEventListener('change', () => {
        if (disabled) return;
        const enabled = input.checked;
        currentState = {
            ...currentState,
            subagents: { ...snapshot, enabled },
        };
        render();
        vscode.postMessage({ type: 'setSubagentsEnabled', enabled });
    });
    wrap.appendChild(input);
    const track = el('span', 'todo-toggle-track');
    track.appendChild(el('span', 'todo-toggle-thumb'));
    wrap.appendChild(track);
    return wrap;
}

function renderSubagentRow(run: LauncherSubagentRun): HTMLElement {
    const row = document.createElement('details');
    row.className = `subagent-row subagent-row-${run.status}`;

    const summary = el('summary', 'subagent-row-summary');
    const header = el('div', 'subagent-row-header');
    const statusIcon = document.createElement('img');
    statusIcon.className = 'subagent-status-icon';
    statusIcon.src = `${iconsBaseUri}/${SUBAGENT_STATUS_ICON[run.status]}`;
    statusIcon.alt = '';
    statusIcon.title = run.status.replaceAll('_', ' ');
    header.appendChild(statusIcon);
    header.appendChild(el('span', 'subagent-name', run.name));
    header.appendChild(el('span', 'subagent-status-label', run.status.replaceAll('_', ' ')));
    summary.appendChild(header);

    const metadata = el('div', 'subagent-metadata');
    const model = el('span', 'subagent-model', run.modelLabel ?? 'resolving model…');
    model.title = run.modelLabel ?? 'Model is not resolved yet';
    metadata.appendChild(model);
    const elapsed = el('span', 'subagent-elapsed', formatElapsed(run.elapsedMs));
    elapsed.dataset.elapsedBase = String(run.elapsedMs);
    elapsed.dataset.active = String(ACTIVE_SUBAGENT_STATUSES.has(run.status));
    metadata.appendChild(elapsed);
    if (run.queueWaitMs !== undefined && run.queueWaitMs > 0) {
        const queued = el('span', 'subagent-queue-wait', `queue ${formatElapsed(run.queueWaitMs)}`);
        queued.title = 'Time spent waiting for orchestration capacity';
        metadata.appendChild(queued);
    }
    summary.appendChild(metadata);

    const activityText = run.currentTool
        ? `${run.activity ?? 'Running tool'} · ${run.currentTool}`
        : run.activity ?? run.taskPreview;
    summary.appendChild(el('div', 'subagent-activity', activityText));
    row.appendChild(summary);

    const body = el('div', 'subagent-row-body');
    body.appendChild(el('div', 'subagent-detail-label', 'Task'));
    const task = el('pre', 'subagent-detail-value');
    task.textContent = run.task;
    body.appendChild(task);

    const result = run.result ?? run.resultPreview;
    if (result || run.error) {
        body.appendChild(el('div', 'subagent-detail-label', run.error ? 'Error' : 'Result'));
        const output = el('pre', `subagent-detail-value${run.error ? ' subagent-error' : ''}`);
        output.textContent = run.error ?? result ?? '';
        body.appendChild(output);
    }

    if (run.canDismiss) {
        const controls = el('div', 'subagent-controls');
        controls.appendChild(subagentDismissControl(run.agentId));
        body.appendChild(controls);
    }
    row.appendChild(body);
    return row;
}

function subagentDismissControl(agentId: string): HTMLButtonElement {
    const button = el('button', 'subagent-control', 'Dismiss');
    button.type = 'button';
    button.addEventListener('click', () => {
        button.disabled = true;
        vscode.postMessage({ type: 'dismissSubagent', agentId });
    });
    return button;
}

function formatElapsed(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function updateSubagentElapsedLabels(): void {
    const delta = Date.now() - stateReceivedAt;
    document.querySelectorAll<HTMLElement>('.subagent-elapsed').forEach((node) => {
        const base = Number(node.dataset.elapsedBase ?? 0);
        const active = node.dataset.active === 'true';
        node.textContent = formatElapsed(base + (active ? delta : 0));
    });
}
window.setInterval(updateSubagentElapsedLabels, 1_000);

// ── ToDo section ──
//
// Visible above History when the active tab has the ToDo feature in
// scope (driven by `LauncherState.todos` from the controller). The
// section auto-hides when no active panel exists. Toggle (PR4) will
// further gate visibility per-tab.

const STATUS_GLYPH: Record<TaskStatus, string> = {
    pending: '•',
    in_progress: '•',
    completed: '✓',
    deleted: '•',
};

function setTodoCollapsed(collapsed: boolean): void {
    currentState = { ...currentState, todoCollapsed: collapsed };
    render();
    vscode.postMessage({ type: 'setTodoCollapsed', collapsed });
}

function renderTodos(): HTMLElement | undefined {
    const todos: TodoSnapshot | undefined = currentState.todos;
    // No active tab/panel → no section at all (per spec D9).
    if (!todos) return undefined;

    const enabled = currentState.todoEnabled === true;
    const toggleDisabled = currentState.todoToggleDisabled === true;
    const collapsed = currentState.todoCollapsed === true;

    const visible = todos.tasks.filter((t) => t.status !== 'deleted');
    const counts = countByStatus(visible);

    const section = el('div', 'section todo-section');

    // Heading mirrors the History section: clickable chevron + title +
    // count badge. Collapse is purely a UI preference, persisted in
    // globalState alongside `historyCollapsed`.
    const heading = el('button', 'section-heading section-heading-button todo-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!collapsed));
    heading.title = (collapsed ? 'Expand ToDo' : 'Collapse ToDo') + ' — Task list managed by the agent. Tracks pending, in-progress, and completed tasks during your conversation. This list survives /compact — the agent always remembers its tasks.';

    const chevron = el('span', 'section-chevron', collapsed ? '▶' : '▼');
    heading.appendChild(chevron);
    heading.appendChild(el('span', 'section-title', 'ToDo'));
    if (enabled && visible.length > 0) {
        heading.appendChild(
            el('span', 'section-count', `${counts.completed}/${visible.length}`),
        );
        heading.appendChild(renderTodoCopyButton(visible));
    }
    // Toggle is part of the heading row (right-aligned via CSS) but
    // sits in its own <span> so the heading-wide click-to-collapse
    // does not trigger when clicking the toggle.
    const toggleHost = el('span', 'todo-toggle-host');
    toggleHost.addEventListener('click', (e) => e.stopPropagation());
    toggleHost.appendChild(renderTodoToggle(enabled, toggleDisabled));
    heading.appendChild(toggleHost);
    heading.addEventListener('click', () => {
        setTodoCollapsed(!collapsed);
    });
    section.appendChild(heading);

    // Body hidden when collapsed OR when the feature is OFF for this
    // tab (toggle OFF preserves state in the branch — toggling back
    // ON restores it from `todos` which is still pushed by the host).
    if (collapsed) return section;
    if (!enabled) return section;

    if (visible.length === 0) {
        section.appendChild(el('div', 'empty', 'No tasks yet.'));
        return section;
    }

    const list = el('div', 'todo-list');
    // Display order: newest first (highest id at the top), oldest at
    // the bottom. Status differences are conveyed by glyphs and
    // styling, not ordering. CSS caps visible rows to ~10 and the
    // overflow scrolls.
    const ordered = [...visible].sort((a, b) => b.id - a.id);
    for (const task of ordered) {
        list.appendChild(renderTodoRow(task));
    }
    section.appendChild(list);
    return section;
}

function renderTodoToggle(enabled: boolean, disabled: boolean): HTMLElement {
    const wrap = el('label', `todo-toggle${disabled ? ' todo-toggle-disabled' : ''}`);
    wrap.title = disabled
        ? 'Wait for the agent to finish before toggling ToDo'
        : enabled
            ? 'Disable ToDo for this chat (history is preserved)'
            : 'Enable ToDo for this chat — the agent gets a persistent task list';

    const input = el('input', 'todo-toggle-input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = enabled;
    input.disabled = disabled;
    input.addEventListener('change', () => {
        if (disabled) return;
        const next = input.checked;
        // Optimistic local update — host will push fresh state shortly,
        // but flipping the visual immediately keeps the click responsive.
        currentState = { ...currentState, todoEnabled: next };
        render();
        vscode.postMessage({ type: 'setTodoEnabled', enabled: next });
    });
    wrap.appendChild(input);

    const track = el('span', 'todo-toggle-track');
    const thumb = el('span', 'todo-toggle-thumb');
    track.appendChild(thumb);
    wrap.appendChild(track);

    return wrap;
}

function countByStatus(tasks: TaskInfo[]): Record<TaskStatus, number> {
    const out: Record<TaskStatus, number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        deleted: 0,
    };
    for (const t of tasks) out[t.status]++;
    return out;
}

function renderTodoRow(task: TaskInfo): HTMLElement {
    const row = el('div', `todo-row todo-row-${task.status}`);
    row.title = task.description ? task.description : task.subject;

    row.appendChild(renderTodoIcon(task.status));

    const labelText =
        task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
    const label = el('span', 'todo-label', labelText);
    row.appendChild(label);

    if (task.blockedBy?.length) {
        const blocked = el('span', 'todo-blocked', `⛓ ${task.blockedBy.map((id) => `#${id}`).join(',')}`);
        row.appendChild(blocked);
    }

    return row;
}

function renderTodoIcon(status: TaskStatus): HTMLElement {
    const glyph = el('span', 'todo-glyph', STATUS_GLYPH[status]);
    glyph.title = status.replace('_', ' ');
    return glyph;
}

function renderTodoCopyButton(tasks: TaskInfo[]): HTMLElement {
    const btn = el('span', 'todo-copy-btn');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.title = 'Copy ToDo list to clipboard';
    btn.setAttribute('aria-label', 'Copy ToDo list');
    btn.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<rect x="4" y="5" width="9" height="9" rx="1.2"/>'
        + '<path d="M6.5 5V3.2a1 1 0 0 1 1-1H12a1 1 0 0 1 1 1V10"/>'
        + '</svg>';

    const copy = (): void => {
        const text = formatTodosForClipboard(tasks);
        if (!text) return;
        navigator.clipboard?.writeText(text).then(
            () => {
                btn.classList.add('todo-copy-btn-flash');
                setTimeout(() => btn.classList.remove('todo-copy-btn-flash'), 900);
            },
            () => { /* silent — clipboard denied */ },
        );
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copy();
    });
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            copy();
        }
    });
    return btn;
}

function formatTodosForClipboard(tasks: TaskInfo[]): string {
    // Order oldest → newest so the copied list reads naturally
    // (creation order), independent of the newest-first UI ordering.
    const ordered = [...tasks].sort((a, b) => a.id - b.id);
    return ordered.map((t) => {
        const box =
            t.status === 'completed' ? 'x'
                : t.status === 'in_progress' ? '~'
                    : ' ';
        return `- [${box}] ${t.subject}`;
    }).join('\n');
}

function renderRecentSessions(): HTMLElement {
    const section = el('div', 'section history-section');

    // Show only sessions that aren't currently open in editor tabs.
    const closed = currentState.recentSessions.filter(s => !s.isOpen);

    const heading = el('button', 'section-heading section-heading-button');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!currentState.historyCollapsed));
    heading.title = (currentState.historyCollapsed ? 'Expand history' : 'Collapse history') + ' — Previously active chat sessions. Click a session to reopen it.';

    const chevron = el('span', 'section-chevron', currentState.historyCollapsed ? '▶' : '▼');
    heading.appendChild(chevron);
    heading.appendChild(el('span', 'section-title', 'History'));
    heading.appendChild(el('span', 'section-count', String(closed.length)));
    heading.addEventListener('click', () => {
        setHistoryCollapsed(!currentState.historyCollapsed);
    });
    section.appendChild(heading);

    if (currentState.historyCollapsed) {
        return section;
    }

    if (closed.length === 0) {
        const empty = el('div', 'empty', 'No previous sessions yet.');
        section.appendChild(empty);
        return section;
    }

    const list = el('div', 'session-list');
    for (const s of closed.slice(0, 50)) {
        list.appendChild(renderSessionRow(s));
    }
    section.appendChild(list);
    return section;
}

function renderSessionRow(s: LauncherSessionInfo): HTMLElement {
    const row = el('div', 'session-row');
    row.dataset.sessionPath = s.path;

    const main = el('div', 'session-main');
    const name = el('div', 'session-name', s.name || s.firstMessage || 'Untitled session');
    main.appendChild(name);
    const meta = el('div', 'session-meta', formatRelative(s.lastModified));
    main.appendChild(meta);
    row.appendChild(main);

    const deleteBtn = el('button', 'row-action session-delete', '×');
    deleteBtn.title = 'Delete from history';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', sessionPath: s.path });
    });
    row.appendChild(deleteBtn);

    row.addEventListener('click', () => {
        vscode.postMessage({ type: 'openSession', sessionPath: s.path });
    });

    return row;
}

// ── Tools panel ──
//
// Under History. Lists every tool registered for the active chat with a
// checkbox to toggle it on/off. Grouped by shared prefix so a project with
// 100+ MCP tools (unity_*, blueprint_*, ...) stays browseable. Heading actions
// copy/paste selections or save the current enabled list as the project default.

function setToolsCollapsed(collapsed: boolean): void {
    currentState = { ...currentState, toolsCollapsed: collapsed };
    render();
    vscode.postMessage({ type: 'setToolsCollapsed', collapsed });
}

/** Split a tool name into (group, rest). Group is the prefix up to the
 *  first `_` or `-` (whichever comes first). Bare names without a
 *  separator have `group = ''` and land in the ungrouped bucket. */
function toolGroupOf(name: string): string {
    const under = name.indexOf('_');
    const dash = name.indexOf('-');
    let idx = -1;
    if (under >= 0 && dash >= 0) idx = Math.min(under, dash);
    else idx = Math.max(under, dash);
    if (idx <= 0) return '';
    return name.slice(0, idx);
}

interface ToolGroup {
    /** Machine key used for collapse state and heading title. */
    key: string;
    /** Human-readable heading. Same as `key` for prefix groups. */
    label: string;
    /** How this group was derived — affects heading tooltip wording. */
    kind: 'known' | 'prefix' | 'other';
    tools: RegisteredToolInfo[];
    disabledCount: number;
}

/** Human-readable categorization of tools that don't share a naming prefix.
 *  Ordered — the first match wins, and groups appear in this order at the
 *  top of the panel. Anything not in this list AND without a shared prefix
 *  falls into "Other". */
const KNOWN_TOOL_CATEGORIES: Array<{ key: string; label: string; tools: readonly string[] }> = [
    { key: 'category-pi', label: 'Pi built-ins',
        tools: ['read', 'bash', 'edit', 'write'] },
    { key: 'category-web', label: 'Web',
        tools: ['web_search', 'fetch_content', 'get_search_content'] },
    { key: 'category-todo', label: 'ToDo',
        tools: ['todo'] },
    { key: 'category-mcp', label: 'MCP',
        tools: ['mcp'] },
    { key: 'category-lsp', label: 'Language Server',
        tools: [
            'find_references', 'document_symbols', 'goto_definition', 'hover',
            'find_implementations', 'type_definition', 'workspace_symbols',
            'call_hierarchy_incoming', 'call_hierarchy_outgoing',
        ] },
];

function buildToolGroups(sel: ToolSelectionSnapshot): ToolGroup[] {
    const disabledSet = new Set(sel.disabled);
    const assigned = new Set<string>();

    // Pass 1 — known categories (top of the list, defined order). Categories
    // with fewer than 2 registered members get demoted to `leftovers` so
    // tiny single-tool sections (e.g. ToDo alone, MCP alone) collapse into
    // the shared Other bucket at the bottom instead of cluttering the top.
    const knownGroups: ToolGroup[] = [];
    const knownLeftovers: RegisteredToolInfo[] = [];
    const byName = new Map(sel.registered.map((t) => [t.name, t]));
    for (const cat of KNOWN_TOOL_CATEGORIES) {
        const tools: RegisteredToolInfo[] = [];
        for (const name of cat.tools) {
            const t = byName.get(name);
            if (t) tools.push(t);
        }
        if (tools.length === 0) continue;
        for (const t of tools) assigned.add(t.name);
        if (tools.length < 2) {
            knownLeftovers.push(...tools);
            continue;
        }
        tools.sort((a, b) => a.name.localeCompare(b.name));
        knownGroups.push({
            key: cat.key,
            label: cat.label,
            kind: 'known',
            tools,
            disabledCount: tools.filter((t) => disabledSet.has(t.name)).length,
        });
    }

    // Pass 2 — shared-prefix groups for whatever remains (unity_*, blueprint_*, …).
    const buckets = new Map<string, RegisteredToolInfo[]>();
    for (const info of sel.registered) {
        if (assigned.has(info.name)) continue;
        const g = toolGroupOf(info.name);
        const list = buckets.get(g) ?? [];
        list.push(info);
        buckets.set(g, list);
    }
    const leftovers: RegisteredToolInfo[] = [
        ...knownLeftovers,
        ...(buckets.get('') ?? []),
    ];
    const prefixGroups: ToolGroup[] = [];
    for (const [prefix, tools] of buckets) {
        if (prefix === '') continue;
        if (tools.length < 2) {
            // Single-member prefix "groups" become part of Other; a section
            // of one is more noise than help.
            leftovers.push(...tools);
            continue;
        }
        tools.sort((a, b) => a.name.localeCompare(b.name));
        prefixGroups.push({
            key: `prefix-${prefix}`,
            label: prefix,
            kind: 'prefix',
            tools,
            disabledCount: tools.filter((t) => disabledSet.has(t.name)).length,
        });
    }
    prefixGroups.sort((a, b) => a.label.localeCompare(b.label));

    const groups: ToolGroup[] = [...knownGroups, ...prefixGroups];
    if (leftovers.length > 0) {
        leftovers.sort((a, b) => a.name.localeCompare(b.name));
        groups.push({
            key: 'category-other',
            label: 'Other',
            kind: 'other',
            tools: leftovers,
            disabledCount: leftovers.filter((t) => disabledSet.has(t.name)).length,
        });
    }
    return groups;
}

/** Build the multi-line title string shown on hover. Keeps the description
 *  (first ~600 chars) plus a source label and guidelines hint. Native
 *  `title` renders newlines fine in most VS Code themes. */
function toolTooltip(info: RegisteredToolInfo, checked: boolean): string {
    const parts: string[] = [info.name];
    if (info.source) parts.push(`Source: ${info.source}`);
    if (info.hasGuidelines) parts.push('Ships extra promptGuidelines (adds tokens per turn while active).');
    if (info.description) {
        const desc = info.description.length > 600
            ? info.description.slice(0, 600).trimEnd() + '…'
            : info.description;
        parts.push('', desc);
    }
    parts.push('', checked
        ? `Uncheck to hide "${info.name}" from the model on the next turn.`
        : `Check to expose "${info.name}" to the model again.`);
    return parts.join('\n');
}

function renderTools(): HTMLElement | undefined {
    const sel = currentState.toolSelection;
    if (!sel) return undefined;

    const collapsed = currentState.toolsCollapsed === true;
    const disabledSet = new Set(sel.disabled);
    const enabledCount = sel.registered.filter((t) => !disabledSet.has(t.name)).length;
    const allNames = sel.registered.map((t) => t.name);

    const section = el('div', 'section tools-section');

    const heading = el('button', 'section-heading section-heading-button tools-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!collapsed));
    heading.title = (collapsed ? 'Expand Tools' : 'Collapse Tools') +
        ' — Choose which tools the agent can call in this chat. Fewer tools = clearer prompt for the model. Selection is per-chat; use Copy/Paste to move it or DefaultForProject for new agents in this project.';
    heading.appendChild(el('span', 'section-chevron', collapsed ? '▶' : '▼'));
    heading.appendChild(el('span', 'section-title', 'Tools'));
    heading.appendChild(el('span', 'section-count', `${enabledCount}/${sel.registered.length}`));
    heading.appendChild(renderToolsCopyButton());
    heading.appendChild(renderToolsPasteButton(sel.toggleDisabled));
    heading.appendChild(renderToolsDefaultForProjectButton());
    heading.addEventListener('click', () => setToolsCollapsed(!collapsed));
    section.appendChild(heading);

    if (collapsed) return section;

    const controls = el('div', 'tools-controls');
    controls.appendChild(renderToolsBulkButton('Enable all', [], sel.toggleDisabled));
    controls.appendChild(renderToolsBulkButton('Disable all', allNames, sel.toggleDisabled));

    const searchInput = el('input', 'tools-search') as HTMLInputElement;
    searchInput.type = 'search';
    searchInput.placeholder = 'Filter tools…';
    searchInput.value = toolsSearch;
    searchInput.addEventListener('input', () => {
        toolsSearch = searchInput.value;
        // Re-render only the tools body; a full render would steal focus.
        const body = section.querySelector('.tools-body');
        if (body) {
            const next = renderToolsBody(sel);
            body.replaceWith(next);
        }
    });
    controls.appendChild(searchInput);
    section.appendChild(controls);

    section.appendChild(renderToolsBody(sel));
    return section;
}

function renderToolsBody(sel: ToolSelectionSnapshot): HTMLElement {
    const body = el('div', 'tools-body');
    if (sel.registered.length === 0) {
        body.appendChild(el('div', 'empty', 'No tools registered for this chat.'));
        return body;
    }

    const filter = toolsSearch.trim().toLowerCase();
    const groups = buildToolGroups(sel);
    const disabledSet = new Set(sel.disabled);
    let anyRendered = false;

    for (const group of groups) {
        const matching = filter
            ? group.tools.filter((t) =>
                t.name.toLowerCase().includes(filter)
                || (t.description ?? '').toLowerCase().includes(filter))
            : group.tools;
        if (matching.length === 0) continue;

        const groupCollapsed = toolGroupsCollapsed.get(group.key) === true;
        const groupHeading = el('div', `tools-group-heading tools-group-heading-${group.kind}`);
        // Group tooltip: prefix line describing what the group is, then up
        // to 3 tool descriptions as a preview.
        const headerLine = group.kind === 'prefix'
            ? `Prefix "${group.label}_*" — ${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}`
            : group.kind === 'known'
                ? `Category: ${group.label} — ${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}`
                : `Uncategorized — ${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}`;
        const groupSample = group.tools.slice(0, 3)
            .map((t) => t.description ? `${t.name}: ${t.description.split(/\r?\n/)[0].slice(0, 120)}` : t.name)
            .join('\n');
        const groupExtra = group.tools.length > 3 ? `\n… and ${group.tools.length - 3} more` : '';
        groupHeading.title = `${headerLine}\n\n${groupSample}${groupExtra}`;

        const chevron = el('span', 'tools-group-chevron', groupCollapsed ? '▶' : '▼');
        chevron.addEventListener('click', (e) => {
            e.stopPropagation();
            toolGroupsCollapsed.set(group.key, !groupCollapsed);
            render();
        });
        groupHeading.appendChild(chevron);

        // Category headings use their human label; prefix groups render the
        // prefix in monospace so `unity_*` reads as an identifier.
        const nameEl = el('span',
            group.kind === 'prefix' ? 'tools-group-name tools-group-name-prefix' : 'tools-group-name',
            group.label);
        groupHeading.appendChild(nameEl);

        const groupCount = el('span', 'tools-group-count',
            `${group.tools.length - group.disabledCount}/${group.tools.length}`);
        groupHeading.appendChild(groupCount);

        const groupNames = group.tools.map((t) => t.name);
        const enableAll = renderToolsGroupAction('Enable', group.label, false, groupNames, sel.toggleDisabled);
        const disableAll = renderToolsGroupAction('Disable', group.label, true, groupNames, sel.toggleDisabled);
        groupHeading.appendChild(enableAll);
        groupHeading.appendChild(disableAll);

        body.appendChild(groupHeading);

        if (!groupCollapsed) {
            const list = el('div', 'tools-list tools-list-grouped');
            for (const info of matching) {
                list.appendChild(renderToolRow(info, !disabledSet.has(info.name), sel.toggleDisabled));
            }
            body.appendChild(list);
        }
        anyRendered = true;
    }

    if (!anyRendered) {
        body.appendChild(el('div', 'empty', 'No tools match the filter.'));
    }
    return body;
}

function renderToolRow(info: RegisteredToolInfo, enabled: boolean, toggleDisabled: boolean): HTMLElement {
    const row = el('label', `tool-row${toggleDisabled ? ' tool-row-disabled' : ''}`);
    row.title = toolTooltip(info, enabled);

    const input = el('input', 'tool-row-checkbox') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = enabled;
    input.disabled = toggleDisabled;
    input.addEventListener('change', () => {
        if (toggleDisabled) { input.checked = enabled; return; }
        vscode.postMessage({ type: 'setToolDisabled', toolName: info.name, disabled: !input.checked });
    });
    row.appendChild(input);

    row.appendChild(el('span', 'tool-row-name', info.name));
    if (info.hasGuidelines) {
        // A tiny marker so the user can see which tools carry extra prompt
        // weight (promptGuidelines add tokens every turn while active).
        const marker = el('span', 'tool-row-guideline-marker', '§');
        marker.title = 'Ships extra promptGuidelines — these tokens are added to every turn while this tool is active.';
        row.appendChild(marker);
    }
    return row;
}

function renderToolsBulkButton(label: string, disabled: string[], toggleDisabled: boolean): HTMLElement {
    const btn = el('button', `tools-bulk-btn${toggleDisabled ? ' tools-bulk-btn-disabled' : ''}`, label);
    btn.type = 'button';
    btn.title = toggleDisabled
        ? 'Wait for the agent to finish'
        : label === 'Enable all'
            ? 'Enable every registered tool for this chat'
            : 'Disable every registered tool for this chat';
    btn.disabled = toggleDisabled;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (toggleDisabled) return;
        vscode.postMessage({ type: 'setToolsBulk', disabled });
    });
    return btn;
}

function renderToolsGroupAction(
    label: string,
    prefix: string,
    disable: boolean,
    groupToolNames: string[],
    toggleDisabled: boolean,
): HTMLElement {
    const btn = el('button', `tools-group-action${toggleDisabled ? ' tools-group-action-disabled' : ''}`, label);
    btn.type = 'button';
    btn.disabled = toggleDisabled;
    btn.title = toggleDisabled
        ? 'Wait for the agent to finish'
        : `${label} all "${prefix}_*" tools`;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (toggleDisabled) return;
        const currentDisabled = new Set(currentState.toolSelection?.disabled ?? []);
        for (const t of groupToolNames) {
            if (disable) currentDisabled.add(t);
            else currentDisabled.delete(t);
        }
        vscode.postMessage({ type: 'setToolsBulk', disabled: [...currentDisabled] });
    });
    return btn;
}

function renderToolsCopyButton(): HTMLElement {
    const btn = el('span', 'tools-action-btn');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.title = 'Copy this chat\'s tool selection to clipboard';
    btn.setAttribute('aria-label', 'Copy tool selection');
    btn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<rect x="4" y="5" width="9" height="9" rx="1.2"/>'
        + '<path d="M6.5 5V3.2a1 1 0 0 1 1-1H12a1 1 0 0 1 1 1V10"/>'
        + '</svg>';
    const invoke = (e: Event): void => {
        e.stopPropagation();
        btn.classList.add('tools-action-btn-flash');
        setTimeout(() => btn.classList.remove('tools-action-btn-flash'), 700);
        vscode.postMessage({ type: 'copyToolSelection' });
    };
    btn.addEventListener('click', invoke);
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); invoke(e); }
    });
    return btn;
}

function renderToolsDefaultForProjectButton(): HTMLElement {
    const btn = el('span', 'tools-action-btn');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.title = 'DefaultForProject — use this chat\'s enabled tools for every new agent in this project';
    btn.setAttribute('aria-label', 'DefaultForProject: save tool selection');
    btn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M1.8 4.2h4l1.3 1.5h7.1v7.1a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/>'
        + '<path d="m6 10 1.4 1.4L10.8 8"/>'
        + '</svg>';
    const invoke = (e: Event): void => {
        e.stopPropagation();
        btn.classList.add('tools-action-btn-flash');
        setTimeout(() => btn.classList.remove('tools-action-btn-flash'), 700);
        vscode.postMessage({ type: 'setToolSelectionAsProjectDefault' });
    };
    btn.addEventListener('click', invoke);
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); invoke(e); }
    });
    return btn;
}

function renderToolsPasteButton(disabled: boolean): HTMLElement {
    const btn = el('span', `tools-action-btn${disabled ? ' tools-action-btn-disabled' : ''}`);
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', disabled ? '-1' : '0');
    btn.title = disabled
        ? 'Wait for the agent to finish'
        : 'Paste tool selection from clipboard';
    btn.setAttribute('aria-label', 'Paste tool selection');
    btn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<rect x="4" y="3.5" width="8" height="10.5" rx="1.2"/>'
        + '<path d="M6 3.5V2.6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v0.9"/>'
        + '<path d="M6 8.5h4M6 11h3"/>'
        + '</svg>';
    const invoke = (e: Event): void => {
        e.stopPropagation();
        if (disabled) return;
        btn.classList.add('tools-action-btn-flash');
        setTimeout(() => btn.classList.remove('tools-action-btn-flash'), 700);
        vscode.postMessage({ type: 'pasteToolSelection' });
    };
    btn.addEventListener('click', invoke);
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); invoke(e); }
    });
    return btn;
}

// Initial render in case message arrives before DOMContentLoaded fires.
render();
