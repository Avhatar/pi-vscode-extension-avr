import { beforeAll, describe, expect, it } from 'vitest';
import { getFallbackTestModel, getPreferredTestModel, getTestModelRuntime, initTestInfra } from '../../setup';

beforeAll(async () => {
    await initTestInfra();
});

describe('Model runtime', () => {
    it('lists available models', () => {
        const runtime = getTestModelRuntime();
        const models = runtime.getAvailableSnapshot();
        expect(models.length).toBeGreaterThan(0);
    });

    it('finds the selected test model', () => {
        const runtime = getTestModelRuntime();
        const selected = getPreferredTestModel(runtime) ?? getFallbackTestModel(runtime);
        const model = runtime.getModel(selected.provider, selected.id);
        expect(model).toBeDefined();
        expect(model!.id).toBe(selected.id);
    });

    it('model has expected properties', () => {
        const runtime = getTestModelRuntime();
        const model = getPreferredTestModel(runtime) ?? getFallbackTestModel(runtime);
        expect(model).toBeDefined();
        expect(typeof model.provider).toBe('string');
        expect(typeof model.id).toBe('string');
    });

    it('returns undefined for nonexistent model', () => {
        const runtime = getTestModelRuntime();
        expect(runtime.getModel('nonexistent', 'nonexistent')).toBeUndefined();
    });
});
