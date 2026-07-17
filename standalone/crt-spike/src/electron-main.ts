import electron from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const { app, BrowserWindow, dialog, Menu, shell } = electron;

const HOST_START_TIMEOUT_MS = 45_000;
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+$/;

interface DesktopOptions {
  cwd?: string;
  fullscreen: boolean;
  openDevTools: boolean;
}

interface HostProcess {
  child: ChildProcess;
  launchUrl: string;
  stop(): Promise<void>;
}

let mainWindow: Electron.BrowserWindow | undefined;
let hostProcess: HostProcess | undefined;
let quitting = false;

app.setName('Pi CRT Terminal');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
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
    void (async () => {
      await hostProcess?.stop();
      app.quit();
    })();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && hostProcess) void createWindow(hostProcess.launchUrl, parseDesktopOptions(process.argv.slice(1)));
  });

  void startDesktop();
}

async function startDesktop(): Promise<void> {
  try {
    await app.whenReady();
    Menu.setApplicationMenu(null);

    const options = parseDesktopOptions(process.argv.slice(1));
    const cwd = options.cwd ? resolve(options.cwd) : await selectWorkspace();
    if (!cwd) {
      app.quit();
      return;
    }
    await access(cwd);

    hostProcess = await startHost(cwd);
    await createWindow(hostProcess.launchUrl, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[crt-desktop] Startup failed: ${message}`);
    if (app.isReady()) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Pi CRT failed to start',
        message: 'The local agent host could not be started.',
        detail: message,
      });
    }
    app.quit();
  }
}

async function selectWorkspace(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Select the workspace for Pi CRT',
    buttonLabel: 'Open workspace',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function createWindow(launchUrl: string, options: DesktopOptions): Promise<void> {
  const expectedOrigin = new URL(launchUrl).origin;
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    fullscreen: options.fullscreen,
    autoHideMenuBar: true,
    backgroundColor: '#050a06',
    title: 'Pi CRT Terminal',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== expectedOrigin) event.preventDefault();
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    } else if (input.key === 'Escape' && window.isFullScreen()) {
      event.preventDefault();
      window.setFullScreen(false);
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
    if (!quitting && process.platform !== 'darwin') app.quit();
  });

  await window.loadURL(launchUrl);
  if (options.openDevTools) window.webContents.openDevTools({ mode: 'detach' });
}

async function startHost(cwd: string): Promise<HostProcess> {
  const distDir = dirname(fileURLToPath(import.meta.url));
  const hostEntry = resolve(distDir, 'host.js');
  const child = spawn(process.execPath, [hostEntry, '--cwd', cwd, '--port', '0', '--no-open'], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (!child.stdout || !child.stderr) throw new Error('Agent host output pipes are unavailable.');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => process.stdout.write(`[agent-host] ${chunk}`));
  child.stderr.on('data', (chunk: string) => process.stderr.write(`[agent-host] ${chunk}`));

  let launchUrl: string;
  try {
    launchUrl = await waitForLaunchUrl(child);
  } catch (error) {
    child.kill();
    throw error;
  }

  let stopping = false;
  child.once('exit', (code, signal) => {
    if (stopping || quitting) return;
    const detail = `The local agent host exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`}).`;
    console.error(`[crt-desktop] ${detail}`);
    if (app.isReady()) {
      void dialog.showMessageBox({ type: 'error', title: 'Pi CRT host stopped', message: detail })
        .finally(() => app.quit());
    } else {
      app.quit();
    }
  });

  return {
    child,
    launchUrl,
    async stop(): Promise<void> {
      if (stopping || child.exitCode !== null) return;
      stopping = true;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

function waitForLaunchUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, rejectUrl) => {
    const stdout = child.stdout;
    if (!stdout) {
      rejectUrl(new Error('Agent host stdout is unavailable.'));
      return;
    }
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const succeed = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveUrl(url);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectUrl(error);
    };
    const inspectBuffer = (): void => {
      const match = buffer.match(/Open this per-launch local URL:\s+(\S+)/);
      if (!match) return;
      const url = match[1];
      if (!LOOPBACK_URL.test(url)) {
        fail(new Error(`Agent host returned an unsafe launch URL: ${url}`));
        return;
      }
      succeed(url);
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      inspectBuffer();
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
    };
    const onError = (error: Error): void => fail(error);
    const onExit = (code: number | null): void => {
      buffer += decoder.end();
      inspectBuffer();
      fail(new Error(`Agent host exited before startup (code ${code ?? 'unknown'}).`));
    };
    const timeout = setTimeout(() => {
      fail(new Error('Timed out while starting the local agent host.'));
      child.kill();
    }, HOST_START_TIMEOUT_MS);

    stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function parseDesktopOptions(args: string[]): DesktopOptions {
  let cwd: string | undefined;
  let fullscreen = false;
  let openDevTools = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error('--cwd requires a path.');
      cwd = value;
    } else if (argument === '--fullscreen') {
      fullscreen = true;
    } else if (argument === '--devtools') {
      openDevTools = true;
    }
  }

  return { cwd, fullscreen, openDevTools };
}
