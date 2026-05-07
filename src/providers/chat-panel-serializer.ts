import * as vscode from 'vscode';
import { ChatController } from '../controllers/chat-controller';
import { ChatPanel } from './chat-panel';

/**
 * Restores chat editor panels after a window reload. VS Code calls
 * `deserializeWebviewPanel` for every panel of view type
 * `pi-agent.chat` that was open at the previous shutdown, passing back
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
            new ChatPanel(panel, tabId, this._controller, this._extensionUri);
        } catch {
            // If anything goes wrong, dispose the panel so the user sees a
            // clean state instead of a hung empty webview.
            try { panel.dispose(); } catch { /* ignore */ }
        }
    }
}
