import { requestInitialAgentState } from '../../../src/shared/agent-connection-client';
import type {
    DesktopPreloadApi,
    DesktopShellResponse,
    DesktopShellState,
} from '../src/ipc-contract';
import { DesktopAgentConnection } from '../src/renderer-connection';

declare global {
    interface Window {
        piCode?: DesktopPreloadApi;
    }
}

const status = document.getElementById('status');
const details = document.getElementById('details');
const actions = document.getElementById('actions');
const openWorkspaceButton = document.getElementById('open-workspace') as HTMLButtonElement | null;
const newWindowButton = document.getElementById('new-window') as HTMLButtonElement | null;

let agentConnection: DesktopAgentConnection | undefined;
let closeAgentSubscription: (() => void) | undefined;
let attemptedSuggestedWorkspace = false;

function setStatus(message: string, detail = ''): void {
    if (status) status.textContent = message;
    if (details) details.textContent = detail;
}

function setActionsVisible(visible: boolean): void {
    if (actions) actions.hidden = !visible;
}

function setActionsDisabled(disabled: boolean): void {
    if (openWorkspaceButton) openWorkspaceButton.disabled = disabled;
    if (newWindowButton) newWindowButton.disabled = disabled;
}

function setWorkspaceActionVisible(visible: boolean): void {
    if (openWorkspaceButton) openWorkspaceButton.hidden = !visible;
}

const api = window.piCode;
if (!api) {
    setStatus('PRELOAD BRIDGE OFFLINE', 'The sandboxed desktop bridge was not installed.');
} else {
    const applyShellResponse = (response: DesktopShellResponse): void => {
        applyShellState(response.state);
        if (!response.ok) setStatus('DESKTOP SHELL ERROR', response.error.message);
    };

    const connectAgent = (): void => {
        if (agentConnection) return;
        const connection = new DesktopAgentConnection(api);
        agentConnection = connection;
        closeAgentSubscription = connection.subscribe((event) => {
            if (event.type === 'stateSync') {
                const state = event.payload.state as { sessionName?: string; model?: { id?: string } };
                setStatus('AGENT HOST ONLINE', state.sessionName ?? state.model?.id ?? 'Session ready');
            } else if (event.type === 'error') {
                setStatus(
                    'AGENT HOST ERROR',
                    String((event.payload as { message?: unknown }).message ?? 'Unknown error'),
                );
            }
        });
        void requestInitialAgentState(connection).then((response) => {
            if (!response.ok) setStatus('AGENT HOST UNAVAILABLE', response.error.message);
        });
    };

    const applyShellState = (state: DesktopShellState): void => {
        switch (state.phase) {
            case 'welcome':
                setStatus('SELECT A WORKSPACE', 'Open a trusted project to start Pi Code Desktop.');
                setActionsVisible(true);
                setWorkspaceActionVisible(true);
                setActionsDisabled(false);
                if (state.suggestedWorkspace && !attemptedSuggestedWorkspace) {
                    attemptedSuggestedWorkspace = true;
                    setActionsDisabled(true);
                    void api.openWorkspace(state.suggestedWorkspace).then(applyShellResponse);
                }
                break;
            case 'opening':
                setStatus('INITIALIZING AGENT HOST', state.workspacePath);
                setActionsVisible(true);
                setWorkspaceActionVisible(true);
                setActionsDisabled(true);
                break;
            case 'ready':
                setStatus('CONNECTING TO AGENT HOST', state.workspacePath);
                setActionsVisible(true);
                setWorkspaceActionVisible(false);
                setActionsDisabled(false);
                connectAgent();
                break;
            case 'error':
                setStatus('WORKSPACE FAILED TO OPEN', state.message);
                setActionsVisible(true);
                setWorkspaceActionVisible(true);
                setActionsDisabled(false);
                break;
        }
    };

    const closeShellSubscription = api.subscribeShell(applyShellState);
    openWorkspaceButton?.addEventListener('click', () => {
        setStatus('SELECTING WORKSPACE');
        setActionsDisabled(true);
        void api.selectWorkspace().then(applyShellResponse);
    });
    newWindowButton?.addEventListener('click', () => {
        void api.newWindow().then(applyShellResponse);
    });
    void api.getLaunchState().then(applyShellResponse);

    window.addEventListener('pagehide', () => {
        closeShellSubscription();
        closeAgentSubscription?.();
        void agentConnection?.close();
    }, { once: true });
}
