import { describe, expect, it } from 'vitest';
import { TabRegistry } from '../../../../core/chat/tab-registry';

interface TestTab {
    readonly id: string;
    label: string;
}

function tab(id: string, label = id): TestTab {
    return { id, label };
}

describe('TabRegistry', () => {
    it('registers tabs without activation and preserves insertion order', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('c'));
        registry.register(tab('a'));
        registry.register(tab('b'));

        expect(registry.size).toBe(3);
        expect(registry.activeId).toBe('');
        expect(registry.active).toBeUndefined();
        expect(registry.list()).toEqual([tab('c'), tab('a'), tab('b')]);
        expect([...registry.keys()]).toEqual(['c', 'a', 'b']);
        expect([...registry.values()]).toEqual([tab('c'), tab('a'), tab('b')]);
        expect([...registry.entries()]).toEqual([
            ['c', tab('c')],
            ['a', tab('a')],
            ['b', tab('b')],
        ]);
    });

    it('retains Map replacement order and returns independent list snapshots', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('a'));
        registry.register(tab('b'));
        registry.activate('a');
        const firstSnapshot = registry.list();

        registry.register(tab('a', 'updated'));

        expect(registry.size).toBe(2);
        expect(registry.activeId).toBe('a');
        expect(registry.get('a')).toEqual(tab('a', 'updated'));
        expect(registry.list()).toEqual([tab('a', 'updated'), tab('b')]);
        expect(firstSnapshot).toEqual([tab('a'), tab('b')]);
    });

    it('looks up tabs and finds the first matching entry', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('a', 'alpha'));
        registry.register(tab('b', 'beta'));
        registry.register(tab('c', 'beta'));

        expect(registry.has('a')).toBe(true);
        expect(registry.has('missing')).toBe(false);
        expect(registry.get('b')).toEqual(tab('b', 'beta'));
        expect(registry.get('missing')).toBeUndefined();
        expect(registry.find((entry) => entry.label === 'beta')).toEqual(tab('b', 'beta'));
        expect(registry.find((entry) => entry.label === 'missing')).toBeUndefined();
    });

    it('activates only a present non-current tab', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('a'));
        registry.register(tab('b'));

        expect(registry.activate('missing')).toBe(false);
        expect(registry.activeId).toBe('');
        expect(registry.activate('a')).toBe(true);
        expect(registry.active).toEqual(tab('a'));
        expect(registry.activate('a')).toBe(false);
        expect(registry.activate('b')).toBe(true);
        expect(registry.activeId).toBe('b');
    });

    it('removes a non-active tab without changing the active selection', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('a'));
        registry.register(tab('b'));
        registry.register(tab('c'));
        registry.activate('b');

        expect(registry.remove('a')).toEqual({
            tab: tab('a'),
            wasActive: false,
            activeId: 'b',
        });
        expect(registry.activeId).toBe('b');
        expect(registry.list()).toEqual([tab('b'), tab('c')]);
        expect(registry.remove('missing')).toBeUndefined();
    });

    it('selects the first remaining insertion-order tab after active removal', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('a'));
        registry.register(tab('b'));
        registry.register(tab('c'));
        registry.activate('b');

        expect(registry.remove('b')).toEqual({
            tab: tab('b'),
            wasActive: true,
            activeId: 'a',
        });
        expect(registry.active).toEqual(tab('a'));
    });

    it('clears the active selection after removing the final tab', () => {
        const registry = new TabRegistry<TestTab>();
        registry.register(tab('sole'));
        registry.activate('sole');

        expect(registry.remove('sole')).toEqual({
            tab: tab('sole'),
            wasActive: true,
            activeId: '',
        });
        expect(registry.size).toBe(0);
        expect(registry.activeId).toBe('');
        expect(registry.active).toBeUndefined();
    });
});
