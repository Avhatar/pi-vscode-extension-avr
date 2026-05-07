import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { ChatController } from './controllers/chat-controller';
import { createChatPanel, CHAT_PANEL_VIEW_TYPE } from './providers/chat-panel';
import { ChatPanelSerializer } from './providers/chat-panel-serializer';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';

let controllerRef: ChatController | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Agent');
    outputChannel.appendLine('Pi Agent extension activating...');

    try {
        const initialSession = new PiSessionManager(outputChannel, context.secrets);
        await initialSession.initialize();

        context.subscriptions.push(
            context.secrets.onDidChange(async (e) => {
                if (e.key.startsWith('pi-agent.apiKey.')) {
                    await controllerRef?.activeSession?.reloadCredentials();
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

        // Restore tabs from previous session before the webview is shown
        await controller.restorePersistedTabs();

        const sidebarProvider = new SidebarProvider(context.extensionUri, controller);

        context.subscriptions.push(
            controller,
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,

            diffManager,
            checkpointManager,
            outputChannel,

            vscode.commands.registerCommand('pi-agent.newChat', async () => {
                await controller.activeSession?.newSession();
                controller.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.abort', async () => {
                await controller.activeSession?.abort();
            }),

            vscode.commands.registerCommand('pi-agent.selectModel', async () => {
                await controller.activeSession?.showModelPicker();
                controller.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.toggleThinking', async () => {
                const level = controller.activeSession?.cycleThinkingLevel();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
                controller.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
            }),

            vscode.commands.registerCommand('pi-agent.openSettings', () => {
                SettingsPanel.show(context.extensionUri, context.secrets);
            }),

            vscode.commands.registerCommand('pi-agent.createTab', async () => {
                await controller.createTab();
            }),

            vscode.commands.registerCommand('pi-agent.showSessions', () => {
                controller.showSessions();
            }),

            vscode.commands.registerCommand('pi-agent.openInEditor', () => {
                const tabId = controller.activeTabId;
                if (!tabId) {
                    vscode.window.showWarningMessage('Pi Agent: no active chat to open.');
                    return;
                }
                createChatPanel(tabId, controller, context.extensionUri);
            }),

            vscode.window.registerWebviewPanelSerializer(
                CHAT_PANEL_VIEW_TYPE,
                new ChatPanelSerializer(controller, context.extensionUri),
            ),
        );

        outputChannel.appendLine('Pi Agent extension activated.');
    } catch (err: any) {
        outputChannel.appendLine(`Failed to activate: ${err.message}`);
        vscode.window.showErrorMessage(`Pi Agent failed to activate: ${err.message}`);
    }
}

export async function deactivate() {
    controllerRef = undefined;
    await PiSessionManager.disposeGlobal();
}
