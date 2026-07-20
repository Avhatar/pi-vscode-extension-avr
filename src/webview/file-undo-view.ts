/** Pure visibility policy for the optional File Undo View above the prompt input. */
export function shouldShowFileUndoView(
    enabled: boolean,
    fileChangeCount: number,
    rollbackPoint: number | null,
): boolean {
    if (!enabled) return false;
    return fileChangeCount > 0 || rollbackPoint !== null;
}
