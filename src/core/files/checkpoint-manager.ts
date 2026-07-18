import type { FileStatePort } from '../ports/file-state';

interface CheckpointEntry {
    filesBefore: Map<string, string | null>;
}

interface SuspendedEntry {
    filesBefore: Map<string, string | null>;
    filesAfter: Map<string, string | null>;
}

/** Portable per-tab checkpoint state and rollback/redo lifecycle. */
export class CheckpointManager {
    private readonly _files: FileStatePort;
    private _checkpoints = new Map<number, CheckpointEntry>();
    private _suspended = new Map<number, SuspendedEntry>();
    private _currentTurn = -1;
    private _rollbackPoint: number | null = null;

    constructor(files: FileStatePort) {
        this._files = files;
    }

    get rollbackPoint(): number | null {
        return this._rollbackPoint;
    }

    startTurn(messageIndex: number): void {
        if (this._rollbackPoint !== null) {
            this.discardSuspended();
        }
        this._currentTurn = messageIndex;
        if (!this._checkpoints.has(messageIndex)) {
            this._checkpoints.set(messageIndex, { filesBefore: new Map() });
        }
    }

    recordFileState(filePath: string, content: string | null): void {
        if (this._currentTurn < 0) return;
        const entry = this._checkpoints.get(this._currentTurn);
        if (!entry) return;
        // Preserve the legacy checkpoint policy: unlike diff baselines, `~`
        // is treated as a workspace-relative segment rather than expanded.
        const absolutePath = this._files.resolvePath(filePath, 'workspace');
        if (!entry.filesBefore.has(absolutePath)) {
            entry.filesBefore.set(absolutePath, content);
        }
    }

    async restoreCheckpoint(messageIndex: number): Promise<string[]> {
        const restoredFiles: string[] = [];
        const turnsToUndo = [...this._checkpoints.keys()]
            .filter((index) => index > messageIndex)
            .sort((a, b) => a - b);
        const filesToRestore = new Map<string, string | null>();

        for (const turnIndex of turnsToUndo) {
            const entry = this._checkpoints.get(turnIndex);
            if (!entry) continue;
            for (const [absolutePath, content] of entry.filesBefore) {
                if (!filesToRestore.has(absolutePath)) {
                    filesToRestore.set(absolutePath, content);
                }
            }
        }

        // Capture each turn's current state separately. Repeated paths are
        // intentionally retained so redo writes and reports once per turn.
        for (const turnIndex of turnsToUndo) {
            const entry = this._checkpoints.get(turnIndex);
            if (!entry) continue;

            const filesAfter = new Map<string, string | null>();
            for (const [absolutePath] of entry.filesBefore) {
                try {
                    filesAfter.set(
                        absolutePath,
                        this._files.exists(absolutePath)
                            ? this._files.readText(absolutePath)
                            : null,
                    );
                } catch {
                    filesAfter.set(absolutePath, null);
                }
            }

            this._suspended.set(turnIndex, {
                filesBefore: entry.filesBefore,
                filesAfter,
            });
            this._checkpoints.delete(turnIndex);
        }

        for (const [absolutePath, content] of filesToRestore) {
            try {
                if (content === null) {
                    if (this._files.exists(absolutePath)) {
                        this._files.deleteFile(absolutePath);
                        restoredFiles.push(absolutePath);
                    }
                } else {
                    this._files.writeText(absolutePath, content, {
                        createParentDirectories: true,
                    });
                    restoredFiles.push(absolutePath);
                }
            } catch {
                // Rollback remains best-effort per file.
            }
        }

        this._rollbackPoint = messageIndex;
        return restoredFiles;
    }

    async redoCheckpoint(): Promise<string[]> {
        if (this._rollbackPoint === null) return [];

        const redoneFiles: string[] = [];
        const turnsToRedo = [...this._suspended.keys()].sort((a, b) => a - b);

        for (const turnIndex of turnsToRedo) {
            const entry = this._suspended.get(turnIndex)!;

            for (const [absolutePath, content] of entry.filesAfter) {
                try {
                    if (content === null) {
                        if (this._files.exists(absolutePath)) {
                            this._files.deleteFile(absolutePath);
                            redoneFiles.push(absolutePath);
                        }
                    } else {
                        this._files.writeText(absolutePath, content, {
                            createParentDirectories: true,
                        });
                        redoneFiles.push(absolutePath);
                    }
                } catch {
                    // Redo remains best-effort per file.
                }
            }

            this._checkpoints.set(turnIndex, { filesBefore: entry.filesBefore });
        }

        this._suspended.clear();
        this._rollbackPoint = null;
        return redoneFiles;
    }

    discardSuspended(): void {
        this._suspended.clear();
        this._rollbackPoint = null;
    }

    getCheckpointTurns(): number[] {
        return [...this._checkpoints.keys()].sort((a, b) => a - b);
    }

    clearAll(): void {
        this._checkpoints.clear();
        this._suspended.clear();
        this._currentTurn = -1;
        this._rollbackPoint = null;
    }

    dispose(): void {
        this.clearAll();
    }
}
