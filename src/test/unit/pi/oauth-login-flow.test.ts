import { describe, expect, it } from 'vitest';
import { OAuthLoginFlow } from '../../../pi/oauth-login-flow';
import type { OAuthFlowState } from '../../../shared/protocol';

function createFlow() {
    const states: OAuthFlowState[] = [];
    const openedUrls: string[] = [];
    const flow = new OAuthLoginFlow({
        onState: (state) => states.push(state),
        openExternal: (url) => openedUrls.push(url),
    });
    return { flow, callbacks: flow.callbacks, states, openedUrls };
}

describe('OAuthLoginFlow', () => {
    it('supports provider login-method selection', async () => {
        const { flow, callbacks, states } = createFlow();
        const selected = callbacks.onSelect({
            message: 'Choose a login method',
            options: [
                { id: 'browser', label: 'Browser login' },
                { id: 'device', label: 'Device code' },
            ],
        });

        expect(states).toEqual([{
            kind: 'awaitingSelection',
            message: 'Choose a login method',
            options: [
                { id: 'browser', label: 'Browser login' },
                { id: 'device', label: 'Device code' },
            ],
        }]);

        flow.submitSelection('browser');
        await expect(selected).resolves.toBe('browser');
    });

    it('supports browser callbacks and manual authorization input', async () => {
        const { flow, callbacks, states, openedUrls } = createFlow();
        callbacks.onAuth({
            url: 'https://auth.example.test/login',
            instructions: 'Complete login in the browser.',
        });
        const manualCode = callbacks.onManualCodeInput!();

        expect(openedUrls).toEqual(['https://auth.example.test/login']);
        expect(states[0]).toMatchObject({
            kind: 'awaitingBrowser',
            url: 'https://auth.example.test/login',
            instructions: 'Complete login in the browser.',
        });

        flow.submitText('  callback-code  ');
        await expect(manualCode).resolves.toBe('callback-code');
    });

    it('renders provider text prompts and permits explicitly empty answers', async () => {
        const { flow, callbacks, states } = createFlow();
        const answer = callbacks.onPrompt({
            message: 'GitHub Enterprise domain (blank for github.com)',
            placeholder: 'company.ghe.com',
            allowEmpty: true,
        });

        expect(states).toEqual([{
            kind: 'awaitingPrompt',
            message: 'GitHub Enterprise domain (blank for github.com)',
            placeholder: 'company.ghe.com',
            allowEmpty: true,
        }]);

        flow.submitText('');
        await expect(answer).resolves.toBe('');
    });

    it('shows device codes and opens the verification page', () => {
        const { callbacks, states, openedUrls } = createFlow();
        callbacks.onDeviceCode({
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://device.example.test',
            expiresInSeconds: 900,
        });

        expect(states).toEqual([{
            kind: 'awaitingDeviceCode',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://device.example.test',
            expiresInSeconds: 900,
        }]);
        expect(openedUrls).toEqual(['https://device.example.test']);
    });

    it('aborts polling and rejects pending input when cancelled', async () => {
        const { flow, callbacks } = createFlow();
        const answer = callbacks.onPrompt({ message: 'Enter a value' });

        flow.cancel();

        expect(flow.cancelled).toBe(true);
        expect(callbacks.signal?.aborted).toBe(true);
        await expect(answer).rejects.toThrow('Login cancelled');
    });

    it('rejects stale or unknown selections', async () => {
        const { flow, callbacks } = createFlow();
        const selected = callbacks.onSelect({
            message: 'Choose',
            options: [{ id: 'known', label: 'Known option' }],
        });

        expect(() => flow.submitSelection('unknown')).toThrow('no longer available');
        flow.cancel();
        await expect(selected).rejects.toThrow('Login cancelled');
    });
});
