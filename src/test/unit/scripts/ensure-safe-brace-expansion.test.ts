import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isSafe } = require('../../../../scripts/ensure-safe-brace-expansion.js') as {
    isSafe(version: string): boolean;
};

describe('brace-expansion runtime security gate', () => {
    it.each([
        ['5.0.7', false],
        ['5.0.8', true],
        ['5.0.9', true],
        ['5.0.8-alpha', false],
        ['5.0.8-alpha.1', false],
        ['5.0.9+build.1', true],
        ['not-a-version', false],
    ])('classifies %s as safe=%s', (version, expected) => {
        expect(isSafe(version)).toBe(expected);
    });
});
