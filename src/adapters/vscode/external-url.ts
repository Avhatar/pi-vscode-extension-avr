import * as vscode from 'vscode';
import type { ExternalUrlPort } from '../../core/ports/external-url';

export class VsCodeExternalUrlPort implements ExternalUrlPort {
    async openExternal(url: string): Promise<boolean> {
        return vscode.env.openExternal(vscode.Uri.parse(url));
    }
}
