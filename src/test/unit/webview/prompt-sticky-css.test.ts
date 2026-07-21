import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainCss = readFileSync(resolve(process.cwd(), 'src/webview/styles/main.css'), 'utf8');

function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(mainCss)?.[1] ?? '';
}

describe('current prompt sticky CSS', () => {
    it('keeps the expanded current user prompt pinned to the top', () => {
        expect(ruleBody('.message-group-current-user')).toMatch(/\bposition\s*:\s*sticky\s*;/);
        expect(ruleBody('.message-group-current-user')).toMatch(/\btop\s*:\s*0\s*;/);
        expect(ruleBody('.message-group-current-user.message-group-user-expanded')).not.toMatch(/\bposition\s*:/);
    });
});
