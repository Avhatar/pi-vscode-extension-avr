import * as vscode from 'vscode';
import type { LauncherClientMessage, LauncherServerMessage } from '../shared/protocol';
import { ChatController } from '../controllers/chat-controller';

/**
 * Sidebar webview view that acts as a launcher: shows recent sessions and
 * quick actions to start a new chat or open settings. The chat itself lives
 * in editor-area `WebviewPanel`s; the launcher only points at them.
 */
export class LauncherView implements vscode.WebviewViewProvider, vscode.Disposable {
    private static readonly HISTORY_COLLAPSED_KEY = 'pi-code.launcher.historyCollapsed';
    private static readonly TODO_COLLAPSED_KEY = 'pi-code.launcher.todoCollapsed';
    private static readonly SUBAGENTS_COLLAPSED_KEY = 'pi-code.launcher.subagentsCollapsed';
    private static readonly TOOLS_COLLAPSED_KEY = 'pi-code.launcher.toolsCollapsed';

    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _controller: ChatController;
    private _globalState: vscode.Memento;
    private _stateSubscription?: vscode.Disposable;

    constructor(extensionUri: vscode.Uri, controller: ChatController, globalState: vscode.Memento) {
        this._extensionUri = extensionUri;
        this._controller = controller;
        this._globalState = globalState;
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

        webviewView.webview.onDidReceiveMessage((msg: LauncherClientMessage) => {
            this._handleMessage(msg);
        });

        // Push fresh state whenever the controller signals a change.
        this._stateSubscription = this._controller.onLauncherStateChanged(() => {
            this._sendState();
        });

        webviewView.onDidDispose(() => {
            this._stateSubscription?.dispose();
            this._stateSubscription = undefined;
        });

        // Initial state push.
        this._sendState();
    }

    private async _handleMessage(msg: LauncherClientMessage): Promise<void> {
        try {
            switch (msg.type) {
                case 'getLauncherState':
                    await this._sendState();
                    break;
                case 'createTab':
                    // Controller's _createTab auto-opens the editor panel via the registered opener.
                    await this._controller.createTab();
                    break;
                case 'openTab':
                    this._controller.openOrFocusPanel(msg.tabId);
                    break;
                case 'closeTab':
                    await this._controller.dropTab(msg.tabId);
                    break;
                case 'openSession': {
                    const existing = this._controller.findTabIdBySessionPath(msg.sessionPath);
                    let tabId: string | undefined = existing;
                    if (!tabId) {
                        tabId = await this._controller.createTabFromSessionPath(msg.sessionPath);
                    }
                    if (tabId) this._controller.openOrFocusPanel(tabId);
                    break;
                }
                case 'deleteSession':
                    await this._controller.deleteHistorySession(msg.sessionPath);
                    await this._sendState();
                    break;
                case 'setHistoryCollapsed':
                    await this._globalState.update(LauncherView.HISTORY_COLLAPSED_KEY, msg.collapsed);
                    await this._sendState();
                    break;
                case 'setTodoCollapsed':
                    await this._globalState.update(LauncherView.TODO_COLLAPSED_KEY, msg.collapsed);
                    await this._sendState();
                    break;
                case 'setTodoEnabled':
                    await this._controller.setActiveTabTodoEnabled(msg.enabled);
                    break;
                case 'setSubagentsCollapsed':
                    await this._globalState.update(LauncherView.SUBAGENTS_COLLAPSED_KEY, msg.collapsed);
                    await this._sendState();
                    break;
                case 'setSubagentsEnabled':
                    await this._controller.setActiveTabSubagentsEnabled(msg.enabled);
                    break;
                case 'stopSubagent':
                    if (!this._controller.stopActiveTabSubagent(msg.agentId)) {
                        vscode.window.setStatusBarMessage('Pi Code: subagent is no longer running.', 2500);
                    }
                    break;
                case 'inspectSubagent':
                    if (!await this._controller.inspectActiveTabSubagent(msg.agentId)) {
                        vscode.window.showWarningMessage('Pi Code: persistent subagent transcript is unavailable.');
                    }
                    break;
                case 'resumeSubagent': {
                    const task = await vscode.window.showInputBox({
                        title: 'Resume subagent',
                        prompt: 'Enter a self-contained follow-up task for the existing child transcript.',
                        ignoreFocusOut: true,
                        validateInput: (value) => value.trim() ? undefined : 'A follow-up task is required.',
                    });
                    if (task?.trim()) await this._controller.resumeActiveTabSubagent(msg.agentId, task.trim());
                    break;
                }
                case 'steerSubagent': {
                    const guidance = await vscode.window.showInputBox({
                        title: 'Steer running subagent',
                        prompt: 'Send additional guidance to the active child run.',
                        ignoreFocusOut: true,
                        validateInput: (value) => value.trim() ? undefined : 'Guidance is required.',
                    });
                    if (guidance?.trim() && !await this._controller.steerActiveTabSubagent(msg.agentId, guidance.trim())) {
                        vscode.window.showWarningMessage('Pi Code: subagent is no longer accepting steering.');
                    }
                    break;
                }
                case 'dismissSubagent':
                    if (!await this._controller.dismissActiveTabSubagent(msg.agentId)) {
                        vscode.window.setStatusBarMessage('Pi Code: only completed subagent rows can be dismissed.', 2500);
                    }
                    break;
                case 'reviewSubagentWorktree':
                    if (!await this._controller.reviewActiveTabSubagentWorktree(msg.agentId)) {
                        vscode.window.showWarningMessage('Pi Code: preserved subagent worktree is unavailable.');
                    }
                    break;
                case 'applySubagentWorktree': {
                    const confirmed = await vscode.window.showWarningMessage(
                        'Apply this subagent worktree patch to the primary workspace and stage the changes?',
                        { modal: true },
                        'Apply patch',
                    );
                    if (confirmed === 'Apply patch' && !await this._controller.applyActiveTabSubagentWorktree(msg.agentId)) {
                        vscode.window.showWarningMessage('Pi Code: worktree patch is unavailable.');
                    }
                    break;
                }
                case 'cleanupSubagentWorktree': {
                    const confirmed = await vscode.window.showWarningMessage(
                        'Remove this preserved subagent worktree? Unapplied changes will be discarded.',
                        { modal: true },
                        'Remove worktree',
                    );
                    if (confirmed === 'Remove worktree') {
                        await this._controller.cleanupActiveTabSubagentWorktree(msg.agentId);
                    }
                    break;
                }
                case 'dismissSubagentSmoke':
                    this._controller.dismissSubagentSmokeSnapshot();
                    break;
                case 'setPlanModeEnabled':
                    await this._controller.setActiveTabPlanModeEnabled(msg.enabled);
                    break;
                case 'setFileUndoViewEnabled':
                    await this._controller.setActiveTabFileUndoViewEnabled(msg.enabled);
                    break;
                case 'setToolDisabled':
                    await this._controller.setActiveTabToolDisabled(msg.toolName, msg.disabled);
                    break;
                case 'setToolsBulk':
                    await this._controller.setActiveTabToolsBulk(msg.disabled);
                    break;
                case 'setToolsCollapsed':
                    await this._globalState.update(LauncherView.TOOLS_COLLAPSED_KEY, msg.collapsed);
                    await this._sendState();
                    break;
                case 'copyToolSelection':
                    await this._controller.copyActiveTabToolSelection();
                    break;
                case 'pasteToolSelection':
                    await this._controller.pasteActiveTabToolSelection();
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('pi-code.openSettings');
                    break;
            }
        } catch (err: any) {
            // Surface as an info message — the launcher webview is too small for an error UI.
            vscode.window.showErrorMessage(`Pi Code: ${err.message ?? String(err)}`);
        }
    }

    private async _sendState(): Promise<void> {
        if (!this._view) return;
        const state = await this._controller.computeLauncherState();
        this._post({
            type: 'launcherState',
            state: {
                ...state,
                historyCollapsed: this._globalState.get<boolean>(LauncherView.HISTORY_COLLAPSED_KEY, true),
                todoCollapsed: this._globalState.get<boolean>(LauncherView.TODO_COLLAPSED_KEY, false),
                subagentsCollapsed: this._globalState.get<boolean>(LauncherView.SUBAGENTS_COLLAPSED_KEY, false),
                toolsCollapsed: this._globalState.get<boolean>(LauncherView.TOOLS_COLLAPSED_KEY, true),
            },
        });
    }

    private _post(message: LauncherServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    dispose(): void {
        this._stateSubscription?.dispose();
        this._stateSubscription = undefined;
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'launcher.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles', 'launcher.css')
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
    <title>Pi Code</title>
</head>
<body>
    <div id="launcher" data-icons-uri="${iconsUri}"></div>
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
