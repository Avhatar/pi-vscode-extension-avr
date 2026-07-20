import type { StateStore } from '../../../src/core/ports/chat-platform';
import type { SecretStore } from '../../../src/core/ports/session-platform';

const SECRET_KEY_PREFIX = 'pi-code.desktop.secret.';

interface EncryptedCredentialRecord {
    readonly version: 1;
    readonly ciphertext: string;
}

export interface SafeStorageCryptoCapability {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
}

export interface SafeStorageAvailabilityCapability {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend?(): string;
}

export class SecureStorageUnavailableError extends Error {
    readonly code = 'SECURE_STORAGE_UNAVAILABLE';

    constructor() {
        super('Secure credential storage is unavailable. Plaintext fallback is disabled.');
        this.name = 'SecureStorageUnavailableError';
    }
}

/** Electron-safeStorage-backed credentials persisted only as encrypted bytes. */
export class SafeStorageSecretStore implements SecretStore {
    constructor(
        private readonly state: StateStore,
        private readonly crypto: SafeStorageCryptoCapability,
    ) {}

    isAvailable(): boolean {
        return isSafeStorageCapabilityUsable(this.crypto);
    }

    async get(key: string): Promise<string | undefined> {
        if (!this.isAvailable()) return undefined;
        const value = this.state.get<unknown>(stateKey(key));
        if (value === undefined) return undefined;
        const record = parseEncryptedRecord(value);
        return this.crypto.decryptString(decodeBase64(record.ciphertext));
    }

    async store(key: string, value: string): Promise<void> {
        this.requireAvailable();
        const encrypted = this.crypto.encryptString(value);
        const record: EncryptedCredentialRecord = {
            version: 1,
            ciphertext: encrypted.toString('base64'),
        };
        await this.state.update(stateKey(key), record);
    }

    async delete(key: string): Promise<void> {
        this.requireAvailable();
        await this.state.update(stateKey(key), undefined);
    }

    private requireAvailable(): void {
        if (!this.isAvailable()) throw new SecureStorageUnavailableError();
    }
}

export function isSafeStorageCapabilityUsable(
    capability: SafeStorageAvailabilityCapability,
): boolean {
    try {
        if (!capability.isEncryptionAvailable()) return false;
        return capability.getSelectedStorageBackend?.() !== 'basic_text';
    } catch {
        return false;
    }
}

function stateKey(key: string): string {
    if (!key) throw new Error('Credential key must not be empty.');
    return `${SECRET_KEY_PREFIX}${key}`;
}

function parseEncryptedRecord(value: unknown): EncryptedCredentialRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidRecord();
    }
    const candidate = value as Partial<EncryptedCredentialRecord>;
    if (candidate.version !== 1 || typeof candidate.ciphertext !== 'string') {
        throw invalidRecord();
    }
    return { version: 1, ciphertext: candidate.ciphertext };
}

function decodeBase64(value: string): Buffer {
    if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw invalidRecord();
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) throw invalidRecord();
    return decoded;
}

function invalidRecord(): Error {
    return new Error('Encrypted credential record is invalid.');
}
