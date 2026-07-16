import { describe, expect, it } from 'vitest';
import {
    createProjectToolSelectionDefault,
    disabledToolsFromProjectDefault,
    parseProjectToolSelectionDefault,
} from '../../../shared/project-tool-default';

describe('project tool selection defaults', () => {
    it('captures the exact enabled registry surface', () => {
        expect(createProjectToolSelectionDefault(
            ['read', 'bash', 'todo', 'read'],
            ['bash', 'missing'],
        )).toEqual({
            version: 1,
            enabled: ['read', 'todo'],
        });
    });

    it('disables tools that were not in the saved allowlist', () => {
        const selection = { version: 1 as const, enabled: ['read', 'todo'] };
        expect(disabledToolsFromProjectDefault(selection, [
            'read', 'bash', 'todo', 'new_project_tool',
        ])).toEqual(['bash', 'new_project_tool']);
    });

    it('validates persisted payloads and normalizes duplicates', () => {
        expect(parseProjectToolSelectionDefault({
            version: 1,
            enabled: ['read', 'read', 'todo'],
        })).toEqual({ version: 1, enabled: ['read', 'todo'] });
        expect(parseProjectToolSelectionDefault({ version: 2, enabled: ['read'] })).toBeUndefined();
        expect(parseProjectToolSelectionDefault({ version: 1, enabled: ['read', 42] })).toBeUndefined();
        expect(parseProjectToolSelectionDefault(undefined)).toBeUndefined();
    });
});
