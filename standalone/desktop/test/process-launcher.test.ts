import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    createDesktopProcessLaunchSpec,
    launchDesktopProcess,
} from '../src/process-launcher';

describe('desktop process launcher', () => {
    it('launches the original portable executable without the extracted app path', () => {
        const spec = createDesktopProcessLaunchSpec({
            executablePath: 'C:/Temp/extracted/Pi Code Desktop.exe',
            appPath: 'C:/Temp/extracted/resources/app.asar',
            portableExecutablePath: 'C:/Apps/Pi-Code-Desktop-Portable.exe',
            defaultApp: false,
            inheritedEnvironment: {
                ELECTRON_RUN_AS_NODE: '1',
                KEEP_ME: 'yes',
            },
        });

        expect(spec).toEqual({
            command: 'C:/Apps/Pi-Code-Desktop-Portable.exe',
            args: [],
            environment: { KEEP_ME: 'yes' },
        });
    });

    it('includes the app path only for Electron default-app development', () => {
        const spec = createDesktopProcessLaunchSpec({
            executablePath: 'C:/project/node_modules/electron/electron.exe',
            appPath: 'C:/project/standalone/desktop',
            defaultApp: true,
            inheritedEnvironment: {},
        });

        expect(spec.command).toBe('C:/project/node_modules/electron/electron.exe');
        expect(spec.args).toEqual(['C:/project/standalone/desktop']);
    });

    it('spawns a detached independent process and unreferences it', async () => {
        const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
        child.unref = vi.fn();
        const spawn = vi.fn(() => child);
        const launch = launchDesktopProcess as unknown as (
            options: Parameters<typeof launchDesktopProcess>[0],
            spawn: any,
        ) => Promise<void>;

        const pending = launch({
            executablePath: 'C:/Apps/Pi Code Desktop.exe',
            appPath: 'C:/Apps/resources/app.asar',
            defaultApp: false,
            inheritedEnvironment: { ELECTRON_RUN_AS_NODE: '1' },
        }, spawn);
        child.emit('spawn');
        await expect(pending).resolves.toBeUndefined();

        expect(spawn).toHaveBeenCalledWith('C:/Apps/Pi Code Desktop.exe', [], {
            detached: true,
            env: {},
            stdio: 'ignore',
            windowsHide: false,
        });
        expect(child.unref).toHaveBeenCalledOnce();
    });

    it('reports an asynchronous spawn failure instead of crashing the parent process', async () => {
        const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
        child.unref = vi.fn();
        const spawn = vi.fn(() => child);
        const launch = launchDesktopProcess as unknown as (
            options: Parameters<typeof launchDesktopProcess>[0],
            spawn: any,
        ) => Promise<void>;

        const pending = launch({
            executablePath: 'C:/missing/Pi Code Desktop.exe',
            appPath: 'C:/Apps/resources/app.asar',
            defaultApp: false,
            inheritedEnvironment: {},
        }, spawn);
        child.emit('error', new Error('spawn failed'));

        await expect(pending).rejects.toThrow('spawn failed');
    });
});
