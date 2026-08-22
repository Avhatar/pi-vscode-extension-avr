import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Each webview bundle carries its own `el()` element helper because the bundles
 * share no runtime. They must stay signature-compatible: a module whose helper
 * ignores the third argument turns every `el(tag, class, text)` call in it into
 * an empty element, with no compile error to catch it (esbuild does not
 * typecheck, and `tsconfig.json` excludes `src/webview/**`).
 *
 * This is exactly how the Todo tool result card lost all of its text.
 */
const HELPER_MODULES = ['main.ts', 'launcher.ts', 'raw.ts', 'settings.ts'] as const;

function readWebviewSource(file: string): string {
    return readFileSync(resolve(process.cwd(), 'src/webview', file), 'utf8');
}

function elDeclaration(source: string): string {
    const match = source.match(/function el(?:<[^>]*>)?\(([\s\S]*?)\)\s*:[\s\S]*?\n}/);
    return match?.[0] ?? '';
}

describe('webview el() helpers', () => {
    it.each(HELPER_MODULES)('%s declares a text parameter and applies it', (file) => {
        const declaration = elDeclaration(readWebviewSource(file));

        expect(declaration, `${file} has no local el() helper`).not.toBe('');
        expect(declaration).toMatch(/text\?: string/);
        expect(declaration).toMatch(/textContent = text/);
    });

    it('renders Todo row text through the helper rather than dropping it', () => {
        const source = readWebviewSource('main.ts');

        // The row id, label, and blocked-by chips are the call sites that
        // regressed; they only work against the three-argument helper.
        expect(source).toContain("el('span', 'todo-tool-id', `#${row.id}`)");
        expect(source).toMatch(/el\('span', 'todo-tool-label',/);
        expect(source).toMatch(/el\('span', 'todo-tool-blocked',/);
    });
});
