import { describe, expect, it } from 'vitest';
import { SubagentCapabilityGate, type SubagentGateStorage } from '../../../../pi/subagents/gating';

class Storage implements SubagentGateStorage {
    readonly values = new Map<string, boolean>();
    get<T>(key: string, fallback: T): T {
        return (this.values.has(key) ? this.values.get(key) : fallback) as T;
    }
    async update(key: string, value: boolean): Promise<void> {
        this.values.set(key, value);
    }
}

describe('per-chat subagent capability gate', () => {
    it('defaults off and composes subagent into the effective denylist', () => {
        const gate = new SubagentCapabilityGate(new Storage(), () => false);
        expect(gate.isEnabled('/session')).toBe(false);
        expect(gate.composeDisabledTools(['bash'], '/session')).toEqual(['bash', 'subagent']);
    });

    it('persists explicit state independently per session path', async () => {
        const storage = new Storage();
        const gate = new SubagentCapabilityGate(storage, () => false);
        expect(await gate.setEnabled('/one', true, false)).toBe(true);
        expect(gate.isEnabled('/one')).toBe(true);
        expect(gate.isEnabled('/two')).toBe(false);
        expect(gate.composeDisabledTools(['subagent'], '/one')).toEqual([]);
    });

    it('rejects busy changes without changing persisted state', async () => {
        const storage = new Storage();
        const gate = new SubagentCapabilityGate(storage, () => true);
        expect(await gate.setEnabled('/session', false, true)).toBe(false);
        expect(gate.isEnabled('/session')).toBe(true);
        expect(storage.values.size).toBe(0);
    });

    it('uses the configured default only until the chat is customized', async () => {
        let defaultEnabled = false;
        const storage = new Storage();
        const gate = new SubagentCapabilityGate(storage, () => defaultEnabled);
        expect(gate.isEnabled('/session')).toBe(false);
        defaultEnabled = true;
        expect(gate.isEnabled('/session')).toBe(true);
        await gate.setEnabled('/session', false, false);
        expect(gate.isEnabled('/session')).toBe(false);
        defaultEnabled = false;
        expect(gate.isEnabled('/session')).toBe(false);
    });
});
