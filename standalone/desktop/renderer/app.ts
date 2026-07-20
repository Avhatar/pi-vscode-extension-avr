import { requestInitialAgentState } from '../../../src/shared/agent-connection-client';
import type { DesktopPreloadApi } from '../src/ipc-contract';
import { DesktopAgentConnection } from '../src/renderer-connection';

declare global {
    interface Window {
        piCode?: DesktopPreloadApi;
    }
}

const status = document.getElementById('status');
const details = document.getElementById('details');

function setStatus(message: string, detail = ''): void {
    if (status) status.textContent = message;
    if (details) details.textContent = detail;
}

const api = window.piCode;
if (!api) {
    setStatus('PRELOAD BRIDGE OFFLINE', 'The sandboxed desktop bridge was not installed.');
} else {
    const connection = new DesktopAgentConnection(api);
    connection.subscribe((event) => {
        if (event.type === 'stateSync') {
            const state = event.payload.state as { sessionName?: string; model?: { id?: string } };
            setStatus('AGENT HOST ONLINE', state.sessionName ?? state.model?.id ?? 'Session ready');
        } else if (event.type === 'error') {
            setStatus('AGENT HOST ERROR', String((event.payload as { message?: unknown }).message ?? 'Unknown error'));
        }
    });
    void requestInitialAgentState(connection).then((response) => {
        if (!response.ok) setStatus('AGENT HOST UNAVAILABLE', response.error.message);
    });
    window.addEventListener('pagehide', () => { void connection.close(); }, { once: true });
}
