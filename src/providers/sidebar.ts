import * as vscode from 'vscode';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { ChatController, ChatViewSink } from '../controllers/chat-controller';
import { PiSessionManager } from '../pi/session';

/**
 * Sidebar webview view. Renders chat HTML and forwards messages between
 * the webview and the {@link ChatController}. All state and tab logic lives
 * in the controller; this class is a thin view that follows whichever tab
 * the controller marks as active (`tabFilter: 'active'`).
 */
export class SidebarProvider implements vscode.WebviewViewProvider, ChatViewSink {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _controller: ChatController;

    /** Sidebar always reflects the controller's active tab. */
    readonly tabFilter = 'active' as const;

    constructor(extensionUri: vscode.Uri, controller: ChatController) {
        this._extensionUri = extensionUri;
        this._controller = controller;
    }

    /** Sink: post a message to the sidebar webview, if it is resolved. */
    post(message: ServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    get activeSession(): PiSessionManager | undefined {
        return this._controller.activeSession;
    }

    async createTab(): Promise<void> {
        await this._controller.createTab();
    }

    showSessions(): void {
        this._controller.showSessions();
    }

    sendStateSync(): void {
        this._controller.sendStateSync();
    }

    async restorePersistedTabs(): Promise<void> {
        return this._controller.restorePersistedTabs();
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => {
            // sidebar sends no sourceTabId — the controller routes to the active tab
            this._controller.handleMessage(msg);
        });

        webviewView.onDidDispose(() => {
            this._controller.removeSink(this);
        });

        this._controller.addSink(this);
        this.post({ type: 'ready' });
        this._controller.sendStateSync();
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
<body data-mode="sidebar">
    <div id="app" data-icons-uri="${iconsUri}" data-mode="sidebar"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
