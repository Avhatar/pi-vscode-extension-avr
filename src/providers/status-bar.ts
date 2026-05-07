import * as vscode from 'vscode';
import type { PiSessionManager } from '../pi/session';

export class StatusBarManager implements vscode.Disposable {
    private _item: vscode.StatusBarItem;
    private _session: PiSessionManager;
    private _unsubscribe: (() => void) | undefined;
    /** Locally tracked flag – SDK's isStreaming lags behind agent_end. */
    private _isStreaming = false;

    constructor(session: PiSessionManager) {
        this._session = session;
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._item.command = 'pi-code.selectModel';
        this._update();
        this._item.show();

        this._unsubscribe = session.events.onAll((event) => {
            if (event.type === 'agent_start') {
                this._isStreaming = true;
            } else if (event.type === 'agent_end') {
                this._isStreaming = false;
            }
            if (
                event.type === 'agent_start' ||
                event.type === 'agent_end' ||
                event.type === 'message_end' ||
                event.type === 'turn_end'
            ) {
                this._update();
            }
        });
    }

    private _update(): void {
        const model = this._session.getCurrentModel();
        const isStreaming = this._isStreaming;
        const icon = isStreaming ? '$(loading~spin)' : '$(hubot)';
        const name = model ? (model.name ?? model.id) : 'No model';
        this._item.text = `${icon} Pi Code: ${name}`;

        const usage = this._session.session?.getContextUsage?.();
        const parts: string[] = ['Pi Code'];
        if (usage) {
            if (usage.tokens !== null) {
                parts.push(`Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`);
            }
            if (usage.percent !== null) {
                parts.push(`Usage: ${Math.round(usage.percent)}%`);
            }
        }
        const thinking = this._session.getThinkingLevel();
        if (thinking) {
            parts.push(`Thinking: ${thinking}`);
        }
        this._item.tooltip = parts.join('\n');
    }

    dispose(): void {
        this._unsubscribe?.();
        this._item.dispose();
    }
}
