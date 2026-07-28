import * as vscode from 'vscode';
import { ChatController } from '../controllers/chat-controller';
import { ChatPanel, buildInitialLoadingOverlay } from './chat-panel';

/**
 * Restores chat editor panels after a window reload. VS Code calls
 * `deserializeWebviewPanel` for every panel of view type
 * `pi-code.chat` that was open at the previous shutdown, passing back
 * whatever the webview persisted via `vscode.setState(...)`.
 *
 * The serialized state (`{ tabId?, sessionPath? }`) is just a pointer
 * to the underlying chat session on disk. We use `sessionPath` to find
 * (or create) a {@link TabState} inside the controller, then attach the
 * panel to that tab.
 */
export class ChatPanelSerializer implements vscode.WebviewPanelSerializer {
    constructor(
        private readonly _controller: ChatController,
        private readonly _extensionUri: vscode.Uri,
    ) {}

    async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: { tabId?: string; sessionPath?: string } | undefined,
    ): Promise<void> {
        try {
            // Set a loading overlay on the panel *before* awaiting session
            // restoration. Without this, VS Code hands us a panel whose
            // webview.html has not yet been set — the user stares at a blank
            // editor tab for 200-700 ms while `createTabFromSessionPath`
            // rebuilds the session on disk. The overlay is superseded by
            // ChatPanel's own initial HTML (which also shows the same
            // overlay) as soon as the constructor runs below.
            panel.webview.options = { enableScripts: false };
            panel.webview.html = buildRestorationLoadingHtml();

            const sessionPath = state?.sessionPath;
            let tabId = sessionPath
                ? this._controller.findTabIdBySessionPath(sessionPath)
                : undefined;

            if (!tabId && sessionPath) {
                // Session is not currently open in any tab — load it from disk.
                tabId = await this._controller.createTabFromSessionPath(sessionPath);
            }

            if (!tabId) {
                // No way to recover — fall back to whatever tab is active so
                // the user is not left with a blank panel.
                tabId = this._controller.activeTabId;
            }

            // ChatPanel wires up the webview, sink registration, and disposal.
            // Its own constructor overwrites webview.html with the full HTML,
            // which also carries the loading overlay in the initial markup so
            // the transition from the placeholder above is seamless.
            new ChatPanel(panel, tabId, this._controller, this._extensionUri);
        } catch {
            // If anything goes wrong, dispose the panel so the user sees a
            // clean state instead of a hung empty webview.
            try { panel.dispose(); } catch { /* ignore */ }
        }
    }
}

/**
 * Standalone HTML shown on the restoring panel between `deserializeWebviewPanel`
 * being called and `ChatPanel` overwriting the webview. Intentionally
 * script-free so VS Code does not have to compile a full CSP for a ~200ms
 * placeholder; visual styling is inlined to avoid a stylesheet request.
 */
function buildRestorationLoadingHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Pi Code</title>
    <style>
        body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
        #initial-loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
        .initial-loading-card { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 40px; color: var(--vscode-descriptionForeground); }
        .initial-loading-spinner { width: 28px; height: 28px; border: 2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35)); border-top-color: var(--vscode-focusBorder, #007acc); border-radius: 50%; animation: spin 900ms linear infinite; }
        .initial-loading-label { font-size: 13px; font-weight: 500; color: var(--vscode-foreground); }
        .initial-loading-sublabel { font-size: 12px; color: var(--vscode-descriptionForeground); opacity: 0.75; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    ${buildInitialLoadingOverlay('Restoring chat…')}
</body>
</html>`;
}
