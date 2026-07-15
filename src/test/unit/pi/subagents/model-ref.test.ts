import { describe, expect, it } from 'vitest';
import { formatModelRef, parseModelRef, sameModelRef } from '../../../../pi/subagents/model-ref';

describe('subagent model references', () => {
    it('parses canonical provider/id while preserving slashes in model IDs', () => {
        const model = parseModelRef('ollama/local/Qwen3.6-27B-Coding');
        expect(model).toEqual({ provider: 'ollama', id: 'local/Qwen3.6-27B-Coding' });
        expect(formatModelRef(model)).toBe('ollama/local/Qwen3.6-27B-Coding');
    });

    it('normalizes object references without changing identity', () => {
        const model = parseModelRef({ provider: ' deepseek ', id: ' deepseek-reasoner ' });
        expect(model).toEqual({ provider: 'deepseek', id: 'deepseek-reasoner' });
        expect(sameModelRef(model, { provider: 'deepseek', id: 'deepseek-reasoner' })).toBe(true);
    });

    it.each(['deepseek', '/model', 'provider/', 'provider/model with space'])('rejects invalid reference %s', (value) => {
        expect(() => parseModelRef(value)).toThrow();
    });
});
