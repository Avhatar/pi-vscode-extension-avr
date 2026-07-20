import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointManager } from '../../../../core/files/checkpoint-manager';
import { InMemoryFileState } from '../../../helpers/in-memory-file-state';

describe('portable CheckpointManager', () => {
    let files: InMemoryFileState;
    let checkpoints: CheckpointManager;

    beforeEach(() => {
        files = new InMemoryFileState();
        checkpoints = new CheckpointManager(files);
    });

    it('restores the earliest baseline and redoes each suspended turn in order', async () => {
        files.files.set('/workspace/tracked.txt', 'v0\n');

        checkpoints.startTurn(1);
        checkpoints.recordFileState('tracked.txt', 'v0\n');
        files.files.set('/workspace/tracked.txt', 'v1\n');

        checkpoints.startTurn(2);
        checkpoints.recordFileState('tracked.txt', 'v1\n');
        files.files.set('/workspace/tracked.txt', 'v2\n');

        await expect(checkpoints.restoreCheckpoint(0)).resolves.toEqual(['/workspace/tracked.txt']);
        expect(files.files.get('/workspace/tracked.txt')).toBe('v0\n');
        expect(checkpoints.rollbackPoint).toBe(0);
        expect(checkpoints.getCheckpointTurns()).toEqual([]);

        await expect(checkpoints.redoCheckpoint()).resolves.toEqual([
            '/workspace/tracked.txt',
            '/workspace/tracked.txt',
        ]);
        expect(files.files.get('/workspace/tracked.txt')).toBe('v2\n');
        expect(files.writeCalls.slice(-2).map((call) => call.content)).toEqual(['v2\n', 'v2\n']);
        expect(checkpoints.rollbackPoint).toBeNull();
        expect(checkpoints.getCheckpointTurns()).toEqual([1, 2]);
    });

    it('deletes and recreates new files with parent-directory creation requested', async () => {
        checkpoints.startTurn(1);
        checkpoints.recordFileState('nested/created.txt', null);
        files.files.set('/workspace/nested/created.txt', 'created\n');

        await expect(checkpoints.restoreCheckpoint(0)).resolves.toEqual([
            '/workspace/nested/created.txt',
        ]);
        expect(files.files.has('/workspace/nested/created.txt')).toBe(false);

        await expect(checkpoints.redoCheckpoint()).resolves.toEqual([
            '/workspace/nested/created.txt',
        ]);
        expect(files.files.get('/workspace/nested/created.txt')).toBe('created\n');
        expect(files.writeCalls.at(-1)?.options).toEqual({ createParentDirectories: true });
    });

    it('does not turn an unreadable redo snapshot into a file deletion', async () => {
        files.files.set('/workspace/locked.txt', 'before');
        checkpoints.startTurn(1);
        checkpoints.recordFileState('locked.txt', 'before');
        files.files.set('/workspace/locked.txt', 'after');
        files.failedReads.add('/workspace/locked.txt');

        await checkpoints.restoreCheckpoint(0);
        expect(files.files.get('/workspace/locked.txt')).toBe('before');

        await expect(checkpoints.redoCheckpoint()).resolves.toEqual([]);
        expect(files.files.get('/workspace/locked.txt')).toBe('before');
        expect(files.deleteCalls).not.toContain('/workspace/locked.txt');
    });

    it('ignores captures before a turn and keeps best-effort failure results', async () => {
        checkpoints.recordFileState('ignored.txt', 'before');
        expect(checkpoints.getCheckpointTurns()).toEqual([]);

        checkpoints.startTurn(1);
        checkpoints.recordFileState('failed.txt', 'before');
        files.files.set('/workspace/failed.txt', 'after');
        files.failedWrites.add('/workspace/failed.txt');

        await expect(checkpoints.restoreCheckpoint(0)).resolves.toEqual([]);
        expect(files.files.get('/workspace/failed.txt')).toBe('after');
        expect(checkpoints.rollbackPoint).toBe(0);

        checkpoints.startTurn(2);
        expect(checkpoints.rollbackPoint).toBeNull();
        expect(files.resolutionCalls).toContainEqual({
            filePath: 'failed.txt',
            mode: 'workspace',
        });
    });
});
