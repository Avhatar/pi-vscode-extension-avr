import * as vscode from 'vscode';
import {
    NodeWorkspaceFileState,
    type NodeWorkspaceFileStateOptions,
} from '../node/workspace-file-state';

export interface VsCodeWorkspaceFileStateOptions extends NodeWorkspaceFileStateOptions {}

/** Supplies VS Code workspace discovery to the shared Node filesystem adapter. */
export class VsCodeWorkspaceFileState extends NodeWorkspaceFileState {
    constructor(options: VsCodeWorkspaceFileStateOptions = {}) {
        super({
            ...options,
            workspaceRoot: options.workspaceRoot
                ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
            homeDirectory: options.homeDirectory
                ?? (() => process.env.HOME ?? process.env.USERPROFILE ?? ''),
        });
    }
}
