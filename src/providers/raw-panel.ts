import * as vscode from 'vscode';
import * as path from 'node:path';
import type {
    RawClientMessage,
    RawServerMessage,
    RawEntry,
} from '../shared/protocol';
import type { RawStoragePort } from '../core/ports/raw-storage';
import type { RawRecorder } from '../core/raw/raw-recorder';
import { RawRecorderRegistry } from '../core/raw/raw-recorder';

export const RAW_PANEL_VIEW_TYPE = 'pi-code.raw';

interface RawPanelOpenOptions {
    sessionPath: string;
    /**
     * Optional human-readable title. When absent the panel falls back to the
     * session-file basename with a `Raw:` prefix.
     */
    displayTitle?: string;
    /** Column to open in. Defaults to `Beside`. */
    viewColumn?: vscode.ViewColumn;
}

/**
 * Dependencies required to construct a RawPanel or restore one via the
 * serializer. Bundled so the extension can hand the same object to both.
 */
export interface RawPanelServices {
    extensionUri: vscode.Uri;
    storage: RawStoragePort;
    registry: RawRecorderRegistry;
    /**
     * Optional lookup used to display the current chat name on a raw panel.
     * Extension host wires this to `ChatController.getSessionDisplayTitle`.
     */
    resolveDisplayTitle?: (sessionPath: string) => string | undefined;
}

/**
 * Advanced-dev RawMode viewer. One panel per (sessionPath) but multiple
 * panel instances for the same path are allowed — VS Code lets the user
 * drag a webview tab to a new group or window, so we treat every RawPanel
 * as independent.
 */
export class RawPanel implements vscode.Disposable {
    private readonly _panel: vscode.WebviewPanel;
    private readonly _services: RawPanelServices;
    private readonly _sessionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _unsubscribeEntries?: () => void;
    private _boundRecorder?: RawRecorder;
    private _disposed = false;

    constructor(panel: vscode.WebviewPanel, services: RawPanelServices, sessionPath: string) {
        this._panel = panel;
        this._services = services;
        this._sessionPath = sessionPath;

        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [services.extensionUri],
        };
        this._panel.webview.html = this._getHtml(this._panel.webview);
        this._panel.title = this._defaultTitle(sessionPath);
        this._panel.iconPath = vscode.Uri.joinPath(services.extensionUri, 'media', 'icons', 'piIcon1.png');

        this._disposables.push(
            this._panel.webview.onDidReceiveMessage((message: unknown) => {
                void this._handleClientMessage(message as RawClientMessage);
            }),
            this._panel.onDidDispose(() => this.dispose()),
        );

        // Live-stream: bind to whatever recorder currently owns this session,
        // and re-bind whenever a new recorder mounts for the same path (session
        // reopened later).
        const rebind = (recorder: RawRecorder) => {
            if (recorder.sessionPath !== this._sessionPath) return;
            this._bindRecorder(recorder);
        };
        this._disposables.push({ dispose: services.registry.onMount(rebind) });
        const existing = services.registry.get(this._sessionPath);
        if (existing) this._bindRecorder(existing);

        // When the persisted JSONL is destroyed (Clear or Delete-from-history),
        // this panel loses its subject. Close automatically.
        this._disposables.push({
            dispose: services.registry.onDataCleared((deletedPath) => {
                if (deletedPath === this._sessionPath) this.dispose();
            }),
        });

        // Push an initial snapshot from disk so the panel populates without
        // requiring a live recorder.
        void this._sendInitialSnapshot();
        void this._sendSessionInfo();
    }

    get sessionPath(): string {
        return this._sessionPath;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._unsubscribeEntries?.();
        this._unsubscribeEntries = undefined;
        this._boundRecorder = undefined;
        for (const d of this._disposables) {
            try { d.dispose(); } catch { /* ignore */ }
        }
        this._disposables = [];
        try { this._panel.dispose(); } catch { /* already disposed */ }
    }

    private _post(message: RawServerMessage): void {
        if (this._disposed) return;
        void this._panel.webview.postMessage(message);
    }

    private _bindRecorder(recorder: RawRecorder): void {
        if (this._boundRecorder === recorder) return;
        this._unsubscribeEntries?.();
        this._boundRecorder = recorder;
        this._unsubscribeEntries = recorder.onEntry((entry: RawEntry) => {
            this._post({ type: 'raw.append', sessionPath: this._sessionPath, entry });
        });
    }

    private async _sendInitialSnapshot(): Promise<void> {
        try {
            const initial = await this._services.storage.readRange(this._sessionPath, 0, 500);
            this._post({
                type: 'raw.snapshot',
                sessionPath: this._sessionPath,
                entries: initial.entries,
                hasMore: initial.hasMore,
                nextSeq: initial.nextSeq,
            });
        } catch {
            this._post({
                type: 'raw.snapshot',
                sessionPath: this._sessionPath,
                entries: [],
                hasMore: false,
                nextSeq: 0,
            });
        }
    }

    private async _sendSessionInfo(): Promise<void> {
        const title = this._services.resolveDisplayTitle?.(this._sessionPath);
        if (title) this._panel.title = formatRawTitle(title);
        let orphaned = false;
        try {
            const summaries = await this._services.storage.list();
            const entry = summaries.find(s => s.sessionPath === this._sessionPath);
            orphaned = entry?.orphaned ?? false;
        } catch {
            // Non-fatal.
        }
        this._post({
            type: 'raw.sessionInfo',
            sessionPath: this._sessionPath,
            displayTitle: title,
            orphaned,
        });
    }

    private async _handleClientMessage(message: RawClientMessage): Promise<void> {
        if (!message || typeof (message as any).type !== 'string') return;
        switch (message.type) {
            case 'raw.subscribe': {
                await this._sendInitialSnapshot();
                await this._sendSessionInfo();
                return;
            }
            case 'raw.unsubscribe': {
                // No-op: the panel keeps its live subscription until disposed.
                return;
            }
            case 'raw.loadRange': {
                try {
                    const range = await this._services.storage.readRange(
                        message.sessionPath,
                        message.fromSeq,
                        Math.max(1, Math.min(1000, message.count)),
                    );
                    this._post({
                        type: 'raw.range',
                        sessionPath: message.sessionPath,
                        entries: range.entries,
                        hasMore: range.hasMore,
                        nextSeq: range.nextSeq,
                    });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    this._post({
                        type: 'raw.range',
                        sessionPath: message.sessionPath,
                        entries: [],
                        hasMore: false,
                        nextSeq: message.fromSeq,
                    });
                    void vscode.window.showWarningMessage(`Raw view load failed: ${msg}`);
                }
                return;
            }
            case 'raw.requestCopy': {
                try {
                    const filePath = await this._services.storage.getSessionFile?.(message.sessionPath);
                    let text = '';
                    if (filePath) {
                        text = await require('node:fs/promises').readFile(filePath, 'utf8');
                    } else {
                        // Fall back to a full readRange sweep.
                        const collected: RawEntry[] = [];
                        let fromSeq = 0;
                        for (let i = 0; i < 100; i++) {
                            const range = await this._services.storage.readRange(message.sessionPath, fromSeq, 1000);
                            collected.push(...range.entries);
                            if (!range.hasMore) break;
                            fromSeq = range.nextSeq;
                        }
                        text = collected.map(e => JSON.stringify(e)).join('\n') + '\n';
                    }
                    await vscode.env.clipboard.writeText(text);
                    this._post({ type: 'raw.copyDone', sessionPath: message.sessionPath, ok: true });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    this._post({ type: 'raw.copyDone', sessionPath: message.sessionPath, ok: false, message: msg });
                }
                return;
            }
            case 'raw.requestSaveAs': {
                try {
                    const uri = await vscode.window.showSaveDialog({
                        filters: { 'JSONL': ['jsonl'], 'All Files': ['*'] },
                        saveLabel: 'Save Raw Session',
                        defaultUri: vscode.Uri.file(`${path.basename(this._sessionPath)}.raw.jsonl`),
                    });
                    if (!uri) {
                        this._post({ type: 'raw.saveAsDone', sessionPath: message.sessionPath, ok: false, message: 'cancelled' });
                        return;
                    }
                    const src = await this._services.storage.getSessionFile?.(message.sessionPath);
                    if (!src) {
                        throw new Error('Raw session file has no persisted data yet.');
                    }
                    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
                    await fsp.copyFile(src, uri.fsPath);
                    this._post({
                        type: 'raw.saveAsDone',
                        sessionPath: message.sessionPath,
                        ok: true,
                        savedTo: uri.fsPath,
                    });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    this._post({ type: 'raw.saveAsDone', sessionPath: message.sessionPath, ok: false, message: msg });
                }
                return;
            }
            case 'raw.revealStorage': {
                try {
                    const dir = this._services.storage.getStorageDir();
                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
                } catch {
                    // Best-effort UI action.
                }
                return;
            }
        }
    }

    private _defaultTitle(sessionPath: string): string {
        return formatRawTitle(this._services.resolveDisplayTitle?.(sessionPath) ?? path.basename(sessionPath));
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._services.extensionUri, 'out', 'webview', 'raw.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._services.extensionUri, 'src', 'webview', 'styles', 'raw.css'),
        );
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Raw</title>
</head>
<body data-mode="raw">
    <div id="app" data-session-path="${escapeAttr(this._sessionPath)}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/**
 * Serializer used by VS Code to restore Raw panels after `Reload Window`.
 * The stored state contains only the sessionPath; everything else is
 * reconstructed via the injected {@link RawPanelServices}.
 */
export class RawPanelSerializer implements vscode.WebviewPanelSerializer {
    constructor(private readonly _services: RawPanelServices) {}

    async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: { sessionPath?: string } | undefined,
    ): Promise<void> {
        if (!state?.sessionPath) {
            try { panel.dispose(); } catch { /* ignore */ }
            return;
        }
        new RawPanel(panel, this._services, state.sessionPath);
    }
}

/**
 * Command entry point. Opens (or reveals) a raw panel for the given session.
 * Multiple concurrent panels are allowed — VS Code's drag-to-new-window UX
 * relies on that.
 */
export function openRawPanel(services: RawPanelServices, options: RawPanelOpenOptions): RawPanel {
    const column = options.viewColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(
        RAW_PANEL_VIEW_TYPE,
        formatRawTitle(options.displayTitle ?? path.basename(options.sessionPath)),
        column,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [services.extensionUri],
        },
    );
    return new RawPanel(panel, services, options.sessionPath);
}

function formatRawTitle(name: string): string {
    const trimmed = name.trim() || 'Raw';
    const cleaned = trimmed.length > 24 ? `${trimmed.slice(0, 23)}…` : trimmed;
    return `Raw: ${cleaned}`;
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
