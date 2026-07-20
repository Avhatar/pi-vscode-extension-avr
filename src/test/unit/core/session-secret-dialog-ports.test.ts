import { describe, expect, it, vi } from 'vitest';
import {
    VsCodeSecretStore,
    VsCodeSessionDialogs,
} from '../../../adapters/vscode/session-platform';
import { DEFAULT_SESSION_RUNTIME_PORTS } from '../../../core/ports/session-platform';
import { PiSessionManager } from '../../../pi/session';

const models = [
    { provider: 'provider-a', id: 'model-a', label: 'Model A' },
    { provider: 'provider-b', id: 'model-b', label: 'Model B' },
];

describe('portable session secret and dialog ports', () => {
    it('adapts secret CRUD without exposing VS Code SecretStorage', async () => {
        const source = {
            get: vi.fn(async () => 'secret'),
            store: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        const secrets = new VsCodeSecretStore(source);

        await expect(secrets.get('provider')).resolves.toBe('secret');
        await secrets.store('provider', 'updated');
        await secrets.delete('provider');

        expect(source.get).toHaveBeenCalledWith('provider');
        expect(source.store).toHaveBeenCalledWith('provider', 'updated');
        expect(source.delete).toHaveBeenCalledWith('provider');
    });

    it('maps semantic model choices through the VS Code quick pick', async () => {
        const showWarningMessage = vi.fn();
        const showQuickPick = vi.fn(async (items: any[]) => items[1]);
        const dialogs = new VsCodeSessionDialogs({ showWarningMessage, showQuickPick } as any);

        dialogs.showWarning('No models');
        await expect(dialogs.selectModel(models, 'Select a model')).resolves.toEqual({
            provider: 'provider-b',
            modelId: 'model-b',
        });

        expect(showWarningMessage).toHaveBeenCalledWith('No models');
        expect(showQuickPick).toHaveBeenCalledWith([
            { label: 'Model A', description: 'provider-a', provider: 'provider-a', modelId: 'model-a' },
            { label: 'Model B', description: 'provider-b', provider: 'provider-b', modelId: 'model-b' },
        ], { placeHolder: 'Select a model' });

        showQuickPick.mockResolvedValueOnce(undefined as any);
        await expect(dialogs.selectModel(models, 'Select a model')).resolves.toBeUndefined();
    });

    it('routes the empty-model warning through the injected dialog port', async () => {
        const showWarning = vi.fn();
        const manager = new PiSessionManager(
            { appendLine: vi.fn() },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                ...DEFAULT_SESSION_RUNTIME_PORTS,
                dialogs: { showWarning, selectModel: vi.fn() },
            },
        );

        await manager.showModelPicker();

        expect(showWarning).toHaveBeenCalledWith(
            'No models available. Check your Pi configuration.',
        );
        await manager.dispose();
    });
});
