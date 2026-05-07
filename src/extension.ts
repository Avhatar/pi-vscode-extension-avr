import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';

let sidebarRef: SidebarProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Agent');
    outputChannel.appendLine('Pi Agent extension activating...');

    try {
        const initialSession = new PiSessionManager(outputChannel, context.secrets);
        await initialSession.initialize();

        context.subscriptions.push(
            context.secrets.onDidChange(async (e) => {
                if (e.key.startsWith('pi-agent.apiKey.')) {
                    await sidebarRef?.activeSession?.reloadCredentials();
                    outputChannel.appendLine(`Credentials reloaded after change to ${e.key}`);
                }
            }),
        );

        const diffContentProvider = new DiffContentProvider();
        const checkpointManager = new CheckpointManager();
        const statusBar = new StatusBarManager(initialSession);

        const diffManager = new DiffManager(initialSession, checkpointManager);
        const sidebarProvider = new SidebarProvider(
            context.extensionUri, context, initialSession, diffManager, checkpointManager, outputChannel,
        );
        sidebarRef = sidebarProvider;

        // Restore tabs from previous session before the webview is shown
        await sidebarProvider.restorePersistedTabs();

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,

            diffManager,
            checkpointManager,
            outputChannel,

            vscode.commands.registerCommand('pi-agent.newChat', async () => {
                await sidebarProvider.activeSession?.newSession();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.abort', async () => {
                await sidebarProvider.activeSession?.abort();
            }),

            vscode.commands.registerCommand('pi-agent.selectModel', async () => {
                await sidebarProvider.activeSession?.showModelPicker();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.toggleThinking', async () => {
                const level = sidebarProvider.activeSession?.cycleThinkingLevel();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
            }),

            vscode.commands.registerCommand('pi-agent.openSettings', () => {
                SettingsPanel.show(context.extensionUri, context.secrets);
            }),

            vscode.commands.registerCommand('pi-agent.createTab', async () => {
                await sidebarProvider.createTab();
            }),

            vscode.commands.registerCommand('pi-agent.showSessions', () => {
                sidebarProvider.showSessions();
            }),
        );

        outputChannel.appendLine('Pi Agent extension activated.');
    } catch (err: any) {
        outputChannel.appendLine(`Failed to activate: ${err.message}`);
        vscode.window.showErrorMessage(`Pi Agent failed to activate: ${err.message}`);
    }
}

export async function deactivate() {
    sidebarRef = undefined;
    await PiSessionManager.disposeGlobal();
}
