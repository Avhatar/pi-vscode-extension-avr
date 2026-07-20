import { describe, expect, it, vi } from 'vitest';
import { DesktopShutdownCoordinator } from '../src/shutdown';

describe('DesktopShutdownCoordinator', () => {
    it('waits for activation, shuts down the runtime, cleans process data, and is idempotent', async () => {
        const order: string[] = [];
        const runtime = {
            shutdown: vi.fn(async () => { order.push('runtime'); }),
        };
        const coordinator = new DesktopShutdownCoordinator({
            timeoutMs: 5_000,
            waitForActivation: async () => { order.push('activation'); },
            getRuntime: () => runtime,
            cleanup: async () => { order.push('cleanup'); },
        });

        const first = coordinator.shutdown();
        const second = coordinator.shutdown();

        expect(second).toBe(first);
        await expect(first).resolves.toEqual({ timedOut: false });
        expect(order).toEqual(['activation', 'runtime', 'cleanup']);
        expect(runtime.shutdown).toHaveBeenCalledOnce();
    });

    it('uses one absolute deadline across activation, runtime shutdown, and cleanup', async () => {
        let now = 0;
        let timeoutCall = 0;
        const timeoutDelays: number[] = [];
        const cleanup = vi.fn(async () => undefined);
        const coordinator = new DesktopShutdownCoordinator({
            timeoutMs: 25,
            now: () => now,
            waitForActivation: async () => { now = 20; },
            getRuntime: () => ({ shutdown: () => new Promise<void>(() => undefined) }),
            cleanup,
            timeout: async (delay) => {
                timeoutDelays.push(delay);
                timeoutCall++;
                if (timeoutCall === 2) now += delay;
                else await new Promise<void>(() => undefined);
            },
        });

        await expect(coordinator.shutdown()).resolves.toEqual({ timedOut: true });
        expect(timeoutDelays).toEqual([25, 5, 0]);
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('bounds a stuck runtime shutdown and still cleans process-owned data', async () => {
        const cleanup = vi.fn(async () => undefined);
        const coordinator = new DesktopShutdownCoordinator({
            timeoutMs: 25,
            getRuntime: () => ({ shutdown: () => new Promise<void>(() => undefined) }),
            cleanup,
            timeout: async () => undefined,
        });

        await expect(coordinator.shutdown()).resolves.toEqual({ timedOut: true });
        expect(cleanup).toHaveBeenCalledOnce();
    });
});
