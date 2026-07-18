import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventRouter } from '../../../pi/events';
import type { PiSessionManager } from '../../../pi/session';
import { CheckpointManager } from '../../../core/files/checkpoint-manager';
import { DiffManager } from '../../../core/files/diff-manager';
import { VsCodeWorkspaceFileState } from '../../../adapters/vscode/workspace-file-state';
import type { FileChangeInfo } from '../../../shared/protocol';
import { resetTestWorkspace, setTestWorkspaceRoot } from '../../mocks/vscode';

describe('DiffManager', () => {
    let temporaryDirectory: string;
    let events: EventRouter;
    let checkpoints: CheckpointManager;
    let diffs: DiffManager;

    beforeEach(() => {
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-diff-test-'));
        setTestWorkspaceRoot(temporaryDirectory);
        events = new EventRouter();
        const fileState = new VsCodeWorkspaceFileState();
        checkpoints = new CheckpointManager(fileState);
        diffs = new DiffManager(
            { events } as unknown as PiSessionManager,
            checkpoints,
            fileState,
        );
    });

    afterEach(() => {
        diffs.dispose();
        checkpoints.dispose();
        events.clear();
        resetTestWorkspace();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    it('captures successful edits and undoes every change to the original file baseline', async () => {
        const relativePath = 'tracked.txt';
        const absolutePath = path.join(temporaryDirectory, relativePath);
        const original = 'first\n';
        const firstEdit = 'first\nsecond\n';
        const secondEdit = 'first\nsecond\nthird\n';
        fs.writeFileSync(absolutePath, original, 'utf8');
        diffs.setCurrentTurn(4);

        const firstChangePromise = waitForNextChange();
        emitToolStart('tool-1', 'write', relativePath);
        fs.writeFileSync(absolutePath, firstEdit, 'utf8');
        emitToolEnd('tool-1');
        const firstChange = await firstChangePromise;

        expect(firstChange).toMatchObject({
            filePath: relativePath,
            toolCallId: 'tool-1',
            toolName: 'write',
            isNew: false,
            addedLines: 1,
            removedLines: 0,
            turnIndex: 4,
        });
        expect(firstChange.diff).toContain('--- a/tracked.txt');
        expect(firstChange.diff).toContain('+++ b/tracked.txt');
        expect(firstChange.diff).toContain('@@');
        expect(diffs.fileChanges).toEqual([firstChange]);

        const secondChangePromise = waitForNextChange();
        emitToolStart('tool-2', 'edit', relativePath);
        fs.writeFileSync(absolutePath, secondEdit, 'utf8');
        emitToolEnd('tool-2');
        const secondChange = await secondChangePromise;

        expect(secondChange).toMatchObject({
            filePath: relativePath,
            toolCallId: 'tool-2',
            toolName: 'edit',
            isNew: false,
            addedLines: 1,
            removedLines: 0,
            turnIndex: 4,
        });
        expect(diffs.fileChanges).toEqual([firstChange, secondChange]);

        await diffs.undoFileChange(relativePath, 'tool-2');

        expect(fs.readFileSync(absolutePath, 'utf8')).toBe(original);
        expect(diffs.fileChanges).toEqual([]);
    });

    function waitForNextChange(): Promise<FileChangeInfo> {
        return new Promise((resolve) => {
            const unsubscribe = diffs.onFileChange((change) => {
                unsubscribe();
                resolve(change);
            });
        });
    }

    function emitToolStart(toolCallId: string, toolName: 'write' | 'edit', filePath: string): void {
        events.dispatch({
            type: 'tool_execution_start',
            toolCallId,
            toolName,
            args: { file_path: filePath },
        } as any);
    }

    function emitToolEnd(toolCallId: string): void {
        events.dispatch({
            type: 'tool_execution_end',
            toolCallId,
            isError: false,
        } as any);
    }
});
