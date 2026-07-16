import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    formatTurnCompletionMessage,
    type TurnCompletionInfo,
} from '../shared/turn-notification';

export interface TurnNotificationPreferences {
    showPopup: boolean;
    playSound: boolean;
}

const WINDOWS_TOAST_SCRIPT = [
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml(\'<toast duration="short"><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual><audio silent="true"/></toast>\')',
    '$nodes = $xml.GetElementsByTagName(\'text\')',
    '$null = $nodes.Item(0).AppendChild($xml.CreateTextNode($env:PI_CODE_TOAST_TITLE))',
    '$null = $nodes.Item(1).AppendChild($xml.CreateTextNode($env:PI_CODE_TOAST_BODY))',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:PI_CODE_TOAST_APP_ID).Show($toast)',
].join('\n');

const WINDOWS_NOTIFICATION_SOUND_SCRIPT = [
    "$sound = Join-Path $env:WINDIR 'Media\\Windows Notify System Generic.wav'",
    'if (Test-Path -LiteralPath $sound) {',
    '    $player = New-Object System.Media.SoundPlayer $sound',
    '    $player.PlaySync()',
    '} else {',
    '    [System.Media.SystemSounds]::Asterisk.Play()',
    '    Start-Sleep -Milliseconds 500',
    '}',
].join('\n');

/** Dispatches the configured operating-system effects after an agent turn ends. */
export class TurnNotifier {
    private readonly _windowsAppUserModelId = resolveWindowsAppUserModelId();

    constructor(private readonly _outputChannel: vscode.OutputChannel) {}

    notify(info: TurnCompletionInfo, preferences: TurnNotificationPreferences): void {
        if (preferences.showPopup) {
            this._showWindowsToast(formatTurnCompletionMessage(info));
        }
        if (preferences.playSound) {
            this._playSound();
        }
    }

    private _showWindowsToast(message: string): void {
        if (process.platform !== 'win32') {
            this._outputChannel.appendLine(
                '[notification popup] Native turn-completion popups currently require Windows.',
            );
            return;
        }

        execFile(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_TOAST_SCRIPT],
            {
                windowsHide: true,
                env: {
                    ...process.env,
                    PI_CODE_TOAST_APP_ID: this._windowsAppUserModelId,
                    PI_CODE_TOAST_TITLE: 'Pi Code',
                    PI_CODE_TOAST_BODY: message.replace(/^Pi Code:\s*/, ''),
                },
            },
            (error) => {
                if (error) {
                    this._outputChannel.appendLine(`[notification popup] ${error.message}`);
                }
            },
        );
    }

    private _playSound(): void {
        if (process.platform !== 'win32') {
            this._outputChannel.appendLine(
                '[notification sound] Play Sound currently uses the standard Windows notification sound and is unavailable on this platform.',
            );
            return;
        }

        execFile(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_NOTIFICATION_SOUND_SCRIPT],
            { windowsHide: true },
            (error) => {
                if (error) {
                    this._outputChannel.appendLine(`[notification sound] ${error.message}`);
                }
            },
        );
    }
}

function resolveWindowsAppUserModelId(): string {
    try {
        const productPath = path.join(path.dirname(process.execPath), 'resources', 'app', 'product.json');
        const product = JSON.parse(readFileSync(productPath, 'utf8')) as { win32AppUserModelId?: unknown };
        if (typeof product.win32AppUserModelId === 'string' && product.win32AppUserModelId.trim()) {
            return product.win32AppUserModelId.trim();
        }
    } catch {
        // Fall back to the stable VS Code identifier below.
    }
    return vscode.env.appName.toLowerCase().includes('insiders')
        ? 'Microsoft.VisualStudioCode.Insiders'
        : 'Microsoft.VisualStudioCode';
}
