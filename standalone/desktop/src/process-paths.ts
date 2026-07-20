import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface DesktopProcessPaths {
    readonly sharedDataRoot: string;
    readonly processRoot: string;
    readonly sessionDataRoot: string;
}

const PROCESS_IDENTITY_RE = /^[A-Za-z0-9._-]+$/;

export function resolveDesktopProcessPaths(
    sharedDataRoot: string,
    processIdentity: string,
): DesktopProcessPaths {
    if (!sharedDataRoot.trim()) {
        throw new Error('sharedDataRoot must not be blank.');
    }
    if (!PROCESS_IDENTITY_RE.test(processIdentity)) {
        throw new Error('Desktop process identity contains unsupported characters.');
    }
    const absoluteSharedDataRoot = resolve(sharedDataRoot);
    const processRoot = join(absoluteSharedDataRoot, 'processes', processIdentity);
    return {
        sharedDataRoot: absoluteSharedDataRoot,
        processRoot,
        sessionDataRoot: join(processRoot, 'session-data'),
    };
}

export async function cleanupDesktopProcessPaths(
    paths: DesktopProcessPaths,
): Promise<void> {
    await rm(paths.processRoot, { recursive: true, force: true });
}
