import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainCss = readFileSync(resolve(process.cwd(), 'src/webview/styles/main.css'), 'utf8');

function ruleBodyContaining(selectorFragment: string): string {
    const escaped = selectorFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = Array.from(mainCss.matchAll(/([^{}]+)\{([^}]*)\}/g));
    return matches.find((match) => new RegExp(escaped).test(match[1]))?.[2] ?? '';
}

describe('action timeline rail termination', () => {
    const hiddenDraft = '#answer-draft[style*="display: none"]';

    it('stops a finalized action at its icon when only the hidden streaming draft follows', () => {
        const selector = `.tool-card-wrapper:has(+ #streaming-message > ${hiddenDraft}:only-child)::before`;
        const rule = ruleBodyContaining(selector);

        expect(rule).toMatch(/\bbottom\s*:\s*auto\s*;/);
        expect(rule).toMatch(/\bheight\s*:\s*15px\s*;/);
        expect(mainCss).not.toContain('.tool-card-wrapper:has(+ #streaming-message:empty)::before');
    });

    it('stops a live final action at its icon before the hidden streaming draft', () => {
        const selector = `#streaming-message:has(> :is(.tool-card, .diff-card) + ${hiddenDraft})::before`;
        const rule = ruleBodyContaining(selector);

        expect(rule).toMatch(/\bbottom\s*:\s*auto\s*;/);
        expect(rule).toMatch(/\bheight\s*:\s*15px\s*;/);
    });

    it('does not draw a rail for an otherwise empty streaming container', () => {
        const selector = `#streaming-message:has(> ${hiddenDraft}:only-child)::before`;

        expect(ruleBodyContaining(selector)).toMatch(/\bdisplay\s*:\s*none\s*;/);
    });

    it('masks the rail below a terminal active thinking icon', () => {
        const selector = '#answer-draft:has(> #streaming-thinking.active):has(> #streaming-text:empty)::after';
        const rule = ruleBodyContaining(selector);

        expect(rule).toMatch(/\btop\s*:\s*15px\s*;/);
        expect(rule).toMatch(/\bbottom\s*:\s*-8px\s*;/);
        expect(rule).toMatch(/\bbackground\s*:\s*var\(--bg\)\s*;/);
    });

    it('masks the rail below the terminal preparing indicator', () => {
        const rule = ruleBodyContaining('.preparing-placeholder::after');

        expect(rule).toMatch(/\btop\s*:\s*15px\s*;/);
        expect(rule).toMatch(/\bbottom\s*:\s*-8px\s*;/);
        expect(rule).toMatch(/\bbackground\s*:\s*var\(--bg\)\s*;/);
    });

    it('keeps individual subagent cards visually quiet while the aggregate indicator is active', () => {
        const rule = ruleBodyContaining('.tool-card[data-tool-name="subagent"] .tool-icon');

        expect(rule).toMatch(/\banimation\s*:\s*none\s*!important\s*;/);
    });
});
