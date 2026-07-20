import { describe, expect, it, vi } from 'vitest';
import {
    FILE_UNDO_VIEW_KEY_PREFIX,
    PLAN_MODE_INSTRUCTIONS,
    TODO_ENABLED_KEY_PREFIX,
    composeEffectiveDisabledTools,
    computeEffectiveCache,
    decorateDirectPrompt,
    isChatTabBusy,
    prepareCacheForRequest,
    readDisabledTools,
    readSessionBoolean,
    sessionPreferenceKey,
    writeDisabledTools,
    writeSessionBoolean,
} from '../../../../core/chat/chat-preferences';
import type { StateStore } from '../../../../core/ports/chat-platform';

function createStore(initial: Record<string, unknown> = {}): StateStore & {
    values: Map<string, unknown>;
    update: ReturnType<typeof vi.fn>;
} {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get<T>(key: string, fallback?: T): T | undefined {
            return (values.has(key) ? values.get(key) : fallback) as T | undefined;
        },
        update: vi.fn(async (key: string, value: unknown) => {
            values.set(key, value);
        }),
    } as any;
}

describe('portable chat preference policy', () => {
    it('preserves session-scoped keys and stored boolean precedence', async () => {
        const path = '/sessions/chat.jsonl';
        const store = createStore({ [`${TODO_ENABLED_KEY_PREFIX}${path}`]: false });

        expect(sessionPreferenceKey(TODO_ENABLED_KEY_PREFIX, undefined)).toBeUndefined();
        expect(sessionPreferenceKey(TODO_ENABLED_KEY_PREFIX, path)).toBe(`${TODO_ENABLED_KEY_PREFIX}${path}`);
        expect(readSessionBoolean(store, TODO_ENABLED_KEY_PREFIX, path, true)).toBe(false);
        expect(readSessionBoolean(store, FILE_UNDO_VIEW_KEY_PREFIX, path, true)).toBe(true);

        await writeSessionBoolean(store, FILE_UNDO_VIEW_KEY_PREFIX, path, false);
        await writeSessionBoolean(store, FILE_UNDO_VIEW_KEY_PREFIX, undefined, true);
        expect(store.update).toHaveBeenCalledOnce();
        expect(store.update).toHaveBeenCalledWith(`${FILE_UNDO_VIEW_KEY_PREFIX}${path}`, false);
    });

    it('reads persisted disabled tools before project defaults and writes normalized values', async () => {
        const path = '/sessions/chat.jsonl';
        const store = createStore({
            [`pi-code.disabledTools.${path}`]: ['read', 42, 'read', ''],
        });
        const projectDefault = { version: 1 as const, enabled: ['read', 'todo'] };

        expect(readDisabledTools(store, path, projectDefault, ['read', 'write', 'todo']))
            .toEqual(['read', 'read']);
        expect(readDisabledTools(createStore(), path, projectDefault, ['read', 'write', 'todo']))
            .toEqual(['write']);

        await writeDisabledTools(store, path, ['write', 'write', '', 'read']);
        expect(store.update).toHaveBeenLastCalledWith(
            `pi-code.disabledTools.${path}`,
            ['write', 'read'],
        );
    });

    it('composes dedicated capability gates exactly once', () => {
        expect(composeEffectiveDisabledTools(['read', 'todo', 'subagent'], true, false))
            .toEqual(['read', 'subagent']);
        expect(composeEffectiveDisabledTools(['read'], false, true))
            .toEqual(['read', 'todo']);
    });

    it('decorates direct prompts only when Plan Mode is enabled', () => {
        expect(decorateDirectPrompt('task', false)).toBe('task');
        expect(decorateDirectPrompt('task', true)).toBe(`${PLAN_MODE_INSTRUCTIONS}\n\ntask`);
    });

    it('reports streaming or compacting tabs as busy', () => {
        expect(isChatTabBusy({ isStreamingLocal: false, isCompacting: false })).toBe(false);
        expect(isChatTabBusy({ isStreamingLocal: true, isCompacting: false })).toBe(true);
        expect(isChatTabBusy({ isStreamingLocal: false, isCompacting: true })).toBe(true);
    });
});

describe('portable prompt cache policy', () => {
    const base = {
        cacheMode: 'auto' as const,
        provider: 'anthropic',
        modelId: 'claude',
        lastTurnEndAt: 0,
        maxIdleGapMs: 0,
        contextTokens: 0,
        now: 1_000_000,
    };

    it('honors forced and explicit modes before auto heuristics', () => {
        expect(computeEffectiveCache({ ...base, provider: 'qwen', cacheMode: 'long' })).toBe('short');
        expect(computeEffectiveCache({ ...base, cacheMode: 'long' })).toBe('long');
        expect(computeEffectiveCache({ ...base, cacheMode: 'short' })).toBe('short');
    });

    it('uses long for write-free providers, observed idle gaps, and large contexts', () => {
        expect(computeEffectiveCache({ ...base, provider: 'openai' })).toBe('long');
        expect(computeEffectiveCache({ ...base, maxIdleGapMs: 120_000 })).toBe('long');
        expect(computeEffectiveCache({ ...base, contextTokens: 20_000 })).toBe('long');
        expect(computeEffectiveCache({ ...base })).toBe('short');
    });

    it('commits only the current realized idle gap while preparing a request', () => {
        expect(prepareCacheForRequest({
            ...base,
            lastTurnEndAt: 700_000,
            maxIdleGapMs: 100_000,
        })).toEqual({ effective: 'long', maxIdleGapMs: 300_000 });
        expect(prepareCacheForRequest(base)).toEqual({ effective: 'short', maxIdleGapMs: 0 });
    });
});
