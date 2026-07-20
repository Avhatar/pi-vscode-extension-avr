import { describe, expect, it } from 'vitest';
import {
    DEFAULT_FILE_MENTION_EXCLUDES,
    augmentPromptWithFileMentions,
    compileFileMentionExcludePatterns,
    createFileMentionEntry,
    isFileMentionPathExcluded,
    resolveFileMentionConfig,
    searchFileMentionEntries,
    toFileMentionExcludeGlob,
} from '../../../../core/files/file-mentions';

describe('portable file mention policy', () => {
    const entries = [
        createFileMentionEntry('src/Foo.ts'),
        createFileMentionEntry('src/FooBar.ts'),
        createFileMentionEntry('docs/space name.md'),
        createFileMentionEntry('test/foo-helper.ts'),
    ];

    it('preserves deterministic scoring, canonical paths, and insert formatting', () => {
        expect(searchFileMentionEntries(entries, 'foo', 10)).toEqual([
            { relativePath: 'src/Foo.ts', basename: 'Foo.ts', insertText: '@src/Foo.ts ' },
            { relativePath: 'src/FooBar.ts', basename: 'FooBar.ts', insertText: '@src/FooBar.ts ' },
            { relativePath: 'test/foo-helper.ts', basename: 'foo-helper.ts', insertText: '@test/foo-helper.ts ' },
        ]);
        expect(searchFileMentionEntries(entries, 'space', 1)).toEqual([{
            relativePath: 'docs/space name.md',
            basename: 'space name.md',
            insertText: '@{docs/space name.md} ',
        }]);
    });

    it('augments prompts case-insensitively and suppresses duplicate mentions', () => {
        const prompt = 'Review @SRC/foo.ts and @{docs/space name.md}; again @src/Foo.ts.';
        expect(augmentPromptWithFileMentions(prompt, entries)).toBe(
            `${prompt}\n\nReferenced workspace files to inspect if needed:\n` +
            '- docs/space name.md\n' +
            '- src/Foo.ts',
        );
        expect(augmentPromptWithFileMentions('No references', entries)).toBe('No references');
    });

    it('preserves default secret, dependency, and build exclusions', () => {
        const compiled = compileFileMentionExcludePatterns(DEFAULT_FILE_MENTION_EXCLUDES);
        for (const candidate of [
            '.git/config',
            'node_modules/pkg/index.js',
            'dist/app.js',
            'src/app.js.map',
            '.env.local',
            'keys/client.pem',
        ]) {
            expect(isFileMentionPathExcluded(candidate, compiled), candidate).toBe(true);
        }
        expect(isFileMentionPathExcluded('src/main.ts', compiled)).toBe(false);
    });

    it('normalizes config precedence, patterns, limits, and VS Code exclusion composition', () => {
        const config = resolveFileMentionConfig({
            enabled: true,
            useDefaultExcludes: true,
            exclude: [' custom/** ', 'custom/**'],
            maxSuggestions: 500,
            configPath: './.pi/custom-mentions.json',
        }, {
            useDefaultExcludes: false,
            exclude: ['project/**', 'custom/**'],
            maxSuggestions: 7.6,
        });

        expect(config).toEqual({
            enabled: true,
            useDefaultExcludes: false,
            exclude: ['custom/**', 'project/**'],
            maxSuggestions: 8,
            configPath: '.pi/custom-mentions.json',
        });
        expect(toFileMentionExcludeGlob([])).toBeUndefined();
        expect(toFileMentionExcludeGlob(['one/**'])).toBe('one/**');
        expect(toFileMentionExcludeGlob(['one/**', 'two/**'])).toBe('{one/**,two/**}');
    });
});
