import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainCss = readFileSync(resolve(process.cwd(), 'src/webview/styles/main.css'), 'utf8');
const mainSource = readFileSync(resolve(process.cwd(), 'src/webview/main.ts'), 'utf8');

function hatchRuleBody(): string {
    return /\.diff-cell-empty,\s*\.diff-gap\s*\{([^}]*)\}/.exec(mainCss)?.[1] ?? '';
}

describe('inline diff stripe alignment', () => {
    it('anchors adjacent rows to the diff table instead of the scrolling viewport', () => {
        const hatchRule = hatchRuleBody();

        expect(hatchRule).not.toMatch(/\bbackground-attachment\s*:\s*fixed\s*;/);
        expect(hatchRule).toMatch(/\bbackground-repeat\s*:\s*no-repeat\s*;/);
        expect(hatchRule).toMatch(/\bbackground-origin\s*:\s*border-box\s*;/);
        expect(hatchRule).toContain('var(--diff-stripe-reference-width)');
        expect(hatchRule).toContain('var(--diff-stripe-reference-height)');
        expect(hatchRule).toContain('var(--diff-stripe-offset-x)');
        expect(hatchRule).toContain('var(--diff-stripe-offset-y)');
        expect(mainSource).toContain('observeDiffStripeAlignment(diffView)');
        expect(mainSource).toContain("cell.style.setProperty('--diff-stripe-reference-width'");
        expect(mainSource).toContain("cell.style.setProperty('--diff-stripe-reference-height'");
        expect(mainSource).toContain("cell.style.setProperty('--diff-stripe-offset-x'");
        expect(mainSource).toContain("cell.style.setProperty('--diff-stripe-offset-y'");
    });
});
