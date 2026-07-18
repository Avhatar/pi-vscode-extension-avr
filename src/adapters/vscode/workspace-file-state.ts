import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { FileStatePort, FileWriteOptions, WorkspacePathResolution } from '../../core/ports/file-state';

export interface VsCodeWorkspaceFileStateOptions {
    workspaceRoot?: () => string | undefined;
    cwd?: () => string;
    homeDirectory?: () => string;
}

export class VsCodeWorkspaceFileState implements FileStatePort {
    private readonly _workspaceRoot: () => string | undefined;
    private readonly _cwd: () => string;
    private readonly _homeDirectory: () => string;

    constructor(options: VsCodeWorkspaceFileStateOptions = {}) {
        this._workspaceRoot = options.workspaceRoot
            ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        this._cwd = options.cwd ?? (() => process.cwd());
        this._homeDirectory = options.homeDirectory
            ?? (() => process.env.HOME ?? process.env.USERPROFILE ?? '');
    }

    resolvePath(filePath: string, mode: WorkspacePathResolution = 'workspace'): string {
        if (mode === 'workspace-with-home' && (filePath === '~' || filePath.startsWith('~/'))) {
            const rest = filePath === '~' ? '' : filePath.slice(2);
            filePath = path.join(this._homeDirectory(), rest);
        }
        if (path.isAbsolute(filePath)) return filePath;
        const root = this._workspaceRoot();
        return root ? path.join(root, filePath) : path.resolve(this._cwd(), filePath);
    }

    readText(absolutePath: string): string {
        return fs.readFileSync(absolutePath, 'utf-8');
    }

    exists(absolutePath: string): boolean {
        return fs.existsSync(absolutePath);
    }

    writeText(absolutePath: string, content: string, options?: FileWriteOptions): void {
        if (options?.createParentDirectories) {
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        fs.writeFileSync(absolutePath, content, 'utf-8');
    }

    deleteFile(absolutePath: string): void {
        fs.unlinkSync(absolutePath);
    }
}
