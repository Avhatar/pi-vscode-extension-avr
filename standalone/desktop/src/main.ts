import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    shell,
} from 'electron';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDesktopAgentIpc } from './electron-ipc';
import { createProductionDesktopHost, type DesktopChatRuntime } from './host';
import { DesktopIpcHost } from './ipc-host';

interface DesktopOptions {
    readonly workspace?: string;
    readonly openDevTools: boolean;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const distRoot = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let runtime: DesktopChatRuntime | undefined;
let disposeIpc: (() => void) | undefined;
let quitting = false;

app.setName('Pi Code Desktop');
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
    app.on('before-quit', (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        void shutdown().finally(() => app.quit());
    });
    app.on('window-all-closed', () => app.quit());
    void start().catch((error) => showStartupFailure(error));
}

async function start(): Promise<void> {
    await app.whenReady();
    Menu.setApplicationMenu(null);
    const options = parseOptions(process.argv.slice(1));
    const workspaceRoot = options.workspace
        ? resolve(options.workspace)
        : await selectWorkspace();
    if (!workspaceRoot) {
        app.quit();
        return;
    }
    await access(workspaceRoot);
    if (!await confirmWorkspaceTrust(workspaceRoot)) {
        app.quit();
        return;
    }

    let ipcHost: DesktopIpcHost | undefined;
    runtime = await createProductionDesktopHost({
        workspaceRoot,
        appDataRoot: app.getPath('userData'),
        packageRoot: app.getAppPath(),
        workspaceTrusted: true,
        emit: (message, tabId) => ipcHost?.publish(message, tabId),
        log: (message) => console.log(`[pi-code-desktop] ${message}`),
    });
    ipcHost = new DesktopIpcHost(runtime);
    disposeIpc = registerDesktopAgentIpc(ipcMain, ipcHost);
    mainWindow = await createWindow(options.openDevTools);
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
    disposeIpc?.();
    disposeIpc = undefined;
    const activeRuntime = runtime;
    runtime = undefined;
    if (!activeRuntime) return;
    await Promise.race([
        activeRuntime.dispose(),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS)),
    ]);
}

async function showStartupFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-code-desktop] Startup failed: ${message}`);
    if (app.isReady()) {
        await dialog.showMessageBox({
            type: 'error',
            title: 'Pi Code Desktop failed to start',
            message: 'The shared agent host could not be initialized.',
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
