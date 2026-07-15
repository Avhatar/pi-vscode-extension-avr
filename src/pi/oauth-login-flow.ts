import type {
    OAuthAuthInfo,
    OAuthDeviceCodeInfo,
    OAuthLoginCallbacks,
    OAuthPrompt,
    OAuthSelectPrompt,
} from '@earendil-works/pi-ai';
import type { OAuthFlowState } from '../shared/protocol';

interface PendingInput {
    kind: 'text' | 'select';
    allowEmpty: boolean;
    optionIds?: Set<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
}

export interface OAuthLoginFlowOptions {
    onState: (state: OAuthFlowState) => void;
    openExternal: (url: string) => void;
}

/** Bridges the Pi SDK OAuth callback contract to the settings webview. */
export class OAuthLoginFlow {
    private readonly _abortController = new AbortController();
    private _pending?: PendingInput;
    private _finished = false;
    private _cancelled = false;
    private _browserAuth?: OAuthAuthInfo;

    constructor(private readonly _options: OAuthLoginFlowOptions) {}

    get cancelled(): boolean {
        return this._cancelled;
    }

    get callbacks(): OAuthLoginCallbacks {
        return {
            onAuth: (info) => this._handleAuth(info),
            onDeviceCode: (info) => this._handleDeviceCode(info),
            onPrompt: (prompt) => this._promptForText(prompt),
            onProgress: (message) => {
                this._ensureActive();
                this._options.onState({ kind: 'progress', message });
            },
            onManualCodeInput: () => this._promptForManualCode(),
            onSelect: (prompt) => this._promptForSelection(prompt),
            signal: this._abortController.signal,
        };
    }

    submitText(value: string): void {
        const pending = this._requirePending('text');
        if (!pending.allowEmpty && !value.trim()) {
            throw new Error('A value is required to continue authentication.');
        }
        this._pending = undefined;
        pending.resolve(value.trim());
    }

    submitSelection(optionId: string): void {
        const pending = this._requirePending('select');
        if (!pending.optionIds?.has(optionId)) {
            throw new Error('The selected authentication option is no longer available.');
        }
        this._pending = undefined;
        pending.resolve(optionId);
    }

    cancel(reason = 'Login cancelled'): void {
        if (this._finished) return;
        this._finished = true;
        this._cancelled = true;
        const error = new Error(reason);
        this._abortController.abort(error);
        const pending = this._pending;
        this._pending = undefined;
        pending?.reject(error);
    }

    finish(): void {
        this._finished = true;
        this._pending = undefined;
    }

    private _handleAuth(info: OAuthAuthInfo): void {
        this._ensureActive();
        this._browserAuth = info;
        this._options.onState({
            kind: 'awaitingBrowser',
            url: info.url,
            instructions: info.instructions,
            promptForCode: {
                message: 'After logging in, paste the authorization code or callback URL here:',
                placeholder: 'Paste code or full callback URL',
                allowEmpty: false,
            },
        });
        this._options.openExternal(info.url);
    }

    private _handleDeviceCode(info: OAuthDeviceCodeInfo): void {
        this._ensureActive();
        this._options.onState({
            kind: 'awaitingDeviceCode',
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresInSeconds: info.expiresInSeconds,
        });
        this._options.openExternal(info.verificationUri);
    }

    private _promptForText(prompt: OAuthPrompt): Promise<string> {
        this._ensureActive();
        this._options.onState({
            kind: 'awaitingPrompt',
            message: prompt.message,
            placeholder: prompt.placeholder,
            allowEmpty: prompt.allowEmpty ?? false,
        });
        return this._waitForInput('text', prompt.allowEmpty ?? false) as Promise<string>;
    }

    private _promptForManualCode(): Promise<string> {
        this._ensureActive();
        if (!this._browserAuth) {
            this._options.onState({
                kind: 'awaitingPrompt',
                message: 'Paste the authorization code or callback URL:',
                placeholder: 'Paste code or full callback URL',
                allowEmpty: false,
            });
        }
        return this._waitForInput('text', false) as Promise<string>;
    }

    private _promptForSelection(prompt: OAuthSelectPrompt): Promise<string | undefined> {
        this._ensureActive();
        this._options.onState({
            kind: 'awaitingSelection',
            message: prompt.message,
            options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
        });
        return this._waitForInput('select', false, new Set(prompt.options.map((option) => option.id)));
    }

    private _waitForInput(kind: PendingInput['kind'], allowEmpty: boolean, optionIds?: Set<string>): Promise<string> {
        if (this._pending) {
            return Promise.reject(new Error('The OAuth provider requested overlapping user input.'));
        }
        return new Promise<string>((resolve, reject) => {
            this._pending = { kind, allowEmpty, optionIds, resolve, reject };
        });
    }

    private _requirePending(kind: PendingInput['kind']): PendingInput {
        this._ensureActive();
        if (!this._pending || this._pending.kind !== kind) {
            throw new Error('This authentication input is no longer expected.');
        }
        return this._pending;
    }

    private _ensureActive(): void {
        if (this._finished || this._abortController.signal.aborted) {
            throw new Error('Login cancelled');
        }
    }
}
