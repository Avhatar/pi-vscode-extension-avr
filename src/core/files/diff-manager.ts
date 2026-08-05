import type { FileChangeInfo } from '../../shared/agent-protocol';
import { computeUnifiedDiff } from '../../utils/diff';
import type { DiffReviewRequest, FileStatePort } from '../ports/file-state';
import type { CheckpointManager } from './checkpoint-manager';

interface ToolEventRouter {
    on(eventType: string, listener: (event: any) => void): () => void;
}

export interface ToolEventSource {
    readonly events: ToolEventRouter;
}

interface PendingEdit {
    toolCallId: string;
    toolName: string;
    filePath: string;
    originalContent: string | null;
    turnIndex: number;
    /** Non-empty when the edit originates from a shared-workspace subagent. */
    agentId?: string;
}

type FileChangeListener = (change: FileChangeInfo) => void;

/** Portable per-tab file-change tracker. */
export class DiffManager {
    private readonly _checkpoint: CheckpointManager;
    private readonly _files: FileStatePort;
    private _pendingEdits = new Map<string, PendingEdit>();
    private _fileChanges: FileChangeInfo[] = [];
    private _originalContents = new Map<string, string | null>();
    private _unsubscribers: Array<() => void> = [];
    private _listeners: FileChangeListener[] = [];
    private _currentTurn = 0;
    private _suspendedChanges: FileChangeInfo[] = [];
    private _suspendedOriginals = new Map<string, string | null>();

    constructor(source: ToolEventSource, checkpoint: CheckpointManager, files: FileStatePort) {
        this._checkpoint = checkpoint;
        this._files = files;
        this._unsubscribers.push(
            source.events.on('tool_execution_start', (event) => {
                void this._onToolStart(event);
            }),
            source.events.on('tool_execution_end', (event) => {
                void this._onToolEnd(event);
            }),
        );
    }

    get fileChanges(): FileChangeInfo[] {
        return this._fileChanges;
    }

    setCurrentTurn(turn: number): void {
        this._currentTurn = turn;
    }

    handleExternalToolEvent(event: any): void {
        if (event?.isolationPath) return;
        if (event?.type === 'tool_execution_start') void this._onToolStart(event);
        if (event?.type === 'tool_execution_end') void this._onToolEnd(event);
    }

    onFileChange(listener: FileChangeListener): () => void {
        this._listeners.push(listener);
        return () => {
            const index = this._listeners.indexOf(listener);
            if (index >= 0) this._listeners.splice(index, 1);
        };
    }

    getReview(filePath: string, toolCallId: string): DiffReviewRequest {
        const absolutePath = this._resolveFilePath(filePath);
        return {
            filePath,
            absolutePath,
            toolCallId,
            originalContent: this._originalContents.get(absolutePath),
        };
    }

    private _emitFileChange(change: FileChangeInfo): void {
        for (const listener of this._listeners) listener(change);
    }

    private async _onToolStart(event: any): Promise<void> {
        const name = event.toolName;
        if (name !== 'edit' && name !== 'write') return;

        const filePath = event.args?.file_path ?? event.args?.path ?? '';
        if (!filePath) return;

        const snapshot = this._files.captureText(this._resolveFilePath(filePath));
        if (snapshot.kind === 'unreadable') return;
        const originalContent = snapshot.kind === 'present' ? snapshot.content : null;

        this._checkpoint.recordFileState(filePath, originalContent);

        const absolutePath = this._resolveFilePath(filePath);
        if (!this._originalContents.has(absolutePath)) {
            this._originalContents.set(absolutePath, originalContent);
        }

        this._pendingEdits.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: name,
            filePath,
            originalContent,
            turnIndex: this._currentTurn,
            agentId: event.agentId || undefined,
        });
    }

    private async _onToolEnd(event: any): Promise<void> {
        const pending = this._pendingEdits.get(event.toolCallId);
        if (!pending) return;
        this._pendingEdits.delete(event.toolCallId);
        if (event.isError) return;

        let newContent: string;
        try {
            newContent = this._files.readText(this._resolveFilePath(pending.filePath));
        } catch {
            return;
        }

        const isNew = pending.originalContent === null;
        let diffText = '';
        let addedLines = 0;
        let removedLines = 0;

        if (!isNew && pending.originalContent !== null) {
            const { diff, stats } = computeUnifiedDiff(
                pending.originalContent,
                newContent,
                pending.filePath,
            );
            diffText = diff;
            addedLines = stats.added;
            removedLines = stats.removed;
        } else {
            const lines = newContent.split('\n');
            addedLines = lines.length;
            diffText = lines.map((line) => `+${line}`).join('\n');
        }

        const change: FileChangeInfo = {
            filePath: pending.filePath,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            isNew,
            diff: diffText,
            addedLines,
            removedLines,
            turnIndex: pending.turnIndex,
            ...(pending.agentId ? { subagentAgentId: pending.agentId } : {}),
        };

        this._fileChanges.push(change);
        this._emitFileChange(change);
    }

    async undoFileChange(filePath: string, _toolCallId: string): Promise<void> {
        const absolutePath = this._resolveFilePath(filePath);
        const original = this._originalContents.get(absolutePath);
        if (original === undefined) return;

        try {
            if (original === null) {
                if (this._files.exists(absolutePath)) this._files.deleteFile(absolutePath);
            } else {
                this._files.writeText(absolutePath, original);
            }
        } catch {
            // Individual undo remains best-effort.
        }

        this._fileChanges = this._fileChanges.filter(
            (change) => this._resolveFilePath(change.filePath) !== absolutePath,
        );
        this._originalContents.delete(absolutePath);
    }

    suspendChangesAfter(turnIndex: number): void {
        this._suspendedChanges = this._fileChanges.filter((change) => change.turnIndex > turnIndex);
        this._fileChanges = this._fileChanges.filter((change) => change.turnIndex <= turnIndex);

        const remainingPaths = new Set(
            this._fileChanges.map((change) => this._resolveFilePath(change.filePath)),
        );
        for (const absolutePath of [...this._originalContents.keys()]) {
            if (!remainingPaths.has(absolutePath)) {
                this._suspendedOriginals.set(
                    absolutePath,
                    this._originalContents.get(absolutePath)!,
                );
                this._originalContents.delete(absolutePath);
            }
        }
    }

    redoChanges(): void {
        for (const change of this._suspendedChanges) this._fileChanges.push(change);
        for (const [absolutePath, content] of this._suspendedOriginals) {
            if (!this._originalContents.has(absolutePath)) {
                this._originalContents.set(absolutePath, content);
            }
        }
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
    }

    discardSuspended(): void {
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
    }

    clearAll(): void {
        this._fileChanges = [];
        this._originalContents.clear();
        this._pendingEdits.clear();
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
        this._currentTurn = 0;
    }

    private _resolveFilePath(filePath: string): string {
        return this._files.resolvePath(filePath, 'workspace-with-home');
    }

    dispose(): void {
        for (const unsubscribe of this._unsubscribers) unsubscribe();
        this._pendingEdits.clear();
        this._listeners = [];
    }
}
