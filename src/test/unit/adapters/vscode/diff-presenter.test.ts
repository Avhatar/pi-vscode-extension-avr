import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    DiffContentProvider,
    VsCodeDiffPresenter,
} from '../../../../adapters/vscode/diff-presenter';

describe('VsCodeDiffPresenter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('opens a virtual before document against the current file', async () => {
        const provider = new DiffContentProvider();
        const presenter = new VsCodeDiffPresenter(provider);
        const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
        const absolutePath = path.resolve('src/example.ts');

        await presenter.openDiff({
            filePath: 'src/example.ts',
            absolutePath,
            toolCallId: 'tool-1',
            originalContent: 'before\n',
        });

        expect(executeCommand).toHaveBeenCalledOnce();
        const [, beforeUri, afterUri, title, options] = executeCommand.mock.calls[0];
        expect(provider.provideTextDocumentContent(beforeUri as vscode.Uri)).toBe('before\n');
        expect((afterUri as vscode.Uri).fsPath).toBe(absolutePath);
        expect(title).toBe('example.ts (Pi edit)');
        expect(options).toEqual({ preview: true });
    });

    it('opens the current document when no original content is available', async () => {
        const provider = new DiffContentProvider();
        const presenter = new VsCodeDiffPresenter(provider);
        const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument');
        const showTextDocument = vi.spyOn(vscode.window, 'showTextDocument');
        const absolutePath = path.resolve('created.ts');

        await presenter.openDiff({
            filePath: 'created.ts',
            absolutePath,
            toolCallId: 'tool-new',
            originalContent: null,
        });

        expect(openTextDocument).toHaveBeenCalledOnce();
        expect(showTextDocument).toHaveBeenCalledWith(
            await openTextDocument.mock.results[0].value,
            { preview: true },
        );
    });
});
