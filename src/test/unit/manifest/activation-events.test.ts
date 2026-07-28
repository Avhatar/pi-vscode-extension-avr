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

    it('activates at VS Code startup so the launcher view is ready before the first click', () => {
        // `onStartupFinished` supersedes the older `onView:pi-code.chat` event
        // (VS Code auto-generates the view event from `contributes.views`, and
        // startup activation guarantees the launcher provider is registered
        // before the user can even click the sidebar icon).
        const activationEvents = readManifest().activationEvents ?? [];

        expect(activationEvents).toContain('onStartupFinished');
    });
});
