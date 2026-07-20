import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    shell,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDesktopAgentIpc } from './electron-ipc';
import { createProductionDesktopHost, type DesktopChatRuntime } from './host';
import { DesktopIpcHost } from './ipc-host';
import type { DesktopShellState } from './ipc-contract';
import {
    cleanupDesktopProcessPaths,
    resolveDesktopProcessPaths,
} from './process-paths';
import { launchDesktopProcess } from './process-launcher';
import {
    DesktopShellIpcHost,
    registerDesktopShellIpc,
} from './shell-ipc';

interface DesktopOptions {
    readonly workspace?: string;
    readonly openDevTools: boolean;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const distRoot = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let runtime: DesktopChatRuntime | undefined;
let disposeAgentIpc: (() => void) | undefined;
let disposeShellIpc: (() => void) | undefined;
let shellHost: DesktopShellIpcHost | undefined;
let launchState: DesktopShellState = { phase: 'welcome' };
let activationPromise: Promise<DesktopShellState> | undefined;
let quitting = false;

app.setName('Pi Code Desktop');
const desktopProcessPaths = resolveDesktopProcessPaths(
    app.getPath('userData'),
    `${process.pid}-${randomUUID()}`,
);
app.setPath('sessionData', desktopProcessPaths.sessionDataRoot);

app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
void start().catch((error) => showStartupFailure(error));

async function start(): Promise<void> {
    await app.whenReady();
    Menu.setApplicationMenu(null);
    const options = parseOptions(process.argv.slice(1));
    launchState = {
        phase: 'welcome',
        ...(options.workspace ? { suggestedWorkspace: resolve(options.workspace) } : {}),
    };
    shellHost = new DesktopShellIpcHost({
        getState: () => launchState,
        selectWorkspace: async () => {
            const workspacePath = await selectWorkspace();
            return workspacePath ? activateWorkspace(workspacePath) : launchState;
        },
        openWorkspace: (workspacePath) => activateWorkspace(workspacePath),
        newWindow: () => launchDesktopProcess({
            executablePath: process.execPath,
            appPath: app.getAppPath(),
            portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE,
            defaultApp: Boolean(process.defaultApp),
            inheritedEnvironment: process.env,
        }),
    });
    disposeShellIpc = registerDesktopShellIpc(ipcMain, shellHost);
    mainWindow = await createWindow(options.openDevTools);
}

async function activateWorkspace(workspacePath: string): Promise<DesktopShellState> {
    if (runtime) return launchState;
    if (activationPromise) return activationPromise;
    activationPromise = activateWorkspaceOnce(workspacePath).finally(() => {
        activationPromise = undefined;
    });
    return activationPromise;
}

async function activateWorkspaceOnce(workspacePath: string): Promise<DesktopShellState> {
    let canonicalWorkspace: string | undefined;
    try {
        canonicalWorkspace = await realpath(resolve(workspacePath));
        updateLaunchState({ phase: 'opening', workspacePath: canonicalWorkspace });
        if (!await confirmWorkspaceTrust(canonicalWorkspace)) {
            updateLaunchState({ phase: 'welcome' });
            return launchState;
        }

        let ipcHost: DesktopIpcHost | undefined;
        const candidate = await createProductionDesktopHost({
            workspaceRoot: canonicalWorkspace,
            appDataRoot: desktopProcessPaths.sharedDataRoot,
            packageRoot: app.getAppPath(),
            workspaceTrusted: true,
            emit: (message, tabId) => ipcHost?.publish(message, tabId),
            log: (message) => console.log(`[pi-code-desktop] ${message}`),
        });
        if (quitting) {
            await candidate.dispose();
            throw new Error('The desktop process is shutting down.');
        }
        runtime = candidate;
        ipcHost = new DesktopIpcHost(candidate);
        disposeAgentIpc = registerDesktopAgentIpc(ipcMain, ipcHost);
        updateLaunchState({ phase: 'ready', workspacePath: canonicalWorkspace });
        return launchState;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateLaunchState({
            phase: 'error',
            ...(canonicalWorkspace ? { workspacePath: canonicalWorkspace } : {}),
            message,
        });
        throw error;
    }
}

function updateLaunchState(state: DesktopShellState): void {
    launchState = state;
    shellHost?.publish(state);
}

async function createWindow(openDevTools: boolean): Promise<BrowserWindow> {
    const window = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 760,
        minHeight: 520,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#050a06',
        title: 'Pi Code Desktop',
        webPreferences: {
            preload: resolve(distRoot, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://')) void shell.openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
        if (mainWindow === window) mainWindow = undefined;
    });
    await window.loadFile(resolve(distRoot, 'index.html'));
    if (openDevTools) window.webContents.openDevTools({ mode: 'detach' });
    return window;
}

async function selectWorkspace(): Promise<string | undefined> {
    const result = await dialog.showOpenDialog({
        title: 'Select the workspace for Pi Code Desktop',
        buttonLabel: 'Open workspace',
        properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
}

async function confirmWorkspaceTrust(workspaceRoot: string): Promise<boolean> {
    const result = await dialog.showMessageBox({
        type: 'warning',
        title: 'Trust this workspace?',
        message: 'Pi Code can read, modify, and execute files in this workspace.',
        detail: `${workspaceRoot}\n\nTrust is requested on every launch until the persistent trust store is enabled.`,
        buttons: ['Cancel', 'Trust and Open'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    });
    return result.response === 1;
}

async function shutdown(): Promise<void> {
    disposeShellIpc?.();
    disposeShellIpc = undefined;
    disposeAgentIpc?.();
    disposeAgentIpc = undefined;
    if (activationPromise) {
        await Promise.race([
            activationPromise.catch(() => undefined),
            new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS)),
        ]);
    }
    const activeRuntime = runtime;
    runtime = undefined;
    try {
        if (activeRuntime) {
            await Promise.race([
                activeRuntime.dispose(),
                new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS)),
            ]);
        }
    } finally {
        await cleanupDesktopProcessPaths(desktopProcessPaths);
    }
}

async function showStartupFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-code-desktop] Startup failed: ${message}`);
    if (app.isReady()) {
        await dialog.showMessageBox({
            type: 'error',
            title: 'Pi Code Desktop failed to start',
            message: 'The desktop shell could not be initialized.',
            detail: message,
        });
    }
    app.quit();
}

function parseOptions(args: readonly string[]): DesktopOptions {
    let workspace: string | undefined;
    let openDevTools = false;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--cwd') {
            const value = args[++index];
            if (!value) throw new Error('--cwd requires a workspace path.');
            workspace = value;
        } else if (args[index] === '--devtools') {
            openDevTools = true;
        }
    }
    return { workspace, openDevTools };
}
