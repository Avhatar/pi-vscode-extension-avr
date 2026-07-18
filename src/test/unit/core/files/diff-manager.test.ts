import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffManager } from '../../../../core/files/diff-manager';
import { CheckpointManager } from '../../../../core/files/checkpoint-manager';
import { EventRouter } from '../../../../pi/events';
import type { FileChangeInfo } from '../../../../shared/agent-protocol';
import { InMemoryFileState } from '../../../helpers/in-memory-file-state';

describe('portable DiffManager', () => {
    let files: InMemoryFileState;
    let events: EventRouter;
    let checkpoints: CheckpointManager;
    let diffs: DiffManager;

    beforeEach(() => {
        files = new InMemoryFileState();
        events = new EventRouter();
        checkpoints = new CheckpointManager(files);
        diffs = new DiffManager({ events }, checkpoints, files);
    });

    afterEach(() => {
        diffs.dispose();
        checkpoints.dispose();
        events.clear();
    });

    it('tracks only successful edit/write calls and prefers file_path over path', async () => {
        files.files.set('/workspace/selected.txt', 'before\n');
        checkpoints.startTurn(3);
        diffs.setCurrentTurn(3);

        emitStart('ignored', 'bash', { file_path: 'selected.txt' });
        emitEnd('ignored');
        expect(diffs.fileChanges).toEqual([]);

        const nextChange = waitForNextChange();
        emitStart('tool-1', 'write', { file_path: 'selected.txt', path: 'other.txt' });
        files.files.set('/workspace/selected.txt', 'before\nafter\n');
        emitEnd('tool-1');

        await expect(nextChange).resolves.toMatchObject({
            filePath: 'selected.txt',
            toolCallId: 'tool-1',
            toolName: 'write',
            isNew: false,
            addedLines: 1,
            removedLines: 0,
            turnIndex: 3,
        });
        expect(diffs.fileChanges[0].diff).toContain('--- a/selected.txt');

        emitStart('tool-error', 'edit', { file_path: 'selected.txt' });
        files.files.set('/workspace/selected.txt', 'failed result\n');
        emitEnd('tool-error', true);
        emitEnd('tool-error');
        expect(diffs.fileChanges).toHaveLength(1);
    });

    it('preserves the first baseline for repeated edits, review, and individual undo', () => {
        files.files.set('/workspace/tracked.txt', 'v0\n');
        checkpoints.startTurn(1);
        diffs.setCurrentTurn(1);

        editFile('tool-1', 'tracked.txt', 'v1\n');
        editFile('tool-2', 'tracked.txt', 'v2\n');

        expect(diffs.fileChanges).toHaveLength(2);
        expect(diffs.getReview('tracked.txt', 'tool-2')).toEqual({
            filePath: 'tracked.txt',
            absolutePath: '/workspace/tracked.txt',
            toolCallId: 'tool-2',
            originalContent: 'v0\n',
        });

        void diffs.undoFileChange('tracked.txt', 'tool-2');

        expect(files.files.get('/workspace/tracked.txt')).toBe('v0\n');
        expect(diffs.fileChanges).toEqual([]);
    });

    it('preserves the legacy tilde-resolution difference between diff and checkpoint state', () => {
        files.files.set('/home', 'home baseline');
        checkpoints.startTurn(1);
        diffs.setCurrentTurn(1);

        emitStart('tilde', 'edit', { file_path: '~' });

        expect(files.resolutionCalls).toContainEqual({
            filePath: '~',
            mode: 'workspace-with-home',
        });
        expect(files.resolutionCalls).toContainEqual({
            filePath: '~',
            mode: 'workspace',
        });
    });

    it('keeps new-file and suspension semantics and ignores isolated external events', () => {
        checkpoints.startTurn(1);
        diffs.setCurrentTurn(1);
        editFile('new-1', 'created.txt', 'created\n', 'write');
        expect(diffs.fileChanges[0]).toMatchObject({
            isNew: true,
            diff: '+created\n+',
            addedLines: 2,
            removedLines: 0,
        });

        checkpoints.startTurn(2);
        diffs.setCurrentTurn(2);
        editFile('new-2', 'second.txt', 'second', 'write');
        diffs.handleExternalToolEvent({
            type: 'tool_execution_start',
            toolCallId: 'isolated',
            toolName: 'write',
            args: { file_path: 'ignored.txt' },
            isolationPath: '/worktree',
        });
        diffs.handleExternalToolEvent({
            type: 'tool_execution_end',
            toolCallId: 'isolated',
            isError: false,
            isolationPath: '/worktree',
        });

        diffs.suspendChangesAfter(1);
        expect(diffs.fileChanges.map((change) => change.filePath)).toEqual(['created.txt']);
        diffs.redoChanges();
        expect(diffs.fileChanges.map((change) => change.filePath)).toEqual(['created.txt', 'second.txt']);
        expect(files.resolutionCalls).toContainEqual({
            filePath: 'created.txt',
            mode: 'workspace-with-home',
        });
    });

    function waitForNextChange(): Promise<FileChangeInfo> {
        return new Promise((resolve) => {
            const unsubscribe = diffs.onFileChange((change) => {
                unsubscribe();
                resolve(change);
            });
        });
    }

    function editFile(
        toolCallId: string,
        filePath: string,
        content: string,
        toolName: 'edit' | 'write' = 'edit',
    ): void {
        emitStart(toolCallId, toolName, { file_path: filePath });
        files.files.set(files.resolvePath(filePath, 'workspace-with-home'), content);
        emitEnd(toolCallId);
    }

    function emitStart(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
        events.dispatch({ type: 'tool_execution_start', toolCallId, toolName, args } as any);
    }

    function emitEnd(toolCallId: string, isError = false): void {
        events.dispatch({ type: 'tool_execution_end', toolCallId, isError } as any);
    }
});
