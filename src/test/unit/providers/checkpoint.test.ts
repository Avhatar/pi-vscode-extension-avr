import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointManager } from '../../../core/files/checkpoint-manager';
import { VsCodeWorkspaceFileState } from '../../../adapters/vscode/workspace-file-state';
import { resetTestWorkspace, setTestWorkspaceRoot } from '../../mocks/vscode';

describe('CheckpointManager', () => {
    let temporaryDirectory: string;
    let checkpoints: CheckpointManager;

    beforeEach(() => {
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-checkpoint-test-'));
        setTestWorkspaceRoot(temporaryDirectory);
        checkpoints = new CheckpointManager(new VsCodeWorkspaceFileState());
    });

    afterEach(() => {
        checkpoints.dispose();
        resetTestWorkspace();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    it('rolls back two turns to the original file and redoes the latest state', async () => {
        const relativePath = 'tracked.txt';
        const absolutePath = path.join(temporaryDirectory, relativePath);
        const original = 'v0\n';
        const firstEdit = 'v1\n';
        const secondEdit = 'v2\n';
        fs.writeFileSync(absolutePath, original, 'utf8');

        checkpoints.startTurn(1);
        checkpoints.recordFileState(relativePath, original);
        fs.writeFileSync(absolutePath, firstEdit, 'utf8');

        checkpoints.startTurn(2);
        checkpoints.recordFileState(relativePath, firstEdit);
        fs.writeFileSync(absolutePath, secondEdit, 'utf8');

        await expect(checkpoints.restoreCheckpoint(0)).resolves.toEqual([absolutePath]);
        expect(fs.readFileSync(absolutePath, 'utf8')).toBe(original);
        expect(checkpoints.rollbackPoint).toBe(0);
        expect(checkpoints.getCheckpointTurns()).toEqual([]);

        await expect(checkpoints.redoCheckpoint()).resolves.toEqual([absolutePath, absolutePath]);
        expect(fs.readFileSync(absolutePath, 'utf8')).toBe(secondEdit);
        expect(checkpoints.rollbackPoint).toBeNull();
        expect(checkpoints.getCheckpointTurns()).toEqual([1, 2]);
    });

    it('deletes a newly created nested file on rollback and recreates it on redo', async () => {
        const relativePath = path.join('nested', 'created.txt');
        const absolutePath = path.join(temporaryDirectory, relativePath);
        const content = 'created\n';

        checkpoints.startTurn(1);
        checkpoints.recordFileState(relativePath, null);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content, 'utf8');

        await expect(checkpoints.restoreCheckpoint(0)).resolves.toEqual([absolutePath]);
        expect(fs.existsSync(absolutePath)).toBe(false);
        expect(checkpoints.rollbackPoint).toBe(0);

        fs.rmSync(path.dirname(absolutePath), { recursive: true, force: true });
        await expect(checkpoints.redoCheckpoint()).resolves.toEqual([absolutePath]);
        expect(fs.readFileSync(absolutePath, 'utf8')).toBe(content);
        expect(checkpoints.rollbackPoint).toBeNull();
        expect(checkpoints.getCheckpointTurns()).toEqual([1]);
    });
});
