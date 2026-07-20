import { describe, expect, it, vi } from 'vitest';
import type { StateStore } from '../../../src/core/ports/chat-platform';
import {
    SafeStorageSecretStore,
    SecureStorageUnavailableError,
    isSafeStorageCapabilityUsable,
} from '../src/safe-storage-secrets';

class MemoryStateStore implements StateStore {
    readonly values = new Map<string, unknown>();

    get<T>(key: string, fallback?: T): T | undefined {
        return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
    }
}

function createCrypto(available = true) {
    return {
        isEncryptionAvailable: vi.fn(() => available),
        encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
        decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
    };
}

describe('SafeStorageSecretStore', () => {
    it('persists only encrypted credential bytes and decrypts them on read', async () => {
        const state = new MemoryStateStore();
        const crypto = createCrypto();
        const secrets = new SafeStorageSecretStore(state, crypto);

        await secrets.store('pi-code.apiKey.openai', 'top-secret-key');

        expect(JSON.stringify([...state.values.values()])).not.toContain('top-secret-key');
        expect(crypto.encryptString).toHaveBeenCalledWith('top-secret-key');
        await expect(secrets.get('pi-code.apiKey.openai')).resolves.toBe('top-secret-key');
        expect(crypto.decryptString).toHaveBeenCalledOnce();

        await secrets.delete('pi-code.apiKey.openai');
        await expect(secrets.get('pi-code.apiKey.openai')).resolves.toBeUndefined();
    });

    it('reports unavailable encryption and never falls back to plaintext persistence', async () => {
        const state = new MemoryStateStore();
        const crypto = createCrypto(false);
        const secrets = new SafeStorageSecretStore(state, crypto);

        expect(secrets.isAvailable()).toBe(false);
        await expect(secrets.get('pi-code.apiKey.openai')).resolves.toBeUndefined();
        await expect(secrets.store('pi-code.apiKey.openai', 'plaintext')).rejects.toBeInstanceOf(
            SecureStorageUnavailableError,
        );
        expect(state.values.size).toBe(0);
    });

    it('rejects malformed encrypted records instead of treating them as plaintext', async () => {
        const state = new MemoryStateStore();
        const secrets = new SafeStorageSecretStore(state, createCrypto());
        state.values.set('pi-code.desktop.secret.pi-code.apiKey.openai', {
            version: 1,
            ciphertext: 'not base64!',
        });

        await expect(secrets.get('pi-code.apiKey.openai')).rejects.toThrow(
            'Encrypted credential record is invalid',
        );
    });
});

describe('safeStorage capability policy', () => {
    it('rejects Electron basic_text even when encryption is reported available', () => {
        expect(isSafeStorageCapabilityUsable({
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => 'basic_text',
        })).toBe(false);
        expect(isSafeStorageCapabilityUsable({
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => 'dpapi',
        })).toBe(true);
    });
});
