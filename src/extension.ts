import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { getCodexUsageStore } from './pi/codex-usage-store';
import { LauncherView } from './providers/launcher-view';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { ChatController } from './controllers/chat-controller';
import { createChatPanel, CHAT_PANEL_VIEW_TYPE } from './providers/chat-panel';
import { ChatPanelSerializer } from './providers/chat-panel-serializer';
import { notifyAuthChanged, reloadCredentials } from './pi/auth';
import { syncCustomProviders } from './pi/models';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';

let controllerRef: ChatController | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Code');
    outputChannel.appendLine('Pi Code extension activating...');

    try {
        getCodexUsageStore().init(context.globalState);

        const initialSession = new PiSessionManager(outputChannel, context.secrets);
        await initialSession.initialize();

        context.subscriptions.push(
            context.secrets.onDidChange(async (e) => {
                if (e.key.startsWith('pi-code.apiKey.')) {
                    await reloadCredentials();
                    await syncCustomProviders();
                    notifyAuthChanged();
                    outputChannel.appendLine(`Credentials reloaded after change to ${e.key}`);
                }
            }),
        );

        const diffContentProvider = new DiffContentProvider();
        const checkpointManager = new CheckpointManager();
        const statusBar = new StatusBarManager(initialSession);

        const diffManager = new DiffManager(initialSession, checkpointManager);

        const controller = new ChatController(
            context, initialSession, diffManager, checkpointManager, outputChannel,
        );
        controllerRef = controller;

        // Wire the panel-opening factory so the controller can spawn editor
        // panels itself (used by `createTab` and the launcher).
        controller.setPanelOpener((tabId) => {
            createChatPanel(tabId, controller, context.extensionUri);
        });

        // Phase 3 relies on VS Code's `WebviewPanelSerializer` to bring panels
        // (and their backing tabs) back across reloads, so we no longer need
        // our own eager `restorePersistedTabs()` call. Clear any leftover
        // pre-0.3.0 tab state so users upgrading don't see ghost entries.
        context.workspaceState.update('pi-code.tabs', undefined);

        const launcherView = new LauncherView(context.extensionUri, controller, context.globalState);

        context.subscriptions.push(
            controller,
            launcherView,
            vscode.window.registerWebviewViewProvider('pi-code.chat', launcherView),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,

            diffManager,
            checkpointManager,
            outputChannel,

            vscode.commands.registerCommand('pi-code.newChat', async () => {
                // "New Chat" now means a fresh session in a fresh editor tab,
                // matching the launcher's behaviour.
                await controller.createTab();
            }),

            vscode.commands.registerCommand('pi-code.abort', async () => {
                await controller.activeSession?.abort();
            }),

            vscode.commands.registerCommand('pi-code.selectModel', async () => {
                await controller.activeSession?.showModelPicker();
                controller.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-code.toggleThinking', async () => {
                const level = controller.activeSession?.cycleThinkingLevel();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
                controller.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-code.focusChat', () => {
                // Reveal the active chat panel if there is one; otherwise fall
                // back to focusing the launcher.
                const tabId = controller.activeTabId;
                if (tabId) {
                    controller.openOrFocusPanel(tabId);
                } else {
                    vscode.commands.executeCommand('pi-code.chat.focus');
                }
            }),

            vscode.commands.registerCommand('pi-code.openSettings', () => {
                SettingsPanel.show(context.extensionUri, context.secrets);
            }),

            vscode.commands.registerCommand('pi-code.createTab', async () => {
                await controller.createTab();
            }),

            vscode.commands.registerCommand('pi-code.showSessions', () => {
                // Surface the launcher (which already lists session history).
                vscode.commands.executeCommand('pi-code.chat.focus');
            }),

            vscode.window.registerWebviewPanelSerializer(
                CHAT_PANEL_VIEW_TYPE,
                new ChatPanelSerializer(controller, context.extensionUri),
            ),
        );

        outputChannel.appendLine('Pi Code extension activated.');
    } catch (err: any) {
        outputChannel.appendLine(`Failed to activate: ${err.message}`);
        vscode.window.showErrorMessage(`Pi Code failed to activate: ${err.message}`);
    }
}

export async function deactivate() {
    controllerRef = undefined;
    await PiSessionManager.disposeGlobal();
}
