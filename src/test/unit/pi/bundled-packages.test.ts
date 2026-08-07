import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BUNDLED_PI_PACKAGES,
    filterBundledPackageSkills,
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

    it('hides only denylisted skills that physically live inside a bundled package', () => {
        const skills = [
            // The bundled pi-web-access `librarian` skill is hidden.
            { name: 'librarian', filePath: join('app', 'node_modules', 'pi-web-access', 'skills', 'librarian', 'SKILL.md') },
            // A different bundled skill is not denylisted, so it survives.
            { name: 'other', filePath: join('app', 'node_modules', 'pi-web-access', 'skills', 'other', 'SKILL.md') },
            // A same-named project skill is not inside a bundled package, so it survives.
            { name: 'librarian', filePath: join('app', '.agents', 'skills', 'librarian', 'SKILL.md') },
            // A project skill is untouched.
            { name: 'build-deploy', filePath: join('app', '.agents', 'skills', 'build-deploy', 'SKILL.md') },
        ];

        const kept = filterBundledPackageSkills(skills);

        expect(kept).toEqual([skills[1], skills[2], skills[3]]);
    });

    it('matches bundled package directories on both path separators', () => {
        const backslash = 'C:\\app\\node_modules\\pi-web-access\\skills\\librarian\\SKILL.md';
        const forward = 'C:/app/node_modules/pi-web-access/skills/librarian/SKILL.md';

        expect(filterBundledPackageSkills([{ name: 'librarian', filePath: backslash }])).toEqual([]);
        expect(filterBundledPackageSkills([{ name: 'librarian', filePath: forward }])).toEqual([]);
    });

    it('does not hide skills outside node_modules even when a segment resembles a package name', () => {
        const skill = { name: 'librarian', filePath: join('app', 'node_modules', 'pi-web-access-notes', 'skills', 'librarian', 'SKILL.md') };

        expect(filterBundledPackageSkills([skill])).toEqual([skill]);
    });
});
