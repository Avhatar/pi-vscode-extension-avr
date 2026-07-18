import * as vscode from 'vscode';
import type {
    SessionRuntimePorts,
    SessionSettingValues,
    SessionSettingsPort,
    SessionWorkspacePort,
} from '../../core/ports/session-platform';

type WorkspaceSource = Pick<
    typeof vscode.workspace,
    'workspaceFolders' | 'isTrusted' | 'findFiles'
>;
type ConfigurationSource = Pick<typeof vscode.workspace, 'getConfiguration'>;
type RelativePatternFactory = (root: string, pattern: string) => vscode.GlobPattern;

export class VsCodeWorkspacePort implements SessionWorkspacePort {
    constructor(
        private readonly source: WorkspaceSource = vscode.workspace,
        private readonly createRelativePattern: RelativePatternFactory =
            (root, pattern) => new vscode.RelativePattern(root, pattern),
    ) {}

    getRoot(): string | undefined {
        return this.source.workspaceFolders?.[0]?.uri.fsPath;
    }

    isTrusted(): boolean {
        return this.source.isTrusted;
    }

    async findFiles(
        root: string,
        include: string,
        exclude: string,
        maxResults: number,
    ): Promise<string[]> {
        const matches = await this.source.findFiles(
            this.createRelativePattern(root, include),
            exclude,
            maxResults,
        );
        return matches.map((uri) => uri.fsPath);
    }
}

export class VsCodeSessionSettings implements SessionSettingsPort {
    constructor(private readonly source: ConfigurationSource = vscode.workspace) {}

    get<Key extends keyof SessionSettingValues>(
        key: Key,
        fallback: SessionSettingValues[Key],
    ): SessionSettingValues[Key] {
        return this.source.getConfiguration('pi-code').get<SessionSettingValues[Key]>(key, fallback);
    }
}

export function createVsCodeSessionRuntimePorts(): SessionRuntimePorts {
    return {
        workspace: new VsCodeWorkspacePort(),
        settings: new VsCodeSessionSettings(),
    };
}
