import * as vscode from 'vscode';
import { PiSessionManager } from '../pi/session';
import type { ClientMessage, ServerMessage, TabInfo } from '../shared/protocol';
import { DiffManager } from '../providers/diff';
import { CheckpointManager } from '../providers/checkpoint';
import { onAuthChanged } from '../pi/auth';

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

interface TabState {
    id: string;
    name: string;
    session: PiSessionManager;
    diffManager: DiffManager;
    checkpointManager: CheckpointManager;
    turnCounter: number;
    suspendedMessages: any[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    messageMeta: Map<number, MessageMeta>;
    hasNotification: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    queuedMessages: string[];
    /** Locally tracked streaming flag – the SDK's isStreaming lags behind agent_end. */
    isStreamingLocal: boolean;
}

interface PersistedTabsState {
    tabs: Array<{ name: string; sessionPath: string }>;
    activeIndex: number;
}

export interface ChatViewSink {
    post(message: ServerMessage): void;
}

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

function makeTabState(
    id: string,
    session: PiSessionManager,
    diffManager: DiffManager,
    checkpointManager: CheckpointManager,
): TabState {
    return {
        id,
        name: 'New Agent',
        session,
        diffManager,
        checkpointManager,
        turnCounter: 0,
        suspendedMessages: [],
        streamingText: '',
        streamingThinking: '',
        isThinking: false,
        thinkingStartTime: 0,
        streamingThinkingDuration: 0,
        agentStartTime: 0,
        messageMeta: new Map(),
        hasNotification: false,
        pendingApprovals: new Map(),
        queuedMessages: [],
        isStreamingLocal: false,
    };
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { type: obj?.type, _serializationFailed: true };
    }
}

/**
 * Owns all chat tab state and routes messages from views to the appropriate
 * tab. View layers (sidebar, editor panels) attach themselves as a
 * `ChatViewSink` and forward webview messages via `handleMessage`.
 *
 * Phase 1 hosts a single sink (the sidebar). Phase 2+ will key sinks by
 * `tabId` so that each editor panel receives only its own updates.
 */
export class ChatController implements vscode.Disposable {
    private _outputChannel: vscode.OutputChannel;
    private _context: vscode.ExtensionContext;

    private _tabs = new Map<string, TabState>();
    private _activeTabId = '';
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _authChangedSubscription?: vscode.Disposable;

    private _sink?: ChatViewSink;

    constructor(
        context: vscode.ExtensionContext,
        initialSession: PiSessionManager,
        initialDiffManager: DiffManager,
        initialCheckpointManager: CheckpointManager,
        outputChannel: vscode.OutputChannel,
    ) {
        this._context = context;
        this._outputChannel = outputChannel;

        const id = nextTabId();
        const tab = makeTabState(id, initialSession, initialDiffManager, initialCheckpointManager);
        this._tabs.set(id, tab);
        this._activeTabId = id;
        this._subscribeTab(tab);

        this._authChangedSubscription = onAuthChanged(() => {
            this._broadcastModels();
        });
    }

    setSink(sink: ChatViewSink | undefined): void {
        this._sink = sink;
    }

    /** Expose the active tab's session for global commands (palette, keybindings). */
    get activeSession(): PiSessionManager | undefined {
        return this._tabs.get(this._activeTabId)?.session;
    }

    /** Public: create a new agent tab. */
    async createTab(): Promise<void> {
        await this._createTab();
    }

    /** Public: tell the webview to show the session history list. */
    showSessions(): void {
        this.handleMessage({ type: 'getSessions' });
    }

    private get _activeTab(): TabState {
        return this._tabs.get(this._activeTabId)!;
    }

    private _post(message: ServerMessage): void {
        this._sink?.post(message);
    }

    private _broadcastModels(): void {
        const tab = this._activeTab;
        if (!tab) return;
        const models = tab.session.getModels();
        const current = tab.session.getCurrentModel();
        const thinkingLevel = tab.session.getThinkingLevel();
        this._post({ type: 'models', models, current, thinkingLevel });
    }

    private _subscribeTab(tab: TabState): void {
        const unsubs: (() => void)[] = [];

        unsubs.push(
            tab.session.events.onAll((event) => {
                this._handleTabEvent(tab, event);
            }),
        );

        unsubs.push(
            tab.diffManager.onFileChange((change) => {
                if (tab.id === this._activeTabId) {
                    this._post({ type: 'fileChange', change });
                }
            }),
        );

        tab.session.setToolApprovalHandler(async (toolCallId, toolName, args) => {
            return this._requestToolApproval(tab, toolCallId, toolName, args);
        });

        this._tabSubscriptions.set(tab.id, unsubs);
    }

    private _unsubscribeTab(tabId: string): void {
        const unsubs = this._tabSubscriptions.get(tabId);
        if (unsubs) {
            for (const unsub of unsubs) unsub();
            this._tabSubscriptions.delete(tabId);
        }
    }

    private _handleTabEvent(tab: TabState, event: any): void {
        const isActive = tab.id === this._activeTabId;

        if (event.type === 'agent_start') {
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = Date.now();
            tab.isStreamingLocal = true;
            if (isActive) {
                vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', true);
            }
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const msgs = tab.session.getMessages();
            let assistantOrdinal = 0;
            let lastOrdinal = -1;
            for (let i = 0; i < msgs.length; i++) {
                if (msgs[i].role === 'assistant') {
                    lastOrdinal = assistantOrdinal;
                    assistantOrdinal++;
                }
            }
            if (lastOrdinal >= 0) {
                tab.messageMeta.set(lastOrdinal, {
                    thinkingDurationSec: tab.streamingThinkingDuration,
                    messageEndTime: Date.now(),
                });
            }
            tab.streamingThinkingDuration = 0;
        }

        if (event.type === 'agent_end') {
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = 0;
            tab.isStreamingLocal = false;
            if (isActive) {
                vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
            } else {
                tab.hasNotification = true;
            }
            this._persistTabs();

            if (tab.queuedMessages.length > 0) {
                const text = tab.queuedMessages.shift()!;
                if (tab.checkpointManager.rollbackPoint !== null) {
                    tab.checkpointManager.discardSuspended();
                    tab.diffManager.discardSuspended();
                    tab.suspendedMessages = [];
                }
                tab.turnCounter++;
                const turnIdx = tab.turnCounter;
                tab.checkpointManager.startTurn(turnIdx);
                tab.diffManager.setCurrentTurn(turnIdx);
                tab.session.prompt(text);
            }
        }

        if (event.type === 'message_update' && event.assistantMessageEvent) {
            const ae = event.assistantMessageEvent;
            switch (ae.type) {
                case 'thinking_start':
                    tab.isThinking = true;
                    tab.streamingThinking = '';
                    tab.thinkingStartTime = Date.now();
                    tab.streamingThinkingDuration = 0;
                    break;
                case 'thinking_delta':
                    tab.streamingThinking += ae.delta ?? '';
                    break;
                case 'thinking_end':
                    tab.isThinking = false;
                    if (tab.thinkingStartTime > 0) {
                        tab.streamingThinkingDuration = Math.round(
                            (Date.now() - tab.thinkingStartTime) / 1000
                        );
                    }
                    break;
                case 'text_delta':
                    tab.streamingText += ae.delta ?? '';
                    break;
            }
        }

        this._updateTabName(tab);

        if (isActive) {
            this._post({ type: 'agentEvent', event: safeSerialize(event) });

            if (
                event.type === 'agent_start' ||
                event.type === 'agent_end' ||
                event.type === 'message_end' ||
                event.type === 'turn_end'
            ) {
                this.sendStateSync();
            }
        } else if (event.type === 'agent_start' || event.type === 'agent_end') {
            this.sendStateSync();
        }
    }

    private _updateTabName(tab: TabState): void {
        const sessionName = tab.session.session?.sessionName;
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
            this._persistTabs();
            return;
        }
        // Derive tab name from first user message if still default
        if (tab.name === 'New Agent') {
            const msgs = tab.session.getMessages();
            const firstUser = msgs.find((m: any) => m.role === 'user');
            if (firstUser) {
                const content = firstUser.content;
                const text: string = typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                        ? (content.find((c: any) => c.type === 'text')?.text ?? '')
                        : '';
                const trimmed = text.replace(/\n/g, ' ').trim().slice(0, 60);
                if (trimmed) {
                    tab.name = trimmed;
                    this._persistTabs();
                }
            }
        }
    }

    sendStateSync(): void {
        const tab = this._activeTab;
        if (!tab) return;

        const state = tab.session.serializeState();
        // Override isStreaming with our locally tracked flag because the SDK
        // sets session.isStreaming = false only AFTER the agent_end listener
        // returns (in finishRun), so reading it here during agent_end would
        // still see `true` and the webview would think the agent is still working.
        state.isStreaming = tab.isStreamingLocal;
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((m: any) => safeSerialize(m)),
            ];
        }
        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = this._getTabInfos();
        state.activeTabId = this._activeTabId;
        state.streamingText = tab.streamingText;
        state.streamingThinking = tab.streamingThinking;
        state.isThinking = tab.isThinking;
        state.thinkingStartTime = tab.thinkingStartTime;
        state.streamingThinkingDuration = tab.streamingThinkingDuration;
        if (tab.queuedMessages.length > 0) {
            state.queuedMessages = tab.queuedMessages;
        }
        let assistantOrdinal = 0;
        for (let i = 0; i < state.messages.length; i++) {
            if (state.messages[i].role === 'assistant') {
                const meta = tab.messageMeta.get(assistantOrdinal);
                if (meta) {
                    state.messages[i]._thinkingDurationSec = meta.thinkingDurationSec;
                    state.messages[i]._messageEndTime = meta.messageEndTime;
                }
                assistantOrdinal++;
            }
        }
        this._post({ type: 'stateSync', state });
    }

    private _getTabInfos(): TabInfo[] {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            id,
            name: tab.name,
            isActive: id === this._activeTabId,
            isStreaming: tab.isStreamingLocal,
            hasNotification: tab.hasNotification,
        }));
    }

    async handleMessage(msg: ClientMessage): Promise<void> {
        try {
            const tab = this._activeTab;

            switch (msg.type) {
                case 'prompt': {
                    if (tab.checkpointManager.rollbackPoint !== null) {
                        tab.checkpointManager.discardSuspended();
                        tab.diffManager.discardSuspended();
                        tab.suspendedMessages = [];
                    }
                    tab.turnCounter++;
                    const turnIdx = tab.turnCounter;
                    tab.checkpointManager.startTurn(turnIdx);
                    tab.diffManager.setCurrentTurn(turnIdx);
                    await tab.session.prompt(msg.text);
                    break;
                }
                case 'steer':
                    await tab.session.steer(msg.text);
                    break;
                case 'queueMessage':
                    tab.queuedMessages.push(msg.text);
                    this.sendStateSync();
                    break;
                case 'editQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length && msg.text.trim()) {
                        tab.queuedMessages[msg.index] = msg.text.trim();
                    }
                    this.sendStateSync();
                    break;
                case 'removeQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                        tab.queuedMessages.splice(msg.index, 1);
                    }
                    this.sendStateSync();
                    break;
                case 'cancelQueue':
                    tab.queuedMessages = [];
                    this.sendStateSync();
                    break;
                case 'followUp':
                    await tab.session.followUp(msg.text);
                    break;
                case 'abort':
                    await tab.session.abort();
                    break;
                case 'getModels': {
                    const models = tab.session.getModels();
                    const current = tab.session.getCurrentModel();
                    const thinkingLevel = tab.session.getThinkingLevel();
                    this._post({ type: 'models', models, current, thinkingLevel });
                    break;
                }
                case 'setModel':
                    await tab.session.setModel(msg.provider, msg.modelId);
                    this.sendStateSync();
                    break;
                case 'setThinkingLevel':
                    tab.session.setThinkingLevel(msg.level);
                    this.sendStateSync();
                    break;
                case 'newSession':
                    await tab.session.newSession();
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.name = 'New Agent';
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.isStreamingLocal = false;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    this.sendStateSync();
                    break;
                case 'loadSession':
                    await tab.session.loadSession(msg.sessionPath);
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.isStreamingLocal = false;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    tab.name = 'New Agent'; // reset so _updateTabName re-derives from first message
                    this._updateTabName(tab);
                    this._persistTabs();
                    this.sendStateSync();
                    break;
                case 'getSessions': {
                    const sessions = await tab.session.getSessions();
                    const currentId = tab.session.session?.sessionId;
                    this._post({ type: 'sessions', sessions, currentSessionId: currentId });
                    break;
                }
                case 'getState':
                    this.sendStateSync();
                    break;
                case 'getSkills': {
                    const skills = tab.session.getSkills();
                    this._post({ type: 'skills', skills });
                    break;
                }
                case 'approveToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, true);
                    break;
                case 'rejectToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, false);
                    break;
                case 'openFile': {
                    const fileUri = vscode.Uri.file(msg.filePath);
                    try {
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(doc, { preview: true });
                    } catch { /* file may not exist */ }
                    break;
                }
                case 'openDiff':
                    await tab.diffManager.openDiff(msg.filePath, msg.toolCallId);
                    break;
                case 'undoFileChange':
                    await tab.diffManager.undoFileChange(msg.filePath, msg.toolCallId);
                    this.sendStateSync();
                    break;
                case 'restoreCheckpoint': {
                    const restored = await tab.checkpointManager.restoreCheckpoint(msg.messageIndex);
                    tab.diffManager.suspendChangesAfter(msg.messageIndex);

                    const allMsgs = tab.session.getMessages();
                    const cutoff = this._findCutoffIndex(allMsgs, msg.messageIndex);
                    if (cutoff >= 0 && cutoff < allMsgs.length) {
                        tab.suspendedMessages = allMsgs.slice(cutoff);
                        tab.session.setMessages(allMsgs.slice(0, cutoff));
                    }

                    if (restored.length > 0) {
                        vscode.window.showInformationMessage(
                            `Restored ${restored.length} file(s) to checkpoint.`
                        );
                    }
                    this.sendStateSync();
                    break;
                }
                case 'redoCheckpoint': {
                    const redone = await tab.checkpointManager.redoCheckpoint();
                    tab.diffManager.redoChanges();

                    if (tab.suspendedMessages.length > 0) {
                        const current = tab.session.getMessages();
                        tab.session.setMessages([...current, ...tab.suspendedMessages]);
                        tab.suspendedMessages = [];
                    }

                    if (redone.length > 0) {
                        vscode.window.showInformationMessage(
                            `Re-applied ${redone.length} file(s).`
                        );
                    }
                    this.sendStateSync();
                    break;
                }
                case 'confirmAction': {
                    const answer = await vscode.window.showWarningMessage(
                        msg.message,
                        { modal: true },
                        'Yes',
                    );
                    this._post({
                        type: 'confirmResult',
                        action: msg.action,
                        confirmed: answer === 'Yes',
                        payload: msg.payload,
                    });
                    break;
                }
                case 'createTab':
                    await this._createTab();
                    break;
                case 'closeTab':
                    await this._closeTab(msg.tabId);
                    break;
                case 'switchTab':
                    this._switchTab(msg.tabId);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('pi-agent.openSettings');
                    break;
            }
        } catch (err: any) {
            this._post({ type: 'error', message: err.message ?? String(err) });
        }
    }

    private _requestToolApproval(tab: TabState, toolCallId: string, toolName: string, args: any): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            tab.pendingApprovals.set(toolCallId, { resolve });

            if (tab.id === this._activeTabId) {
                this._post({
                    type: 'toolCallPending',
                    pending: { toolCallId, toolName, args: safeSerialize(args) },
                });
            }
        });
    }

    private _resolveToolApproval(tab: TabState, toolCallId: string, approved: boolean): void {
        const pending = tab.pendingApprovals.get(toolCallId);
        if (pending) {
            tab.pendingApprovals.delete(toolCallId);
            pending.resolve(approved);
            if (tab.id === this._activeTabId) {
                this._post({ type: 'toolCallResolved', toolCallId });
            }
        }
    }

    private async _createTab(): Promise<void> {
        const newSession = new PiSessionManager(this._outputChannel, this._context.secrets);
        await newSession.initialize();

        const newCheckpoint = new CheckpointManager();
        const newDiff = new DiffManager(newSession, newCheckpoint);

        const id = nextTabId();
        const tab = makeTabState(id, newSession, newDiff, newCheckpoint);
        this._tabs.set(id, tab);
        this._subscribeTab(tab);

        this._activeTabId = id;
        this._persistTabs();
        this.sendStateSync();
    }

    private async _closeTab(tabId: string): Promise<void> {
        if (this._tabs.size <= 1) return;

        const tab = this._tabs.get(tabId);
        if (!tab) return;

        const wasActive = tabId === this._activeTabId;

        this._unsubscribeTab(tabId);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        await tab.session.dispose();
        this._tabs.delete(tabId);

        if (wasActive) {
            this._activeTabId = this._tabs.keys().next().value!;
        }

        this._persistTabs();
        this.sendStateSync();
    }

    private _switchTab(tabId: string): void {
        if (!this._tabs.has(tabId) || tabId === this._activeTabId) return;

        this._activeTabId = tabId;

        const tab = this._activeTab;
        tab.hasNotification = false;
        if (tab.isStreamingLocal) {
            vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', true);
        } else {
            vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
        }

        this._persistTabs();
        this.sendStateSync();
    }

    private _persistTabs(): void {
        const tabList = [...this._tabs.values()];
        const activeTab = this._tabs.get(this._activeTabId);
        const activeIndex = activeTab ? tabList.indexOf(activeTab) : 0;

        const tabs = tabList
            .map(tab => ({
                name: tab.name,
                sessionPath: tab.session.sessionPath ?? '',
            }))
            .filter(t => t.sessionPath !== '');

        this._context.workspaceState.update('pi-agent.tabs', {
            tabs,
            activeIndex: Math.max(0, activeIndex),
        } satisfies PersistedTabsState);
    }

    async restorePersistedTabs(): Promise<void> {
        const persisted = this._context.workspaceState.get<PersistedTabsState>('pi-agent.tabs');
        if (!persisted || persisted.tabs.length === 0) { return; }

        // Remember the initial empty tab to dispose after successful restore
        const initialTabId = this._activeTabId;
        const initialTab = this._tabs.get(initialTabId);

        const restoredIds: string[] = [];

        for (const { name, sessionPath } of persisted.tabs) {
            try {
                const session = new PiSessionManager(this._outputChannel, this._context.secrets);
                await session.initializeFromPath(sessionPath);

                const checkpoint = new CheckpointManager();
                const diff = new DiffManager(session, checkpoint);

                const id = nextTabId();
                const tab = makeTabState(id, session, diff, checkpoint);
                tab.name = name;
                this._updateTabName(tab); // re-derive name from first message if needed

                this._tabs.set(id, tab);
                this._subscribeTab(tab);
                restoredIds.push(id);
            } catch (err: any) {
                this._outputChannel.appendLine(`Failed to restore tab "${name}": ${err.message}`);
            }
        }

        if (restoredIds.length === 0) { return; }

        // Dispose the initial empty tab
        if (initialTab) {
            this._unsubscribeTab(initialTabId);
            initialTab.diffManager.dispose();
            initialTab.checkpointManager.dispose();
            await initialTab.session.dispose();
            this._tabs.delete(initialTabId);
        }

        // Restore active tab
        const activeIdx = Math.min(persisted.activeIndex ?? 0, restoredIds.length - 1);
        this._activeTabId = restoredIds[activeIdx];

        this._outputChannel.appendLine(`Restored ${restoredIds.length} tab(s).`);
        this.sendStateSync();
    }

    private _findCutoffIndex(messages: any[], rollbackPoint: number): number {
        let userMsgCount = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') {
                userMsgCount++;
                if (userMsgCount > rollbackPoint) {
                    return i;
                }
            }
        }
        return -1;
    }

    dispose(): void {
        for (const [, unsubs] of this._tabSubscriptions) {
            for (const unsub of unsubs) unsub();
        }
        this._tabSubscriptions.clear();
        this._authChangedSubscription?.dispose();
        this._authChangedSubscription = undefined;
        this._sink = undefined;
    }
}
