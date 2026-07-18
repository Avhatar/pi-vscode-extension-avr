import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from '../../../shared/typed-event';

describe('TypedEventEmitter', () => {
    it('delivers typed values in subscription order and isolates listener failures', () => {
        const emitter = new TypedEventEmitter<number>();
        const calls: string[] = [];
        emitter.event((value) => calls.push(`first:${value}`));
        emitter.event(() => { throw new Error('listener failed'); });
        emitter.event((value) => calls.push(`last:${value}`));

        expect(() => emitter.fire(3)).not.toThrow();
        expect(calls).toEqual(['first:3', 'last:3']);
    });

    it('supports listener context and disposable collection registration', () => {
        const emitter = new TypedEventEmitter<number>();
        const context = { total: 0 };
        const disposables: Array<{ dispose(): void }> = [];
        emitter.event(function (this: typeof context, value) {
            this.total += value;
        }, context, disposables);

        emitter.fire(4);
        disposables[0].dispose();
        emitter.fire(4);

        expect(context.total).toBe(4);
        expect(disposables).toHaveLength(1);
    });

    it('uses snapshot delivery when listeners mutate subscriptions during fire', () => {
        const emitter = new TypedEventEmitter<void>();
        const calls: string[] = [];
        let added = false;
        let second!: { dispose(): void };
        emitter.event(() => {
            calls.push('first');
            second.dispose();
            if (!added) {
                added = true;
                emitter.event(() => calls.push('third'));
            }
        });
        second = emitter.event(() => calls.push('second'));

        emitter.fire();
        emitter.fire();

        expect(calls).toEqual(['first', 'second', 'first', 'third']);
    });

    it('supports idempotent listener and emitter disposal', () => {
        const emitter = new TypedEventEmitter<string>();
        const listener = vi.fn();
        const subscription = emitter.event(listener);

        emitter.fire('first');
        subscription.dispose();
        subscription.dispose();
        emitter.fire('second');
        emitter.dispose();
        emitter.dispose();
        const lateSubscription = emitter.event(listener);
        emitter.fire('third');
        lateSubscription.dispose();

        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith('first');
    });

    it('fires void events without a placeholder argument', () => {
        const emitter = new TypedEventEmitter<void>();
        const listener = vi.fn();
        emitter.event(listener);

        emitter.fire();
        emitter.fire(undefined);

        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenCalledWith(undefined);
    });

    it('requires and forwards an event when the generic type is any', () => {
        const emitter = new TypedEventEmitter<any>();
        const listener = vi.fn();
        emitter.event(listener);

        emitter.fire({ value: 1 });

        expect(listener).toHaveBeenCalledWith({ value: 1 });
    });
});
