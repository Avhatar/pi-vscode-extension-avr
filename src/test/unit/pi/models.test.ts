import { describe, it, expect } from 'vitest';
import { getFallbackTestModel, getModelRegistry, getPreferredTestModel } from '../../setup';

describe('Model Registry', () => {
    it('lists available models', () => {
        const registry = getModelRegistry();
        const models = registry.getAvailable();
        expect(models.length).toBeGreaterThan(0);
    });

    it('finds the selected test model', () => {
        const registry = getModelRegistry();
        const selected = getPreferredTestModel(registry) ?? getFallbackTestModel(registry);
        const model = registry.find(selected.provider, selected.id);
        expect(model).toBeDefined();
        expect(model!.id).toBe(selected.id);
    });

    it('model has expected properties', () => {
        const registry = getModelRegistry();
        const model = getPreferredTestModel(registry) ?? getFallbackTestModel(registry);
        expect(model).toBeDefined();
        expect(typeof model.provider).toBe('string');
        expect(typeof model.id).toBe('string');
    });

    it('returns undefined for nonexistent model', () => {
        const registry = getModelRegistry();
        const model = registry.find('nonexistent', 'nonexistent');
        expect(model).toBeUndefined();
    });
});
