import { describe, expect, it } from 'vitest';
import {
    CLAUDE_COMPATIBILITY_BOUNDARY,
    isClaudeInstructionPath,
    retainNativePiContextFiles,
    wrapClaudeCompatibilityContent,
} from '../../../../pi/claude-compat/boundary';

describe('Claude resource compatibility boundary', () => {
    it('preserves project resource text while retaining the current Pi identity and runtime contract', () => {
        const source = 'You are Claude Code. Use the Task tool and Claude hooks.';
        const rendered = wrapClaudeCompatibilityContent(source);

        expect(rendered).toContain(source);
        expect(rendered).toContain('Remain the current Pi agent');
        expect(rendered).toContain('do not replace the current agent identity');
        expect(rendered).toContain('use only an available Pi tool with a compatible schema');
        expect(rendered).toContain('Do not rewrite or create duplicate AGENTS.md');
    });

    it('identifies only Claude instruction files for removal from Pi native system context', () => {
        expect(isClaudeInstructionPath('/workspace/CLAUDE.md')).toBe(true);
        expect(isClaudeInstructionPath('/workspace/CLAUDE.local.md')).toBe(true);
        expect(isClaudeInstructionPath('/workspace/AGENTS.md')).toBe(false);
        expect(isClaudeInstructionPath('/workspace/docs/claude-notes.md')).toBe(false);
        expect(retainNativePiContextFiles([
            { path: '/workspace/CLAUDE.md', content: 'Claude identity directive' },
            { path: '/workspace/AGENTS.md', content: 'Native Pi project instruction' },
        ])).toEqual([
            { path: '/workspace/AGENTS.md', content: 'Native Pi project instruction' },
        ]);
    });

    it('does not emit a boundary without an applicable Claude resource', () => {
        expect(wrapClaudeCompatibilityContent('  ')).toBe('');
        expect(CLAUDE_COMPATIBILITY_BOUNDARY).not.toContain('You are Claude');
    });
});
