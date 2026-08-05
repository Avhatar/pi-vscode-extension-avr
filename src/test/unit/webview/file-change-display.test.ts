import { describe, expect, it } from 'vitest';

import { shouldRenderInlineFileChange } from '../../../webview/file-change-display';

describe('file change display', () => {
    it('keeps parent edits inline but suppresses subagent edit spam', () => {
        expect(shouldRenderInlineFileChange({
            filePath: 'src/parent.ts',
            toolCallId: 'parent-tool',
            toolName: 'edit',
            isNew: false,
            addedLines: 1,
            removedLines: 0,
            turnIndex: 1,
        })).toBe(true);

        expect(shouldRenderInlineFileChange({
            filePath: 'src/child.ts',
            toolCallId: 'agent-1:child-tool',
            toolName: 'edit',
            isNew: false,
            addedLines: 1,
            removedLines: 0,
            turnIndex: 1,
            subagentAgentId: 'agent-1',
        })).toBe(false);
    });
});
