import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    FileStatePort,
    FileTextSnapshot,
    FileWriteOptions,
    WorkspacePathResolution,
} from '../../core/ports/file-state';

export interface NodeWorkspaceFileStateOptions {
    workspaceRoot?: () => string | undefined;
    cwd?: () => string;
    homeDirectory?: () => string;
}

/** Synchronous Node filesystem adapter preserving tool-event reduction order. */
export class NodeWorkspaceFileState implements FileStatePort {
    private readonly _workspaceRoot: () => string | undefined;
    private readonly _cwd: () => string;
    private readonly _homeDirectory: () => string;

    constructor(options: NodeWorkspaceFileStateOptions = {}) {
        this._workspaceRoot = options.workspaceRoot ?? (() => undefined);
        this._cwd = options.cwd ?? (() => process.cwd());
        this._homeDirectory = options.homeDirectory ?? (() => os.homedir());
    }

    resolvePath(filePath: string, mode: WorkspacePathResolution = 'workspace'): string {
        if (mode === 'workspace-with-home' && (filePath === '~' || filePath.startsWith('~/'))) {
            const rest = filePath === '~' ? '' : filePath.slice(2);
            filePath = path.join(this._homeDirectory(), rest);
        }
        if (path.isAbsolute(filePath)) return path.normalize(filePath);
        const root = this._workspaceRoot();
        return path.normalize(root ? path.join(root, filePath) : path.resolve(this._cwd(), filePath));
    }

    captureText(absolutePath: string): FileTextSnapshot {
        try {
            return { kind: 'present', content: this.readText(absolutePath) };
        } catch (error) {
            return isMissingFileError(error)
                ? { kind: 'missing' }
                : { kind: 'unreadable', error };
        }
    }

    readText(absolutePath: string): string {
        return fs.readFileSync(absolutePath, 'utf8');
    }

    exists(absolutePath: string): boolean {
        return fs.existsSync(absolutePath);
    }

    writeText(absolutePath: string, content: string, options?: FileWriteOptions): void {
        if (options?.createParentDirectories) {
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        }
        fs.writeFileSync(absolutePath, content, 'utf8');
    }

    deleteFile(absolutePath: string): void {
        fs.unlinkSync(absolutePath);
    }
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
