import type {
    LauncherClientMessage, LauncherServerMessage, LauncherState,
    LauncherSessionInfo,
} from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: LauncherClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

let currentState: LauncherState = { tabs: [], recentSessions: [], historyCollapsed: true };

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

function renderRecentSessions(): HTMLElement {
    const section = el('div', 'section');

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
