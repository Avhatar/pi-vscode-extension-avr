import { describe, expect, it, vi } from 'vitest';
import { PiSessionRuntime } from '../../../pi/session-runtime';

describe('Pi session runtime ownership', () => {
    it('replaces the active session only after detaching and disposing the previous one', async () => {
        const order: string[] = [];
        const first = createState('first', order);
        const second = createState('second', order);
        const runtime = new PiSessionRuntime((session) => {
            order.push(`${session.sessionId}:bind`);
            return () => order.push(`${session.sessionId}:unbind`);
        });

        await runtime.start(async () => {
            order.push('first:create');
            return first;
        });
        expect(runtime.session).toBe(first.session);
        expect(runtime.sessionManager).toBe(first.sessionManager);
        expect(runtime.isReady).toBe(true);

        await runtime.replace(async () => {
            order.push('second:create');
            return second;
        });

        expect(runtime.session).toBe(second.session);
        expect(runtime.sessionManager).toBe(second.sessionManager);
        expect(order).toEqual([
            'first:create',
            'first:bind',
            'first:unbind',
            'first:dispose',
            'second:create',
            'second:bind',
        ]);

        await runtime.dispose();
        expect(order.slice(-2)).toEqual(['second:unbind', 'second:dispose']);
        expect(runtime.session).toBeUndefined();
        expect(runtime.sessionManager).toBeUndefined();
        expect(runtime.isReady).toBe(false);
    });

    it('retains a created replacement for cleanup when host binding fails', async () => {
        const first = createState('first', []);
        const second = createState('second', []);
        const runtime = new PiSessionRuntime((session) => {
            if (session.sessionId === 'second') throw new Error('binding failed');
            return vi.fn();
        });
        await runtime.start(async () => first);

        await expect(runtime.replace(async () => second)).rejects.toThrow('binding failed');

        expect(runtime.session).toBe(second.session);
        await runtime.dispose();
        expect(second.session.dispose).toHaveBeenCalledOnce();
    });

    it('rejects overlapping starts instead of orphaning a completed session', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first = createState('first', []);
        const runtime = new PiSessionRuntime(() => vi.fn());
        const starting = runtime.start(async () => {
            await gate;
            return first;
        });

        await expect(runtime.start(async () => createState('second', [])))
            .rejects.toThrow('Session runtime transition already in progress');
        release();
        await starting;
        await runtime.dispose();

        expect(first.session.dispose).toHaveBeenCalledOnce();
    });

    it('rejects start re-entry before invoking the nested factory', async () => {
        const state = createState('first', []);
        const nestedFactory = vi.fn(async () => createState('nested', []));
        const runtime = new PiSessionRuntime(() => vi.fn());
        let nestedResult!: Promise<unknown>;

        await runtime.start(async () => {
            nestedResult = runtime.start(nestedFactory).catch((error) => error);
            return state;
        });

        await expect(nestedResult).resolves.toMatchObject({
            message: 'Session runtime transition already in progress',
        });
        expect(nestedFactory).not.toHaveBeenCalled();
        await runtime.dispose();
        expect(state.session.dispose).toHaveBeenCalledOnce();
    });

    it('rejects replacement re-entry before invoking the nested factory', async () => {
        const first = createState('first', []);
        const second = createState('second', []);
        const nestedFactory = vi.fn(async () => createState('nested', []));
        const runtime = new PiSessionRuntime(() => vi.fn());
        await runtime.start(async () => first);
        let nestedResult!: Promise<unknown>;

        await runtime.replace(async () => {
            nestedResult = runtime.replace(nestedFactory).catch((error) => error);
            return second;
        });

        await expect(nestedResult).resolves.toMatchObject({
            message: 'Session runtime transition already in progress',
        });
        expect(nestedFactory).not.toHaveBeenCalled();
        await runtime.dispose();
        expect(first.session.dispose).toHaveBeenCalledOnce();
        expect(second.session.dispose).toHaveBeenCalledOnce();
    });

    it('publishes the transition guard before invoking a re-entrant factory', async () => {
        const state = createState('first', []);
        const unbind = vi.fn();
        const runtime = new PiSessionRuntime(() => unbind);
        let disposing!: Promise<void>;

        const starting = runtime.start(async () => {
            disposing = runtime.dispose();
            return state;
        });
        await starting;
        await disposing;

        expect(unbind).toHaveBeenCalledOnce();
        expect(state.session.dispose).toHaveBeenCalledOnce();
        expect(runtime.isReady).toBe(false);
    });

    it('rejects overlapping replacements before a second factory can run', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first = createState('first', []);
        const second = createState('second', []);
        const overlappingFactory = vi.fn(async () => createState('third', []));
        const runtime = new PiSessionRuntime(() => vi.fn());
        await runtime.start(async () => first);
        const replacing = runtime.replace(async () => {
            await gate;
            return second;
        });

        await expect(runtime.replace(overlappingFactory))
            .rejects.toThrow('Session runtime transition already in progress');
        expect(overlappingFactory).not.toHaveBeenCalled();
        release();
        await replacing;
        await runtime.dispose();

        expect(first.session.dispose).toHaveBeenCalledOnce();
        expect(second.session.dispose).toHaveBeenCalledOnce();
    });

    it('waits for an in-flight start before disposing its created session', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const state = createState('first', []);
        const unbind = vi.fn();
        const runtime = new PiSessionRuntime(() => unbind);
        const starting = runtime.start(async () => {
            await gate;
            return state;
        });

        const disposing = runtime.dispose();
        release();
        await starting;
        await disposing;

        expect(unbind).toHaveBeenCalledOnce();
        expect(state.session.dispose).toHaveBeenCalledOnce();
        expect(runtime.isReady).toBe(false);
    });

    it('marks teardown work before invoking callbacks so failures cannot double-fire', async () => {
        const state = createState('first', []);
        const unbind = vi.fn(() => { throw new Error('unbind failed'); });
        const runtime = new PiSessionRuntime(() => unbind);
        await runtime.start(async () => state);

        await expect(runtime.replace(async () => createState('second', [])))
            .rejects.toThrow('unbind failed');
        await runtime.dispose();

        expect(unbind).toHaveBeenCalledOnce();
        expect(state.session.dispose).toHaveBeenCalledOnce();
    });

    it('does not retry a session disposer that throws during invalidation', async () => {
        const dispose = vi.fn(() => { throw new Error('dispose failed'); });
        const state = {
            session: { sessionId: 'first', dispose } as any,
            sessionManager: {} as any,
        };
        const runtime = new PiSessionRuntime(() => vi.fn());
        await runtime.start(async () => state);

        await expect(runtime.replace(async () => createState('second', [])))
            .rejects.toThrow('dispose failed');
        await runtime.dispose();

        expect(dispose).toHaveBeenCalledOnce();
    });

    it('returns one rejected disposal without repeating throwing teardown', async () => {
        const state = createState('first', []);
        const unbind = vi.fn(() => { throw new Error('unbind failed'); });
        const runtime = new PiSessionRuntime(() => unbind);
        await runtime.start(async () => state);

        const disposing = runtime.dispose();
        await expect(disposing).rejects.toThrow('unbind failed');
        expect(runtime.dispose()).toBe(disposing);
        await expect(runtime.dispose()).rejects.toThrow('unbind failed');

        expect(unbind).toHaveBeenCalledOnce();
        expect(state.session.dispose).toHaveBeenCalledOnce();
        expect(runtime.isReady).toBe(false);
    });

    it('retains the invalidated current identity when replacement creation fails', async () => {
        const first = createState('first', []);
        const runtime = new PiSessionRuntime(() => vi.fn());
        await runtime.start(async () => first);

        await expect(runtime.replace(async () => {
            throw new Error('replacement failed');
        })).rejects.toThrow('replacement failed');

        expect(first.session.dispose).toHaveBeenCalledOnce();
        expect(runtime.session).toBe(first.session);
        expect(runtime.sessionManager).toBe(first.sessionManager);
        expect(runtime.isReady).toBe(true);

        await runtime.dispose();
        expect(first.session.dispose).toHaveBeenCalledOnce();
        expect(runtime.isReady).toBe(false);
    });
});

function createState(id: string, order: string[]) {
    return {
        session: {
            sessionId: id,
            dispose: vi.fn(() => order.push(`${id}:dispose`)),
        } as any,
        sessionManager: { id } as any,
    };
}
