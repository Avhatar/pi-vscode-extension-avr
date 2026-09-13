import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(resolve(process.cwd(), 'src/webview/main.ts'), 'utf8');
const mainCss = readFileSync(resolve(process.cwd(), 'src/webview/styles/main.css'), 'utf8');
const renderSkeleton = mainSource.slice(
    mainSource.indexOf('function render(): void'),
    mainSource.indexOf('function assignMessageFoldoutKeys'),
);
const updateInputArea = mainSource.slice(
    mainSource.indexOf('function updateInputArea(): void'),
    mainSource.indexOf('function renderCacheChip'),
);

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assignedTemplates(): Array<{ target: string; html: string }> {
    return Array.from(updateInputArea.matchAll(/\b(\w+)\.innerHTML\s*=\s*`([\s\S]*?)`;/g), (match) => ({
        target: match[1],
        html: match[2],
    }));
}

function secondaryFooter(): { variable: string; className: string; id: string } | undefined {
    const composerAppend = renderSkeleton.indexOf('app.appendChild(inputContainer);');
    if (composerAppend < 0) return undefined;

    const siblingMatch = /app\.appendChild\((\w+)\);/.exec(renderSkeleton.slice(
        composerAppend + 'app.appendChild(inputContainer);'.length,
    ));
    if (!siblingMatch) return undefined;

    const variable = siblingMatch[1];
    const declaration = new RegExp(
        `const\\s+${escapeRegex(variable)}\\s*=\\s*el\\(\\s*['"]div['"]\\s*,\\s*['"]([^'"]+)['"]\\s*\\)`,
    ).exec(renderSkeleton);
    const id = new RegExp(`${escapeRegex(variable)}\\.id\\s*=\\s*['"]([^'"]+)['"]`).exec(renderSkeleton)?.[1];
    if (!declaration || !id) return undefined;

    return { variable, className: declaration[1], id };
}

function ruleBodyContaining(selectorFragment: string): string {
    const escaped = escapeRegex(selectorFragment);
    return Array.from(mainCss.matchAll(/([^{}]+)\{([^}]*)\}/g))
        .find((match) => new RegExp(escaped).test(match[1]))?.[2] ?? '';
}

function allRuleBodiesForClass(className: string): string {
    const classSelector = `.${className}`;
    return Array.from(mainCss.matchAll(/([^{}]+)\{([^}]*)\}/g))
        .filter((match) => match[1].includes(classSelector))
        .map((match) => match[2])
        .join('\n');
}

describe('split chat footer layout', () => {
    it('keeps only the primary composer controls in the input container footer', () => {
        const primary = assignedTemplates().find(({ html }) => html.includes('id="btn-attach-file"'))?.html ?? '';
        const controlledButton = Array.from(primary.matchAll(/<button\b[\s\S]*?<\/button>/g))
            .map((match) => match[0])
            .find((button) => button.includes('aria-controls')) ?? '';

        expect(primary).toContain('id="btn-attach-file"');
        expect(primary).toContain('footer-model');
        expect(primary).toContain('id="btn-send"');
        expect(updateInputArea).toContain('Stop generation');
        expect(updateInputArea).toContain("'Send'");
        expect(controlledButton).toMatch(/\baria-controls=/);
        expect(controlledButton).toMatch(/\baria-expanded=/);

        for (const detail of [
            '${cacheChipHtml}',
            '${thinkingChipHtml}',
            '${attachmentHtml}',
            '${codexUsageHtml}',
            '${deepSeekUsageHtml}',
            '${contextHtml}',
        ]) {
            expect(primary).not.toContain(detail);
        }
    });

    it('renders usage details in a separate sibling below the input container', () => {
        const secondary = secondaryFooter();
        expect(secondary).toBeDefined();

        const detailsAssignment = assignedTemplates()
            .find(({ html }) => [
                '${cacheChipHtml}',
                '${thinkingChipHtml}',
                '${attachmentHtml}',
                '${codexUsageHtml}',
                '${deepSeekUsageHtml}',
                '${contextHtml}',
            ].every((detail) => html.includes(detail)));
        const detailsTemplate = detailsAssignment?.html ?? '';

        expect(renderSkeleton).not.toContain(`inputContainer.appendChild(${secondary!.variable})`);
        expect(detailsAssignment?.target).toBe(secondary!.variable);
        expect(detailsTemplate).toContain('${cacheChipHtml}');
        expect(detailsTemplate).toContain('${thinkingChipHtml}');
        expect(detailsTemplate).toContain('${attachmentHtml}');
        expect(detailsTemplate).toContain('${codexUsageHtml}');
        expect(detailsTemplate).toContain('${deepSeekUsageHtml}');
        expect(detailsTemplate).toContain('${contextHtml}');
        expect(detailsTemplate).not.toContain('id="btn-attach-file"');
        expect(detailsTemplate).not.toContain('footer-model');
        expect(detailsTemplate).not.toContain('id="btn-send"');
    });

    it('starts details expanded and keeps the toggle state accessible', () => {
        const secondary = secondaryFooter();
        expect(secondary).toBeDefined();

        const primary = assignedTemplates().find(({ html }) => html.includes('id="btn-attach-file"'))?.html ?? '';
        const controlledButton = Array.from(primary.matchAll(/<button\b[\s\S]*?<\/button>/g))
            .map((match) => match[0])
            .find((button) => button.includes('aria-controls')) ?? '';
        const expandedState = /(?:let|const)\s+(\w*(?:footer|details)\w*)\s*=\s*true\s*;/i.exec(mainSource)?.[1];

        expect(controlledButton).toContain(`aria-controls="${secondary!.id}"`);
        expect(expandedState).toBeDefined();
        expect(mainSource).toMatch(new RegExp(
            `${escapeRegex(expandedState!)}\\s*=\\s*!${escapeRegex(expandedState!)}\\s*;`,
        ));
        expect(
            controlledButton.includes(expandedState!)
            || new RegExp(`setAttribute\\(\\s*['"]aria-expanded['"][\\s\\S]{0,120}${escapeRegex(expandedState!)}`).test(mainSource),
        ).toBe(true);
        expect(mainSource).toMatch(new RegExp(
            `(?:\\.hidden\\s*=\\s*!${escapeRegex(expandedState!)}|`
            + `\\.classList\\.toggle\\([\\s\\S]{0,120}!${escapeRegex(expandedState!)}|`
            + `\\.toggleAttribute\\(\\s*['"]hidden['"]\\s*,\\s*!${escapeRegex(expandedState!)}|`
            + `\\.style\\.display\\s*=\\s*${escapeRegex(expandedState!)}\\s*\\?)`,
        ));
    });

    it('updates the existing toggle in place so keyboard focus survives', () => {
        const toggleHandler = /getElementById\(['"]btn-footer-details['"]\)\?\.addEventListener\(['"]click['"],[\s\S]*?\n\s*\}\);/
            .exec(updateInputArea)?.[0] ?? '';

        expect(toggleHandler).toContain('footerDetailsExpanded = !footerDetailsExpanded');
        expect(toggleHandler).toContain('updateFooterDetailsVisibility()');
        expect(toggleHandler).not.toContain('updateInputArea()');
        expect(mainSource).toContain("setAttribute('aria-expanded', String(footerDetailsExpanded))");
    });

    it('cleans up detail pickers before rebuilding their container', () => {
        const rebuildAt = updateInputArea.indexOf('detailsFooter.innerHTML =');
        expect(rebuildAt).toBeGreaterThan(0);

        for (const cleanup of [
            'closeCacheModePicker();',
            'closeThinkingPicker();',
            'closeContextActionPicker();',
        ]) {
            const cleanupAt = updateInputArea.indexOf(cleanup);
            expect(cleanupAt).toBeGreaterThan(0);
            expect(cleanupAt).toBeLessThan(rebuildAt);
        }
    });

    it('keeps the composer width while allowing centered details to grow and wrap near the panel edge', () => {
        const composerRule = ruleBodyContaining('body[data-mode="panel"] .input-container');
        expect(composerRule).toMatch(
            /(?:^|;)\s*width\s*:\s*min\(\s*720px\s*,\s*calc\(\s*100%\s*-\s*4px\s*\)\s*\)\s*;/,
        );
        expect(composerRule).toMatch(/\bmargin-top\s*:\s*2px\s*;/);
        expect(composerRule).toMatch(/\bmargin-bottom\s*:\s*2px\s*;/);

        const secondary = secondaryFooter();
        expect(secondary).toBeDefined();
        const detailRules = allRuleBodiesForClass(secondary!.className);

        expect(detailRules).toMatch(
            /\bmin-width\s*:\s*min\(\s*720px\s*,\s*calc\(\s*100%\s*-\s*4px\s*\)\s*\)\s*;/,
        );
        expect(detailRules).toMatch(/(?:^|;)\s*width\s*:\s*max-content\s*;/m);
        expect(detailRules).toMatch(/\bmax-width\s*:\s*calc\(\s*100%\s*-\s*4px\s*\)\s*;/);
        expect(detailRules).toMatch(/\bflex-wrap\s*:\s*wrap\s*;/);
        expect(detailRules).toMatch(/\bgap\s*:\s*2px\s+4px\s*;/);
        expect(detailRules).toMatch(/\bpadding\s*:\s*3px\s+4px\s*;/);
        expect(detailRules).toMatch(/(?:\bmargin-bottom\s*:\s*2px\s*;|\bmargin\s*:\s*0\s+2px\s+2px\s*;)/);
        expect(detailRules).toMatch(
            /(?:\bmargin-inline\s*:\s*auto\s*;|\bmargin\s*:[^;]*\bauto\b[^;]*;|\bmargin-left\s*:\s*auto\s*;[\s\S]*\bmargin-right\s*:\s*auto\s*;)/,
        );
    });

    it('keeps detail pickers inside very narrow panels', () => {
        for (const pickerClass of ['cache-mode-picker', 'thinking-picker']) {
            const pickerRules = allRuleBodiesForClass(pickerClass);
            expect(pickerRules).toMatch(/\bmin-width\s*:\s*0\s*;/);
            expect(pickerRules).toMatch(/\bmax-width\s*:\s*calc\(\s*100%\s*-\s*24px\s*\)\s*;/);
        }
    });

    it('does not progressively hide footer controls or details on overflow', () => {
        expect(mainSource).not.toContain('FOOTER_HIDE_PRIORITY');
        expect(mainSource).not.toContain('footer-hidden-overflow');
        expect(mainCss).not.toContain('footer-hidden-overflow');
    });
});
