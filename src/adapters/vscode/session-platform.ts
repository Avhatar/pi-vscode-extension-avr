import * as vscode from 'vscode';
import {
    DEFAULT_SESSION_RUNTIME_PORTS,
    type ModelSelection,
    type ModelSelectionOption,
    type SecretStore,
    type SessionCodexUsagePort,
    type SessionDialogPort,
    type SessionResourcePaths,
    type SessionRuntimePorts,
    type SessionSettingValues,
    type SessionSettingsPort,
    type SessionWorkspacePort,
} from '../../core/ports/session-platform';

type WorkspaceSource = Pick<
    typeof vscode.workspace,
    'workspaceFolders' | 'isTrusted' | 'findFiles'
>;
type ConfigurationSource = Pick<typeof vscode.workspace, 'getConfiguration'>;
type DialogSource = Pick<typeof vscode.window, 'showWarningMessage' | 'showQuickPick'>;
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

export class VsCodeSecretStore implements SecretStore {
    constructor(private readonly source: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>) {}

    get(key: string): PromiseLike<string | undefined> {
        return this.source.get(key);
    }

    store(key: string, value: string): PromiseLike<void> {
        return this.source.store(key, value);
    }

    delete(key: string): PromiseLike<void> {
        return this.source.delete(key);
    }
}

export class VsCodeSessionDialogs implements SessionDialogPort {
    constructor(private readonly source: DialogSource = vscode.window) {}

    showWarning(message: string): void {
        void this.source.showWarningMessage(message);
    }

    async selectModel(
        models: readonly ModelSelectionOption[],
        placeHolder: string,
    ): Promise<ModelSelection | undefined> {
        const items = models.map((model) => ({
            label: model.label,
            description: model.provider,
            provider: model.provider,
            modelId: model.id,
        }));
        const pick = await this.source.showQuickPick(items, { placeHolder });
        return pick ? { provider: pick.provider, modelId: pick.modelId } : undefined;
    }
}

export function createVsCodeSessionRuntimePorts(
    resources?: SessionResourcePaths,
    codexUsage: SessionCodexUsagePort = DEFAULT_SESSION_RUNTIME_PORTS.codexUsage,
): SessionRuntimePorts {
    return {
        workspace: new VsCodeWorkspacePort(),
        settings: new VsCodeSessionSettings(),
        dialogs: new VsCodeSessionDialogs(),
        resources: resources ?? { bundledPiPackagePaths: [] },
        codexUsage,
    };
}
