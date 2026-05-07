import * as vscode from 'vscode';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { ChatController, ChatViewSink } from '../controllers/chat-controller';

/**
 * View type used both for created panels and for the panel serializer.
 * Distinct from the sidebar view id (`pi-agent.chat`) to keep the two
 * registrations cleanly separated even though they share the same webview
 * bundle.
 */
export const CHAT_PANEL_VIEW_TYPE = 'pi-agent.chatPanel';

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

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri],
        };
        this._panel.webview.html = this._getHtml(this._panel.webview);

        const initialName = controller.getTabName(tabId);
        if (initialName) this._panel.title = initialName;

        this._disposables.push(
            this._panel.webview.onDidReceiveMessage((msg: ClientMessage) => {
                this._controller.handleMessage(msg, this._tabId);
            }),
            this._controller.onTabRenamed((e) => {
                if (e.tabId === this._tabId) this._panel.title = e.name;
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
        this._panel.webview.postMessage(message);
    }

    /** Bring this panel to the front of its column. */
    reveal(viewColumn?: vscode.ViewColumn): void {
        this._panel.reveal(viewColumn);
    }

    get tabId(): string {
        return this._tabId;
    }

    dispose(): void {
        this._controller.removeSink(this);
        this._controller.unregisterPanel(this._tabId);
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Pi Agent</title>
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
 * `pi-agent.openInEditor` command.
 */
export function createChatPanel(
    tabId: string,
    controller: ChatController,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
): ChatPanel {
    const title = controller.getTabName(tabId) ?? 'Pi Agent';
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

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
