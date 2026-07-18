import * as path from 'path';
import * as vscode from 'vscode';
import type { DiffPresenterPort, DiffReviewRequest } from '../../core/ports/file-state';

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _contents = new Map<string, string>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._contents.get(uri.toString()) ?? '';
    }

    setContent(uri: vscode.Uri, content: string): void {
        this._contents.set(uri.toString(), content);
    }
}

export class VsCodeDiffPresenter implements DiffPresenterPort {
    private readonly _contentProvider: DiffContentProvider;

    constructor(contentProvider: DiffContentProvider) {
        this._contentProvider = contentProvider;
    }

    async openDiff(request: DiffReviewRequest): Promise<void> {
        const { filePath, absolutePath, toolCallId, originalContent } = request;
        const afterUri = vscode.Uri.file(absolutePath);

        if (originalContent !== null && originalContent !== undefined) {
            const beforeUri = vscode.Uri.parse(
                `pi-diff:${filePath}?before=${encodeURIComponent(toolCallId)}`,
            );
            this._contentProvider.setContent(beforeUri, originalContent);

            await vscode.commands.executeCommand(
                'vscode.diff',
                beforeUri,
                afterUri,
                `${path.basename(filePath)} (Pi edit)`,
                { preview: true },
            );
        } else {
            try {
                const doc = await vscode.workspace.openTextDocument(afterUri);
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch {
                // best-effort: file may not exist or may have been deleted
            }
        }
    }
}
