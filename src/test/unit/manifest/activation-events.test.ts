import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_PANEL_VIEW_TYPE } from '../../../providers/chat-panel';
import { RAW_PANEL_VIEW_TYPE } from '../../../providers/raw-panel';

function readManifest(): { activationEvents?: string[] } {
    return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
}

describe('extension manifest activation events', () => {
    it('activates while VS Code restores serialized webview panels', () => {
        const activationEvents = readManifest().activationEvents ?? [];

        expect(activationEvents).toEqual(expect.arrayContaining([
            `onWebviewPanel:${CHAT_PANEL_VIEW_TYPE}`,
            `onWebviewPanel:${RAW_PANEL_VIEW_TYPE}`,
        ]));
    });

    it('activates when the launcher view is opened', () => {
        const activationEvents = readManifest().activationEvents ?? [];

        expect(activationEvents).toContain('onView:pi-code.chat');
    });
});
