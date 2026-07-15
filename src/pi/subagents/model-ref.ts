import type { ModelRef } from './types';

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseModelRef(value: ModelRef | string, label = 'model'): ModelRef {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const separator = trimmed.indexOf('/');
        if (separator <= 0 || separator === trimmed.length - 1) {
            throw new Error(`${label} must use the canonical provider/id format.`);
        }
        return validateModelRef({
            provider: trimmed.slice(0, separator),
            id: trimmed.slice(separator + 1),
        }, label);
    }
    return validateModelRef(value, label);
}

export function validateModelRef(value: ModelRef, label = 'model'): ModelRef {
    const provider = typeof value?.provider === 'string' ? value.provider.trim() : '';
    const id = typeof value?.id === 'string' ? value.id.trim() : '';
    if (!provider || !PROVIDER_PATTERN.test(provider)) {
        throw new Error(`${label} provider must be a non-empty provider identifier.`);
    }
    if (!id || /\s/.test(id)) {
        throw new Error(`${label} id must be non-empty and contain no whitespace.`);
    }
    return { provider, id };
}

export function formatModelRef(model: ModelRef): string {
    return `${model.provider}/${model.id}`;
}

export function sameModelRef(left: ModelRef, right: ModelRef): boolean {
    return left.provider === right.provider && left.id === right.id;
}
