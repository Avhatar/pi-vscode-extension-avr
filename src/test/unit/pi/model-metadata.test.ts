import { describe, expect, it } from 'vitest';
import { isContextUsageEstimated } from '../../../pi/context-usage';
import { applyModelMetadataCorrections } from '../../../pi/model-metadata';

describe('GPT-5.6 model metadata corrections', () => {
    it('uses provider-specific context windows for all GPT-5.6 variants', () => {
        const models = ['sol', 'terra', 'luna'].flatMap(variant => [
            model('openai-codex', `gpt-5.6-${variant}`, 372_000),
            model('openai', `gpt-5.6-${variant}`, 272_000),
        ]);
        const registry = { getAll: () => models } as any;

        expect(applyModelMetadataCorrections(registry)).toBe(6);
        expect(models.filter(item => item.provider === 'openai-codex')
            .every(item => item.contextWindow === 272_000)).toBe(true);
        expect(models.filter(item => item.provider === 'openai')
            .every(item => item.contextWindow === 1_050_000)).toBe(true);
    });

    it('preserves explicit or future upstream values', () => {
        const models = [
            model('openai-codex', 'gpt-5.6-sol', 300_000),
            model('openai', 'gpt-5.6-sol', 1_050_000),
            model('openai-codex', 'gpt-5.5-codex', 372_000),
        ];

        expect(applyModelMetadataCorrections({ getAll: () => models } as any)).toBe(0);
        expect(models.map(item => item.contextWindow)).toEqual([300_000, 1_050_000, 372_000]);
    });

    it('is idempotent', () => {
        const models = [model('openai-codex', 'gpt-5.6-luna', 372_000)];
        const registry = { getAll: () => models } as any;

        expect(applyModelMetadataCorrections(registry)).toBe(1);
        expect(applyModelMetadataCorrections(registry)).toBe(0);
    });
});

describe('context usage estimation marker', () => {
    it('marks usage as exact when the latest message has provider usage', () => {
        expect(isContextUsageEstimated([
            { role: 'user', content: 'hello' },
            assistantWithUsage(),
        ])).toBe(false);
    });

    it('marks trailing messages and conversations without usage as estimated', () => {
        expect(isContextUsageEstimated([
            assistantWithUsage(),
            { role: 'user', content: 'next turn' },
        ])).toBe(true);
        expect(isContextUsageEstimated([
            { role: 'user', content: 'first turn' },
        ])).toBe(true);
    });

    it('ignores invalid assistant usage snapshots', () => {
        expect(isContextUsageEstimated([
            assistantWithUsage('error'),
        ])).toBe(true);
        expect(isContextUsageEstimated([
            { ...assistantWithUsage(), usage: { totalTokens: 0, input: 0, output: 0 } },
        ])).toBe(true);
        expect(isContextUsageEstimated([])).toBe(false);
    });
});

function model(provider: string, id: string, contextWindow: number) {
    return { provider, id, contextWindow };
}

function assistantWithUsage(stopReason = 'stop') {
    return {
        role: 'assistant',
        stopReason,
        usage: { totalTokens: 123, input: 100, output: 23, cacheRead: 0, cacheWrite: 0 },
    };
}
