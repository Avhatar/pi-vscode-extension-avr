import type {
    FileStatePort,
    FileWriteOptions,
    WorkspacePathResolution,
} from '../../core/ports/file-state';

export interface FileWriteCall {
    absolutePath: string;
    content: string;
    options?: FileWriteOptions;
}

export class InMemoryFileState implements FileStatePort {
    readonly files = new Map<string, string>();
    readonly resolutionCalls: Array<{ filePath: string; mode: WorkspacePathResolution }> = [];
    readonly writeCalls: FileWriteCall[] = [];
    readonly deleteCalls: string[] = [];
    readonly failedReads = new Set<string>();
    readonly failedWrites = new Set<string>();
    readonly failedDeletes = new Set<string>();

    resolvePath(filePath: string, mode: WorkspacePathResolution = 'workspace'): string {
        this.resolutionCalls.push({ filePath, mode });
        if (mode === 'workspace-with-home' && (filePath === '~' || filePath.startsWith('~/'))) {
            return filePath === '~' ? '/home' : `/home/${filePath.slice(2)}`;
        }
        if (filePath.startsWith('/')) return filePath;
        return `/workspace/${filePath}`;
    }

    readText(absolutePath: string): string {
        if (this.failedReads.has(absolutePath) || !this.files.has(absolutePath)) {
            throw new Error(`Cannot read ${absolutePath}`);
        }
        return this.files.get(absolutePath)!;
    }

    exists(absolutePath: string): boolean {
        return this.files.has(absolutePath);
    }

    writeText(absolutePath: string, content: string, options?: FileWriteOptions): void {
        this.writeCalls.push({ absolutePath, content, options });
        if (this.failedWrites.has(absolutePath)) throw new Error(`Cannot write ${absolutePath}`);
        this.files.set(absolutePath, content);
    }

    deleteFile(absolutePath: string): void {
        this.deleteCalls.push(absolutePath);
        if (this.failedDeletes.has(absolutePath)) throw new Error(`Cannot delete ${absolutePath}`);
        this.files.delete(absolutePath);
    }
}
