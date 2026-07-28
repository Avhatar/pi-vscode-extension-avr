import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Raw Mode settings webview', () => {
    it('uses an in-webview delete confirmation instead of unsupported browser modals', () => {
        const source = fs.readFileSync(path.resolve('src/webview/settings.ts'), 'utf8');

        expect(source).not.toMatch(/\bconfirm\s*\(/);
        expect(source).toContain('showRawDeleteConfirmation');
        expect(source).toContain("vscode.postMessage({ type: 'rawMode.clearAll' })");
        expect(source).toContain("vscode.postMessage({ type: 'rawMode.clearSession', sessionPath })");
    });

    it('declares Raw Mode recording as disabled by default', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

        expect(manifest.contributes.configuration.properties['pi-code.rawMode.enabled']).toMatchObject({
            type: 'boolean',
            default: false,
        });
    });
});
