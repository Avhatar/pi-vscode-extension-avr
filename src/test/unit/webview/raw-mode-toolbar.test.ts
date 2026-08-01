import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('chat panel toolbar', () => {
    it('forces the Raw View button out of layout while hidden', () => {
        const css = fs.readFileSync(path.resolve('src/webview/styles/main.css'), 'utf8');

        expect(css).toMatch(/\.panel-toolbar \.panel-toolbar-btn\[hidden\]\s*\{\s*display:\s*none;/);
    });

    it('styles the inline rename field as part of the panel toolbar', () => {
        const css = fs.readFileSync(path.resolve('src/webview/styles/main.css'), 'utf8');

        expect(css).toContain('.panel-rename-form');
        expect(css).toContain('.panel-rename-input');
    });
});
