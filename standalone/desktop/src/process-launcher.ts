import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface DesktopProcessLaunchOptions {
    readonly executablePath: string;
    readonly appPath: string;
    readonly portableExecutablePath?: string;
    readonly defaultApp: boolean;
    readonly inheritedEnvironment: NodeJS.ProcessEnv;
}

export interface DesktopProcessLaunchSpec {
    readonly command: string;
    readonly args: string[];
    readonly environment: NodeJS.ProcessEnv;
}

export type DesktopSpawn = (
    command: string,
    args: readonly string[],
    options: {
        readonly detached: true;
        readonly env: NodeJS.ProcessEnv;
        readonly stdio: 'ignore';
        readonly windowsHide: false;
    },
) => Pick<ChildProcess, 'unref' | 'once'>;

export function createDesktopProcessLaunchSpec(
    options: DesktopProcessLaunchOptions,
): DesktopProcessLaunchSpec {
    const environment = { ...options.inheritedEnvironment };
    delete environment.ELECTRON_RUN_AS_NODE;
    return {
        command: options.portableExecutablePath || options.executablePath,
        args: options.defaultApp ? [options.appPath] : [],
        environment,
    };
}

export function launchDesktopProcess(
    options: DesktopProcessLaunchOptions,
    spawn: DesktopSpawn = nodeSpawn,
): Promise<void> {
    const spec = createDesktopProcessLaunchSpec(options);
    return new Promise<void>((resolveLaunch, rejectLaunch) => {
        const child = spawn(spec.command, spec.args, {
            detached: true,
            env: spec.environment,
            stdio: 'ignore',
            windowsHide: false,
        });
        child.once('error', rejectLaunch);
        child.once('spawn', resolveLaunch);
        child.unref();
    });
}
