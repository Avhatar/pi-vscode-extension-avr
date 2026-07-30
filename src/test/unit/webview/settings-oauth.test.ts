import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('OAuth settings webview', () => {
    it('does not render manual-code controls before the SDK requests input', () => {
        const source = fs.readFileSync(path.resolve('src/webview/settings.ts'), 'utf8');
        const browserStart = source.indexOf("} else if (flow.kind === 'awaitingBrowser')");
        const browserEnd = source.indexOf("} else if (flow.kind === 'awaitingDeviceCode')", browserStart);
        const browserBlock = source.slice(browserStart, browserEnd);

        expect(browserBlock).toContain('flow.promptForCode ?');
        expect(browserBlock).toContain("` : '';");
    });
});
