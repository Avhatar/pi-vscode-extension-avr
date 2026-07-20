export type WorkspacePathResolution = 'workspace' | 'workspace-with-home';

export interface FileWriteOptions {
    readonly createParentDirectories?: boolean;
}

export type FileTextSnapshot =
    | { readonly kind: 'present'; readonly content: string }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unreadable'; readonly error: unknown };

/**
 * Synchronous host filesystem boundary used by file-change tracking.
 *
 * The synchronous shape is intentional: tool event reduction currently captures
 * file state before the next session event is delivered. Hosts must preserve that
 * ordering rather than resolving file operations later on an unsequenced promise.
 */
export interface FileStatePort {
    resolvePath(filePath: string, mode?: WorkspacePathResolution): string;
    captureText(absolutePath: string): FileTextSnapshot;
    readText(absolutePath: string): string;
    exists(absolutePath: string): boolean;
    writeText(absolutePath: string, content: string, options?: FileWriteOptions): void;
    deleteFile(absolutePath: string): void;
}

export interface DiffReviewRequest {
    readonly filePath: string;
    readonly absolutePath: string;
    readonly toolCallId: string;
    readonly originalContent: string | null | undefined;
}

export interface DiffPresenterPort {
    openDiff(request: DiffReviewRequest): Promise<void>;
}

export interface FileChangePlatformPorts {
    readonly fileState: FileStatePort;
    readonly diffPresenter: DiffPresenterPort;
}
