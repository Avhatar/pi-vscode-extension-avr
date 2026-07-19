import { describe, expect, it } from 'vitest';
import { prepareUserMessageContent } from '../../../webview/user-message-content';

const PLAN_BLOCK = [
    '<plan-mode-instructions>',
    'Plan Mode is on. Internal guidance.',
    '</plan-mode-instructions>',
].join('\n');

describe('user message content preparation', () => {
    it('hides Plan Mode instructions after extracting a prefixed file block', () => {
        const rawText = [
            '[File: tsconfig.json]',
            '{"compilerOptions": {}}',
            '[/File]',
            PLAN_BLOCK,
            '',
            'Check this configuration.',
        ].join('\n');

        expect(prepareUserMessageContent(rawText)).toEqual({
            cleanText: 'Check this configuration.',
            fileNames: ['tsconfig.json'],
        });
    });

    it('extracts multiple text and binary file blocks before hiding Plan Mode', () => {
        const rawText = [
            '[File: first.ts]',
            'export const first = true;',
            '[/File]',
            '[File: archive.zip] (binary file)',
            '[/File]',
            PLAN_BLOCK,
            '',
            'Review both files.',
        ].join('\n');

        expect(prepareUserMessageContent(rawText)).toEqual({
            cleanText: 'Review both files.',
            fileNames: ['first.ts', 'archive.zip'],
        });
    });

    it('still hides a leading Plan Mode block when no file is attached', () => {
        expect(prepareUserMessageContent(`${PLAN_BLOCK}\n\nPlan this change.`)).toEqual({
            cleanText: 'Plan this change.',
            fileNames: [],
        });
    });
});
