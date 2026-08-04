import * as vscode from 'vscode';
import { VsCodeOutputChannelLogger } from './adapters/vscode/output-channel-logger';
import {
    VsCodeSecretStore,
    createVsCodeSessionRuntimePorts,
} from './adapters/vscode/session-platform';
import { createVsCodeChatPlatformPorts } from './adapters/vscode/chat-platform';
import { VsCodeExternalUrlPort } from './adapters/vscode/external-url';
import { ExternalUrlService } from './core/ports/external-url';
import { VsCodeWorkspaceFileState } from './adapters/vscode/workspace-file-state';
import { DiffContentProvider, VsCodeDiffPresenter } from './adapters/vscode/diff-presenter';
import { PiSessionManager } from './pi/session';
import { getBundledPiPackagePaths } from './pi/bundled-packages';
import { getCodexUsageStore } from './pi/codex-usage-store';
import { getDeepSeekUsageStore } from './pi/deepseek-usage-store';
import { initCodexCatalogCache } from './pi/codex-catalog-cache';
import { LauncherView } from './providers/launcher-view';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { ChatController } from './controllers/chat-controller';
import { createChatPanel, CHAT_PANEL_VIEW_TYPE } from './providers/chat-panel';
import { ChatPanelSerializer } from './providers/chat-panel-serializer';
import { openRawPanel, RawPanelSerializer, RAW_PANEL_VIEW_TYPE, type RawPanelServices } from './providers/raw-panel';
import { notifyAuthChanged, reloadCredentials } from './pi/auth';
import { refreshModelRuntime } from './pi/models';

import { DiffManager } from './core/files/diff-manager';
import { CheckpointManager } from './core/files/checkpoint-manager';
import { NodeRawStorage } from './adapters/vscode/raw-storage';
import { RawRecorderRegistry } from './core/raw/raw-recorder';
import { registerSubagentSmokeCommand } from './pi/subagents/smoke/runner';
import { SubagentCoordinator } from './pi/subagents/coordinator';
import { SubagentRunStore } from './pi/subagents/persistence';
import { WriteIsolationManager } from './pi/subagents/write-isolation';
import { ChildToolFactoryRegistry } from './pi/subagents/child-tools';
import { WorkspaceFileMentions } from './workspace/file-mentions';
import { PerfLoggerImpl } from './core/perf/perf-logger-impl';
import { NOOP_PERF_LOGGER, type PerfLogger } from './core/ports/perf-logger';
import type { PerfSink } from './core/ports/perf-sink';
import { createFilePerfSink } from './adapters/vscode/file-perf-sink';

let controllerRef: ChatController | undefined;
let subagentCoordinatorRef: SubagentCoordinator | undefined;
let perfSinkRef: PerfSink | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Code');
    outputChannel.appendLine('Pi Code extension activating...');

    const perf = await setupPerfLogger(context, outputChannel);
    const activationStart = Date.now();
    perf.event('activation.begin');

    try {
        await perf.time('activation.accountUsageStores.init', async () => {
            getCodexUsageStore().init(context.globalState);
            getDeepSeekUsageStore().init(context.globalState);
            initCodexCatalogCache(context.globalState);
        });

        const subagentCoordinator = new SubagentCoordinator(
            vscode.workspace.getConfiguration('pi-code').get<number>('subagents.maxConcurrentGlobal', 4),
        );
        subagentCoordinatorRef = subagentCoordinator;
        const subagentStore = new SubagentRunStore(context.globalStorageUri.fsPath);
        await perf.time('activation.subagentStore.initialize', () => subagentStore.initialize());
        const subagentCleanup = await perf.time(
            'activation.subagentStore.cleanup',
            () => subagentStore.cleanup(30 * 24 * 60 * 60_000),
        );
        outputChannel.appendLine(
            `[subagent storage cleanup] records=${subagentCleanup.recordsRemoved} ` +
            `transcripts=${subagentCleanup.transcriptsRemoved} parents=${subagentCleanup.parentDirectoriesRemoved}`,
        );
        const writeIsolation = new WriteIsolationManager(
            context.globalStorageUri.fsPath,
            (message) => outputChannel.appendLine(message),
        );
        const childToolFactories = new ChildToolFactoryRegistry();
        const externalUrls = new ExternalUrlService(new VsCodeExternalUrlPort());
        const sessionLogger = new VsCodeOutputChannelLogger(outputChannel);
        const sessionSecrets = new VsCodeSecretStore(context.secrets);
        const bundledPackagePaths = perf.timeSync(
            'activation.getBundledPiPackagePaths',
            () => getBundledPiPackagePaths(
                context.extensionUri.fsPath,
                (msg) => sessionLogger.appendLine(msg),
            ),
        );
        const sessionPorts = createVsCodeSessionRuntimePorts(
            { bundledPiPackagePaths: bundledPackagePaths },
            getCodexUsageStore(),
        );
        const rawStorage = new NodeRawStorage(context.globalStorageUri.fsPath);
        const rawRecorderRegistry = new RawRecorderRegistry();
        const initialSession = new PiSessionManager(
            sessionLogger, sessionSecrets, subagentCoordinator, subagentStore, writeIsolation, childToolFactories,
            sessionPorts, rawStorage, rawRecorderRegistry, perf.child({ tabId: 'initial' }),
        );
        const prewarmFull = vscode.workspace.getConfiguration('pi-code').get<boolean>('prewarm.full', false);
        if (prewarmFull) {
            await perf.time('activation.session.initialize', () => initialSession.initialize());
        } else {
            // Lightweight prewarm: warm Node's module cache for the Pi SDK so
            // the first user click no longer pays the ~1s dynamic-import cost.
            // The session itself is created above but not initialized —
            // initialization is deferred until the first tab / interaction
            // that actually needs it.
            perf.event('activation.session.prewarm.lightweight');
            void import('@earendil-works/pi-coding-agent').then(
                () => perf.event('activation.session.prewarm.sdkReady'),
                (err) => outputChannel.appendLine(
                    `Lightweight SDK prewarm failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
            );
        }

        context.subscriptions.push(
            context.secrets.onDidChange(async (e) => {
                if (e.key.startsWith('pi-code.apiKey.')) {
                    await reloadCredentials();
                    await refreshModelRuntime((message) => outputChannel.appendLine(message));
                    notifyAuthChanged(e.key.slice('pi-code.apiKey.'.length));
                    outputChannel.appendLine(`Credentials reloaded after change to ${e.key}`);
                }
            }),
        );

        const diffContentProvider = new DiffContentProvider();
        const fileState = new VsCodeWorkspaceFileState();
        const diffPresenter = new VsCodeDiffPresenter(diffContentProvider);
        const fileMentions = new WorkspaceFileMentions(outputChannel);
        // warmup() is fire-and-forget; wrap the returned promise so we can
        // observe the async cost against activation without blocking it.
        perf.event('activation.fileMentions.warmup.dispatched');
        fileMentions.warmup();
        context.subscriptions.push(fileMentions);
        const chatPorts = createVsCodeChatPlatformPorts(context, fileMentions, {
            fileState,
            diffPresenter,
        });
        const checkpointManager = new CheckpointManager(fileState);
        const diffManager = new DiffManager(initialSession, checkpointManager, fileState);
        const statusBar = new StatusBarManager(initialSession);

        const controller = perf.timeSync('activation.chatController.construct', () => new ChatController(
            context, initialSession, diffManager, checkpointManager, outputChannel,
            subagentCoordinator, subagentStore, writeIsolation, childToolFactories, chatPorts,
            perf,
        ));
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

        const rawPanelServices: RawPanelServices = {
            extensionUri: context.extensionUri,
            storage: rawStorage,
            registry: rawRecorderRegistry,
            resolveDisplayTitle: (sessionPath) => controller.getSessionDisplayTitle(sessionPath),
        };

        context.subscriptions.push(
            controller,
            launcherView,
            vscode.window.registerWebviewViewProvider('pi-code.chat', launcherView),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,

            diffManager,
            checkpointManager,
            outputChannel,
            registerSubagentSmokeCommand(
                context,
                () => controller.activeSession,
                (snapshot, transcripts) => controller.showSubagentSmokeSnapshot(snapshot, transcripts),
            ),

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
                SettingsPanel.show(context.extensionUri, context.secrets, externalUrls, {
                    storage: rawStorage,
                    registry: rawRecorderRegistry,
                    onOpenRawView: (sessionPath) => openRawPanel(rawPanelServices, { sessionPath }),
                    resolveDisplayTitle: (sessionPath) => controller.getSessionDisplayTitle(sessionPath),
                });
            }),

            vscode.commands.registerCommand('pi-code.createTab', async () => {
                await controller.createTab();
            }),

            vscode.commands.registerCommand('pi-code.showSessions', () => {
                // Surface the launcher (which already lists session history).
                vscode.commands.executeCommand('pi-code.chat.focus');
            }),

            vscode.commands.registerCommand('pi-code.openRawView', async (arg?: { sessionPath?: string }) => {
                const sessionPath = arg?.sessionPath ?? controller.getActiveSessionPath();
                if (!sessionPath) {
                    void vscode.window.showInformationMessage(
                        'Open a Pi Code chat first — Raw View is per-session.',
                    );
                    return;
                }
                openRawPanel(rawPanelServices, {
                    sessionPath,
                    displayTitle: controller.getSessionDisplayTitle(sessionPath),
                });
            }),

            vscode.window.registerWebviewPanelSerializer(
                CHAT_PANEL_VIEW_TYPE,
                new ChatPanelSerializer(controller, context.extensionUri),
            ),
            vscode.window.registerWebviewPanelSerializer(
                RAW_PANEL_VIEW_TYPE,
                new RawPanelSerializer(rawPanelServices),
            ),
        );

        outputChannel.appendLine('Pi Code extension activated.');
        perf.event('activation.end', { totalMs: Date.now() - activationStart });
        void perf.flush();
    } catch (err: any) {
        subagentCoordinatorRef?.dispose();
        subagentCoordinatorRef = undefined;
        perf.event('activation.failed', { errorMessage: err?.message });
        void perf.flush();
        outputChannel.appendLine(`Failed to activate: ${err.message}`);
        vscode.window.showErrorMessage(`Pi Code failed to activate: ${err.message}`);
    }
}

async function setupPerfLogger(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
): Promise<PerfLogger> {
    const enabled = vscode.workspace.getConfiguration('pi-code').get<boolean>('perf.enabled', false);
    if (!enabled) return NOOP_PERF_LOGGER;
    try {
        const handle = await createFilePerfSink(context.globalStorageUri.fsPath, {
            extensionVersion: context.extension?.packageJSON?.version,
            vscodeVersion: vscode.version,
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.versions.node,
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        });
        perfSinkRef = handle.sink;
        outputChannel.appendLine(`Pi Code perf log: ${handle.filePath}`);
        return new PerfLoggerImpl({ sink: handle.sink, baseMeta: { runId: handle.runId } });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Pi Code perf log setup failed: ${message}`);
        return NOOP_PERF_LOGGER;
    }
}

export async function deactivate() {
    controllerRef = undefined;
    subagentCoordinatorRef?.dispose();
    subagentCoordinatorRef = undefined;
    await PiSessionManager.disposeGlobal();
    if (perfSinkRef) {
        try { await perfSinkRef.close(); } catch { /* diagnostic sink — swallow */ }
        perfSinkRef = undefined;
    }
}
