import type {
    LauncherClientMessage, LauncherServerMessage, LauncherState,
    LauncherTabInfo, LauncherSessionInfo,
} from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: LauncherClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

let currentState: LauncherState = { tabs: [], recentSessions: [] };

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
    root.appendChild(renderOpenTabs());
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

function renderOpenTabs(): HTMLElement {
    const section = el('div', 'section');
    const heading = el('div', 'section-heading', 'Open chats');
    section.appendChild(heading);

    if (currentState.tabs.length === 0) {
        const empty = el('div', 'empty', 'No active chats. Click “New chat” to start one.');
        section.appendChild(empty);
        return section;
    }

    const list = el('div', 'tab-list');
    for (const tab of currentState.tabs) {
        list.appendChild(renderTabRow(tab));
    }
    section.appendChild(list);
    return section;
}

function renderTabRow(tab: LauncherTabInfo): HTMLElement {
    const row = el('div', 'tab-row' + (tab.isOpen ? '' : ' tab-row-closed'));
    row.dataset.tabId = tab.id;

    const icon = el('span', 'tab-status');
    if (tab.isStreaming) {
        icon.classList.add('status-streaming');
        icon.innerHTML = '<span class="spinner"></span>';
    } else if (tab.hasNotification) {
        icon.classList.add('status-unread');
        icon.textContent = '●';
    } else {
        icon.classList.add('status-idle');
        icon.textContent = '◌';
    }
    row.appendChild(icon);

    const main = el('div', 'tab-main');
    const name = el('div', 'tab-name', tab.name || 'Untitled');
    main.appendChild(name);
    if (tab.modelLabel) {
        const sub = el('div', 'tab-sub', tab.modelLabel);
        main.appendChild(sub);
    }
    row.appendChild(main);

    const closeBtn = el('button', 'row-action', '×');
    closeBtn.title = 'Remove from list (session is preserved on disk)';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'closeTab', tabId: tab.id });
    });
    row.appendChild(closeBtn);

    row.addEventListener('click', () => {
        vscode.postMessage({ type: 'openTab', tabId: tab.id });
    });

    return row;
}

function renderRecentSessions(): HTMLElement {
    const section = el('div', 'section');
    const heading = el('div', 'section-heading', 'History');
    section.appendChild(heading);

    // Show only sessions that aren't currently open (those are already up top).
    const closed = currentState.recentSessions.filter(s => !s.isOpen);
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
