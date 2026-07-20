import { describe, expect, it } from 'vitest';
import { shouldShowFileUndoView } from '../../../webview/file-undo-view';

describe('File Undo View visibility', () => {
    it('keeps the view visible for Redo after Undo suspends every active file change', () => {
        expect(shouldShowFileUndoView(true, 0, 0)).toBe(true);
    });

    it('requires the feature toggle and either active changes or a rollback point', () => {
        expect(shouldShowFileUndoView(false, 1, null)).toBe(false);
        expect(shouldShowFileUndoView(false, 0, 0)).toBe(false);
        expect(shouldShowFileUndoView(true, 1, null)).toBe(true);
        expect(shouldShowFileUndoView(true, 0, null)).toBe(false);
    });
});
