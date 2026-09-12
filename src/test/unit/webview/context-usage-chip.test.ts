import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { higherRateContextNotice } from '../../../webview/context-usage-chip';

const formatTokens = (tokens: number) => (tokens >= 1000 ? `${tokens / 1000}k` : String(tokens));

describe('higher-rate context notice', () => {
    it('warns once the conversation is past the model threshold', () => {
        const notice = higherRateContextNotice(
            { tokens: 300_000, contextWindow: 872_000, percent: 34, higherRateAboveTokens: 272_000 },
            formatTokens,
        );

        expect(notice?.aboveTokens).toBe(272_000);
        expect(notice?.note).toContain('272k');
        expect(notice?.note).toContain('more expensive long-context tier');
        expect(notice?.note).toContain('Compact');
    });

    it('stays quiet at or below the threshold', () => {
        const usage = { tokens: 272_000, contextWindow: 872_000, percent: 31, higherRateAboveTokens: 272_000 };

        expect(higherRateContextNotice(usage, formatTokens)).toBeUndefined();
        expect(higherRateContextNotice({ ...usage, tokens: 12_000 }, formatTokens)).toBeUndefined();
    });

    it('stays quiet without a threshold or a token count', () => {
        expect(higherRateContextNotice(
            { tokens: 900_000, contextWindow: 1_000_000, percent: 90 },
            formatTokens,
        )).toBeUndefined();
        expect(higherRateContextNotice(
            { tokens: null, contextWindow: 1_000_000, percent: null, higherRateAboveTokens: 272_000 },
            formatTokens,
        )).toBeUndefined();
        expect(higherRateContextNotice(undefined, formatTokens)).toBeUndefined();
    });

    it('warns on an estimated token count too', () => {
        const notice = higherRateContextNotice(
            { tokens: 400_000, contextWindow: 872_000, percent: 46, estimated: true, higherRateAboveTokens: 272_000 },
            formatTokens,
        );

        expect(notice).toBeDefined();
    });
});

describe('higher-rate context chip styling', () => {
    const mainCss = readFileSync(resolve(process.cwd(), 'src/webview/styles/main.css'), 'utf8');
    const mainSource = readFileSync(resolve(process.cwd(), 'src/webview/main.ts'), 'utf8');

    it('applies the warning class from the webview renderer', () => {
        expect(mainSource).toContain("higherRateContextNotice(cu, formatTokenCount)");
        expect(mainSource).toContain('footer-context-usage--higher-rate');
    });

    it('recolors the chip with a theme warning token, including on hover', () => {
        const rule = mainCss.match(/\.footer-context-usage--higher-rate[\s\S]*?\{([^}]*)\}/)?.[1] ?? '';

        expect(rule).toContain('var(--warning-fg)');
        expect(mainCss).toContain('.footer-context-usage--higher-rate:hover');
        expect(mainCss).toContain('.footer-context-usage--higher-rate:focus-visible');
    });
});
