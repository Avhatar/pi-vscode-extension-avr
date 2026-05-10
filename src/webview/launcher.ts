import type {
    LauncherClientMessage, LauncherServerMessage, LauncherState,
    LauncherSessionInfo, TaskInfo, TaskStatus, TodoSnapshot,
} from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: LauncherClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

let currentState: LauncherState = {
    tabs: [],
    recentSessions: [],
    historyCollapsed: true,
    todoCollapsed: false,
};

window.addEventListener('message', (event) => {
    const msg = event.data as LauncherServerMessage;
    if (msg.type === 'launcherState') {
        currentState = msg.state;
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

function render(): void {
    const root = document.getElementById('launcher')!;
    root.innerHTML = '';

    root.appendChild(renderToolbar());
    const todos = renderTodos();
    if (todos) root.appendChild(todos);
    root.appendChild(renderRecentSessions());
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
    settingsBtn.innerHTML = '<span class="toolbar-icon">⚙</span>';
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
    heading.title = collapsed ? 'Expand ToDo' : 'Collapse ToDo';

    const chevron = el('span', 'section-chevron', collapsed ? '▶' : '▼');
    heading.appendChild(chevron);
    heading.appendChild(el('span', 'section-title', 'ToDo'));
    if (enabled && visible.length > 0) {
        heading.appendChild(
            el('span', 'section-count', `${counts.completed}/${visible.length}`),
        );
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

function renderRecentSessions(): HTMLElement {
    const section = el('div', 'section history-section');

    // Show only sessions that aren't currently open in editor tabs.
    const closed = currentState.recentSessions.filter(s => !s.isOpen);

    const heading = el('button', 'section-heading section-heading-button');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(!currentState.historyCollapsed));
    heading.title = currentState.historyCollapsed ? 'Expand history' : 'Collapse history';

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

// Initial render in case message arrives before DOMContentLoaded fires.
render();
