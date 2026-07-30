import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { OAuthFlowState } from '../shared/protocol';

interface PendingInput {
    kind: 'text' | 'select';
    allowEmpty: boolean;
    optionIds?: Set<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    abortCleanup?: () => void;
}

export interface OAuthLoginFlowOptions {
    onState: (state: OAuthFlowState) => void;
    openExternal: (url: string) => void;
}

/** Bridges the Pi SDK AuthInteraction contract to the settings webview. */
export class OAuthLoginFlow {
    private readonly _abortController = new AbortController();
    private _pending?: PendingInput;
    private _finished = false;
    private _cancelled = false;

    constructor(private readonly _options: OAuthLoginFlowOptions) {}

    get cancelled(): boolean {
        return this._cancelled;
    }

    get interaction(): AuthInteraction {
        return {
            signal: this._abortController.signal,
            prompt: (prompt) => this._handlePrompt(prompt),
            notify: (event) => this._handleNotification(event),
        };
    }

    submitText(value: string): void {
        const pending = this._requirePending('text');
        if (!pending.allowEmpty && !value.trim()) {
            throw new Error('A value is required to continue authentication.');
        }
        this._pending = undefined;
        pending.abortCleanup?.();
        pending.resolve(value.trim());
    }

    submitSelection(optionId: string): void {
        const pending = this._requirePending('select');
        if (!pending.optionIds?.has(optionId)) {
            throw new Error('The selected authentication option is no longer available.');
        }
        this._pending = undefined;
        pending.abortCleanup?.();
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
        pending?.abortCleanup?.();
        pending?.reject(error);
    }

    finish(): void {
        this._finished = true;
        this._pending?.abortCleanup?.();
        this._pending = undefined;
    }

    private _handlePrompt(prompt: AuthPrompt): Promise<string> {
        this._ensureActive();
        if (prompt.type === 'select') {
            this._options.onState({
                kind: 'awaitingSelection',
                message: prompt.message,
                options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
            });
            return this._waitForInput(
                'select',
                false,
                new Set(prompt.options.map((option) => option.id)),
                prompt.signal,
            );
        }

        const allowEmpty = prompt.type === 'text'
            && (prompt as AuthPrompt & { allowEmpty?: boolean }).allowEmpty === true;
        this._options.onState({
            kind: 'awaitingPrompt',
            message: prompt.message,
            placeholder: prompt.placeholder,
            allowEmpty,
        });
        return this._waitForInput('text', allowEmpty, undefined, prompt.signal);
    }

    private _handleNotification(event: AuthEvent): void {
        this._ensureActive();
        if (event.type === 'auth_url') {
            this._options.onState({
                kind: 'awaitingBrowser',
                url: event.url,
                instructions: event.instructions,
            });
            this._options.openExternal(event.url);
            return;
        }
        if (event.type === 'device_code') {
            this._options.onState({
                kind: 'awaitingDeviceCode',
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                expiresInSeconds: event.expiresInSeconds,
            });
            this._options.openExternal(event.verificationUri);
            return;
        }
        this._options.onState({ kind: 'progress', message: event.message });
    }

    private _waitForInput(
        kind: PendingInput['kind'],
        allowEmpty: boolean,
        optionIds?: Set<string>,
        signal?: AbortSignal,
    ): Promise<string> {
        if (this._pending) {
            return Promise.reject(new Error('The OAuth provider requested overlapping user input.'));
        }
        if (signal?.aborted) {
            return Promise.reject(abortError(signal.reason));
        }
        return new Promise<string>((resolve, reject) => {
            const pending: PendingInput = { kind, allowEmpty, optionIds, resolve, reject };
            if (signal) {
                const onAbort = () => {
                    if (this._pending !== pending) return;
                    this._pending = undefined;
                    reject(abortError(signal.reason));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                pending.abortCleanup = () => signal.removeEventListener('abort', onAbort);
            }
            this._pending = pending;
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

function abortError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error('Login cancelled');
}
