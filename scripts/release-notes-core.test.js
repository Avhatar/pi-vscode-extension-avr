import { describe, it, expect } from 'vitest';
import core from './release-notes-core.js';

const {
    parseEntries,
    retitleTopEntry,
    updateForBump,
    verifyReleaseNotes,
    verifyReadyToPublish,
} = core;

const FIXTURE = [
    '# Pi Code — Release Notes',
    '',
    'Intro paragraph.',
    '',
    '---',
    '',
    '## 0.72.0 — 2026-08-24',
    '',
    '*Everything new since 0.67.9.*',
    '',
    '### Added',
    '',
    '- **Something users can see.** Detail.',
    '',
    '---',
    '',
    '## 0.67.9 — 2026-08-10',
    '',
    '*Everything new since 0.66.3.*',
    '',
    '### Fixed',
    '',
    '- An older fix.',
    '',
    '---',
    '',
    '## 0.66.3 — 2026-08-02',
    '',
    '- The oldest listed release.',
    '',
].join('\n');

describe('parseEntries', () => {
    it('reads every entry newest-first with its since line', () => {
        const { entries } = parseEntries(FIXTURE);

        expect(entries.map(e => e.version)).toEqual(['0.72.0', '0.67.9', '0.66.3']);
        expect(entries[0].date).toBe('2026-08-24');
        expect(entries[0].since).toBe('0.67.9');
        expect(entries[1].since).toBe('0.66.3');
        expect(entries[2].since).toBeNull();
    });

    it('distinguishes real bullets from separator rules', () => {
        const { entries } = parseEntries(FIXTURE);

        expect(entries[0].hasBullets).toBe(true);
        expect(entries[0].hasPlaceholder).toBe(false);
    });
});

describe('updateForBump', () => {
    it('retitles the top entry while it is still unpublished', () => {
        const result = updateForBump(FIXTURE, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.67.9',
        });

        expect(result.action).toBe('retitled');
        expect(result.retitledFrom).toBe('0.72.0');

        const { entries } = parseEntries(result.text);
        expect(entries.map(e => e.version)).toEqual(['0.73.0', '0.67.9', '0.66.3']);
        expect(entries[0].since).toBe('0.67.9');
        // The accumulated bullets are the whole point: they must survive.
        expect(result.text).toContain('- **Something users can see.** Detail.');
    });

    it('opens a fresh entry once the top one has been handed to users', () => {
        const result = updateForBump(FIXTURE, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.72.0',
        });

        expect(result.action).toBe('inserted');

        const { entries } = parseEntries(result.text);
        expect(entries.map(e => e.version)).toEqual(['0.73.0', '0.72.0', '0.67.9', '0.66.3']);
        expect(entries[0].since).toBe('0.72.0');
        expect(entries[0].hasPlaceholder).toBe(true);
        expect(entries[1].hasBullets).toBe(true);
    });

    it('rewrites a since line that drifted away from the marker', () => {
        const result = updateForBump(FIXTURE, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.66.3',
        });

        expect(parseEntries(result.text).entries[0].since).toBe('0.66.3');
    });
});

describe('line endings', () => {
    it('writes back the CRLF a Windows checkout hands over', () => {
        const crlf = FIXTURE.replace(/\n/g, '\r\n');

        const { text } = updateForBump(crlf, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.72.0',
        });

        expect(text).toContain('## 0.73.0 — 2026-08-25\r\n');
        expect(text.replace(/\r\n/g, '')).not.toContain('\n');
        expect(parseEntries(text).entries.map(e => e.version)).toEqual(['0.73.0', '0.72.0', '0.67.9', '0.66.3']);
    });

    it('leaves an LF file on LF', () => {
        const { text } = updateForBump(FIXTURE, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.67.9',
        });

        expect(text).not.toContain('\r');
    });
});

describe('retitleTopEntry', () => {
    it('adds a missing since line', () => {
        const withoutSince = FIXTURE.replace('*Everything new since 0.67.9.*\n\n', '');

        const text = retitleTopEntry(withoutSince, {
            version: '0.73.0',
            date: '2026-08-25',
            sinceVersion: '0.67.9',
        });

        expect(parseEntries(text).entries[0].since).toBe('0.67.9');
    });
});

describe('verifyReleaseNotes', () => {
    it('accepts a consistent chain', () => {
        const result = verifyReleaseNotes({
            text: FIXTURE,
            packageVersion: '0.72.0',
            lastPublishedVersion: '0.67.9',
        });

        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it('rejects a top entry that does not match package.json', () => {
        const result = verifyReleaseNotes({
            text: FIXTURE,
            packageVersion: '0.71.0',
            lastPublishedVersion: '0.67.9',
        });

        expect(result.errors.join(' ')).toContain('package.json is 0.71.0');
    });

    it('rejects a marker with no entry of its own', () => {
        const result = verifyReleaseNotes({
            text: FIXTURE,
            packageVersion: '0.72.0',
            lastPublishedVersion: '0.69.0',
        });

        expect(result.errors.join(' ')).toContain('no entry for it');
    });

    it('rejects a broken since chain', () => {
        const broken = FIXTURE.replace('*Everything new since 0.67.9.*', '*Everything new since 0.66.3.*');

        const result = verifyReleaseNotes({
            text: broken,
            packageVersion: '0.72.0',
            lastPublishedVersion: '0.67.9',
        });

        expect(result.errors.join(' ')).toContain('the entry below it is 0.67.9');
    });

    it('rejects an unpublished top entry that does not sit on the marker', () => {
        const result = verifyReleaseNotes({
            text: FIXTURE,
            packageVersion: '0.72.0',
            lastPublishedVersion: '0.66.3',
        });

        expect(result.errors.join(' ')).toContain('must be the last published version 0.66.3');
    });

    it('warns rather than fails while the new entry is still a stub', () => {
        const { text } = updateForBump(FIXTURE, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.72.0',
        });

        const result = verifyReleaseNotes({
            text,
            packageVersion: '0.73.0',
            lastPublishedVersion: '0.72.0',
        });

        expect(result.errors).toEqual([]);
        expect(result.warnings.join(' ')).toContain('placeholder');
    });
});

describe('verifyReadyToPublish', () => {
    it('accepts a written top entry', () => {
        expect(verifyReadyToPublish({ text: FIXTURE, version: '0.72.0' }).errors).toEqual([]);
    });

    it('refuses a version that is not the newest entry', () => {
        const result = verifyReadyToPublish({ text: FIXTURE, version: '0.67.9' });

        expect(result.errors.join(' ')).toContain('top entry is 0.72.0');
    });

    it('refuses an unwritten entry', () => {
        const { text } = updateForBump(FIXTURE, {
            newVersion: '0.73.0',
            date: '2026-08-25',
            lastPublishedVersion: '0.72.0',
        });

        const result = verifyReadyToPublish({ text, version: '0.73.0' });

        expect(result.errors.join(' ')).toContain('placeholder');
        expect(result.errors.join(' ')).toContain('no bullets');
    });
});
