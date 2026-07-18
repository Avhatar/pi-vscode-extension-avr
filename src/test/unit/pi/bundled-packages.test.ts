import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BUNDLED_PI_PACKAGES,
    getBundledPiPackagePaths,
} from '../../../pi/bundled-packages';

describe('bundled Pi package resolution', () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('resolves declared packages from the supplied application root', () => {
        const applicationRoot = mkdtempSync(join(tmpdir(), 'pi-code-bundled-'));
        roots.push(applicationRoot);
        const availablePackage = BUNDLED_PI_PACKAGES[1];
        const packageRoot = join(applicationRoot, 'node_modules', availablePackage);
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), '{}');
        const log = vi.fn();

        expect(getBundledPiPackagePaths(applicationRoot, log)).toEqual([packageRoot]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(BUNDLED_PI_PACKAGES[0]));
    });
});
