import * as vscode from 'vscode';
import type { ServerMessage } from '../shared/protocol';
import { ChatController, ChatViewSink } from '../controllers/chat-controller';
import { ChatPanelConnection } from './chat-panel-connection';

/**
 * View type used both for created panels and for the panel serializer.
 * Distinct from the sidebar view id (`pi-code.chat`) to keep the two
 * registrations cleanly separated even though they share the same webview
 * bundle.
 */
export const CHAT_PANEL_VIEW_TYPE = 'pi-code.chatPanel';

/**
 * An editor-area webview panel bound to exactly one chat tab. The panel
 * registers itself with the {@link ChatController} as a {@link ChatViewSink}
 * keyed by `tabId`, so it receives only that tab's events.
 *
 * Panel state (tabId, sessionPath) is persisted by the webview via
 * `vscode.setState(...)` so that VS Code's `WebviewPanelSerializer` can
 * restore the panel after `Reload Window`.
 */
export class ChatPanel implements ChatViewSink, vscode.Disposable {
    private _panel: vscode.WebviewPanel;
    private _controller: ChatController;
    private _extensionUri: vscode.Uri;
    private _tabId: string;
    private _connection: ChatPanelConnection;
    private _disposables: vscode.Disposable[] = [];

    /** Panel sinks listen only to events for their bound tab. */
    get tabFilter(): string {
        return this._tabId;
    }

    constructor(
        panel: vscode.WebviewPanel,
        tabId: string,
        controller: ChatController,
        extensionUri: vscode.Uri,
    ) {
        this._panel = panel;
        this._tabId = tabId;
        this._controller = controller;
        this._extensionUri = extensionUri;
        this._connection = new ChatPanelConnection(
            this._tabId,
            (message, sourceTabId) => this._controller.handleMessage(message, sourceTabId),
            (value) => this._panel.webview.postMessage(value),
        );
        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'icons', 'piIcon1.png');

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri],
        };
        this._panel.webview.html = this._getHtml(this._panel.webview);

        const initialName = controller.getTabName(tabId);
        if (initialName) this._panel.title = formatPanelTitle(initialName);

        this._disposables.push(
            this._panel.webview.onDidReceiveMessage((value: unknown) => {
                void this._connection.receive(value);
            }),
            this._controller.onTabRenamed((e) => {
                if (e.tabId === this._tabId) this._panel.title = formatPanelTitle(e.name);
            }),
            // Track focus across existing panels so the launcher's
            // "active tab" view is always in sync with what the user
            // is actually looking at. Without this hook, `_activeTabId`
            // only updates on panel creation, so per-tab features
            // (e.g. the ToDo toggle in the sidebar) leak between
            // tabs as the user switches focus.
            this._panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.active) {
                    this._controller.markActiveTab(this._tabId);
                }
            }),
            this._panel.onDidDispose(() => this.dispose()),
        );

        this._controller.addSink(this);
        this._controller.registerPanel(this._tabId, this);
        // Send an initial 'ready' to mirror the sidebar's bootstrap, then push state.
        this.post({ type: 'ready' });
        this._controller.sendStateSync(this._tabId);
    }

    post(message: ServerMessage): void {
        this._connection.publish(message);
    }

    /** Bring this panel to the front of its column. */
    reveal(viewColumn?: vscode.ViewColumn): void {
        this._panel.reveal(viewColumn);
    }

    get tabId(): string {
        return this._tabId;
    }

    dispose(): void {
        this._connection.dispose();
        this._controller.removeSink(this);
        this._controller.unregisterPanel(this._tabId, this);
        for (const d of this._disposables) {
            try { d.dispose(); } catch { /* ignore */ }
        }
        this._disposables = [];
        // The webview panel itself is disposed by VS Code when the user closes
        // the editor tab; calling dispose() again here is a no-op for that path.
        try { this._panel.dispose(); } catch { /* already disposed */ }
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles', 'main.css')
        );
        const iconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'icons')
        );
        const nonce = getNonce();

        const config = vscode.workspace.getConfiguration('pi-code');
        const glowColor = config.get<string>('userMessageGlowColor', '#00aaff');
        const glowOpacity = (config.get<number>('userMessageGlowOpacity', 40) / 100).toFixed(2);
        const glowRgba = hexToRgba(glowColor, parseFloat(glowOpacity));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <style>
        :root {
            --pi-glow-border: 2px solid ${glowRgba};
            --pi-glow-shadow: 0 0 12px ${glowRgba};
        }
    </style>
    <title>Pi Code</title>
</head>
<body data-mode="panel">
    <div id="app"
         data-icons-uri="${iconsUri}"
         data-mode="panel"
         data-tab-id="${this._tabId}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/**
 * Create a fresh editor-tab panel for an existing chat tab. Used by the
 * `pi-code.openInEditor` command.
 */
export function createChatPanel(
    tabId: string,
    controller: ChatController,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
): ChatPanel {
    const title = formatPanelTitle(controller.getTabName(tabId) ?? 'Pi Code');
    const panel = vscode.window.createWebviewPanel(
        CHAT_PANEL_VIEW_TYPE,
        title,
        column,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
        },
    );
    return new ChatPanel(panel, tabId, controller, extensionUri);
}

function formatPanelTitle(name: string): string {
    const title = name.trim() || 'Pi Code';
    return title.length > 20 ? `${title.slice(0, 19)}…` : title;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function hexToRgba(hex: string, alpha: number): string {
    hex = hex.replace(/^#/, '');
    if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) {
        return `rgba(0, 170, 255, ${alpha})`;
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
