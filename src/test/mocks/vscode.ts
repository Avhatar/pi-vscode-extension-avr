import * as fs from 'fs/promises';
import * as path from 'path';

interface TestUri {
    readonly fsPath: string;
    readonly scheme: string;
    toString(): string;
}

let workspaceFolders: Array<{ readonly uri: TestUri }> | undefined;
let workspaceFiles: TestUri[] = [];

const disposable = { dispose(): void {} };
const createWatcher = () => ({
    onDidCreate: () => disposable,
    onDidChange: () => disposable,
    onDidDelete: () => disposable,
    dispose(): void {},
});

export const workspace = {
    get workspaceFolders() {
        return workspaceFolders;
    },
    isTrusted: true,
    createFileSystemWatcher: createWatcher,
    onDidChangeConfiguration: () => disposable,
    getConfiguration: () => ({
        get: <T>(_key: string, fallback: T): T => fallback,
    }),
    findFiles: async () => workspaceFiles,
    fs: {
        async readFile(uri: TestUri): Promise<Uint8Array> {
            try {
                return await fs.readFile(uri.fsPath);
            } catch (error) {
                if (isMissingFileError(error)) {
                    const missing = new Error(`File not found: ${uri.fsPath}`);
                    missing.name = 'EntryNotFound';
                    throw missing;
                }
                throw error;
            }
        },
        async stat(uri: TestUri) {
            const value = await fs.stat(uri.fsPath);
            return { type: value.isDirectory() ? FileType.Directory : FileType.File };
        },
    },
};

export const Uri = {
    file(filePath: string): TestUri {
        return createUri(path.resolve(filePath));
    },
    parse(value: string): TestUri {
        return createUri(value);
    },
    joinPath(base: TestUri, ...segments: string[]): TestUri {
        return createUri(path.join(base.fsPath, ...segments));
    },
};

export const FileType = {
    File: 1,
    Directory: 2,
};

export const commands = {
    async executeCommand(): Promise<undefined> {
        return undefined;
    },
};

export class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
        for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
        this.listeners.clear();
    }
}

export function setTestWorkspaceRoot(root: string): void {
    workspaceFolders = [{ uri: Uri.file(root) }];
}

export function setTestWorkspaceFiles(filePaths: string[]): void {
    workspaceFiles = filePaths.map(filePath => Uri.file(filePath));
}

export function resetTestWorkspace(): void {
    workspaceFolders = undefined;
    workspaceFiles = [];
}

function createUri(fsPath: string): TestUri {
    return {
        fsPath,
        scheme: 'file',
        toString: () => fsPath,
    };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
