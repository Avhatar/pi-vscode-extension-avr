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
    return { flow, interaction: flow.interaction, states, openedUrls };
}

describe('OAuthLoginFlow', () => {
    it('supports provider login-method selection', async () => {
        const { flow, interaction, states } = createFlow();
        const selected = interaction.prompt({
            type: 'select',
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

    it('supports browser authorization followed by manual code input', async () => {
        const { flow, interaction, states, openedUrls } = createFlow();
        interaction.notify({
            type: 'auth_url',
            url: 'https://auth.example.test/login',
            instructions: 'Complete login in the browser.',
        });
        const manualCode = interaction.prompt({
            type: 'manual_code',
            message: 'Paste the authorization code',
            placeholder: 'Paste code or full callback URL',
        });

        expect(openedUrls).toEqual(['https://auth.example.test/login']);
        expect(states[0]).toMatchObject({
            kind: 'awaitingBrowser',
            url: 'https://auth.example.test/login',
            instructions: 'Complete login in the browser.',
        });
        expect(states[1]).toMatchObject({
            kind: 'awaitingPrompt',
            message: 'Paste the authorization code',
            allowEmpty: false,
        });

        flow.submitText('  callback-code  ');
        await expect(manualCode).resolves.toBe('callback-code');
    });

    it('preserves allowEmpty from legacy text prompts', async () => {
        const { flow, interaction, states } = createFlow();
        const answer = interaction.prompt({
            type: 'text',
            message: 'GitHub Enterprise domain (blank for github.com)',
            placeholder: 'company.ghe.com',
            allowEmpty: true,
        } as any);

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
        const { interaction, states, openedUrls } = createFlow();
        interaction.notify({
            type: 'device_code',
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

    it('surfaces progress and info notifications', () => {
        const { interaction, states } = createFlow();
        interaction.notify({ type: 'progress', message: 'Waiting for authorization' });
        interaction.notify({
            type: 'info',
            message: 'Use your organization account',
            links: [{ label: 'Help', url: 'https://example.test/help' }],
        });

        expect(states).toEqual([
            { kind: 'progress', message: 'Waiting for authorization' },
            { kind: 'progress', message: 'Use your organization account' },
        ]);
    });

    it('aborts polling and rejects pending input when cancelled', async () => {
        const { flow, interaction } = createFlow();
        const answer = interaction.prompt({ type: 'text', message: 'Enter a value' });

        flow.cancel();

        expect(flow.cancelled).toBe(true);
        expect(interaction.signal?.aborted).toBe(true);
        await expect(answer).rejects.toThrow('Login cancelled');
    });

    it('honors cancellation of a single provider prompt', async () => {
        const { interaction } = createFlow();
        const controller = new AbortController();
        const answer = interaction.prompt({
            type: 'manual_code',
            message: 'Paste code',
            signal: controller.signal,
        });

        controller.abort(new Error('Browser callback completed'));

        await expect(answer).rejects.toThrow('Browser callback completed');
    });

    it('rejects stale or unknown selections', async () => {
        const { flow, interaction } = createFlow();
        const selected = interaction.prompt({
            type: 'select',
            message: 'Choose',
            options: [{ id: 'known', label: 'Known option' }],
        });

        expect(() => flow.submitSelection('unknown')).toThrow('no longer available');
        flow.cancel();
        await expect(selected).rejects.toThrow('Login cancelled');
    });

    it('rejects overlapping prompts', async () => {
        const { flow, interaction } = createFlow();
        const first = interaction.prompt({ type: 'text', message: 'First' });
        await expect(interaction.prompt({ type: 'text', message: 'Second' }))
            .rejects.toThrow('overlapping user input');
        flow.cancel();
        await expect(first).rejects.toThrow('Login cancelled');
    });
});
