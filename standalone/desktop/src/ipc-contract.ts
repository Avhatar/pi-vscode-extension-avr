export const DESKTOP_AGENT_REQUEST_CHANNEL = 'pi-code:agent-request';
export const DESKTOP_AGENT_EVENT_CHANNEL = 'pi-code:agent-event';
export const DESKTOP_SHELL_REQUEST_CHANNEL = 'pi-code:shell-request';
export const DESKTOP_SHELL_EVENT_CHANNEL = 'pi-code:shell-event';

export interface DesktopIpcRequest {
    readonly documentId: string;
    readonly request: unknown;
}

export type DesktopShellState = ({
    readonly phase: 'welcome';
    readonly suggestedWorkspace?: string;
} | {
    readonly phase: 'opening';
    readonly workspacePath: string;
} | {
    readonly phase: 'ready';
    readonly workspacePath: string;
} | {
    readonly phase: 'error';
    readonly workspacePath?: string;
    readonly message: string;
}) & {
    readonly secureStorageAvailable?: boolean;
};

export type DesktopShellRequest =
    | { readonly type: 'getLaunchState' }
    | { readonly type: 'selectWorkspace' }
    | { readonly type: 'openWorkspace'; readonly workspacePath: string }
    | { readonly type: 'newWindow' };

export type DesktopShellResponse = {
    readonly ok: true;
    readonly state: DesktopShellState;
} | {
    readonly ok: false;
    readonly state: DesktopShellState;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
};

export interface DesktopPreloadApi {
    request(value: unknown): Promise<unknown>;
    subscribe(listener: (value: unknown) => void): () => void;
    getLaunchState(): Promise<DesktopShellResponse>;
    selectWorkspace(): Promise<DesktopShellResponse>;
    openWorkspace(workspacePath: string): Promise<DesktopShellResponse>;
    newWindow(): Promise<DesktopShellResponse>;
    subscribeShell(listener: (state: DesktopShellState) => void): () => void;
}
