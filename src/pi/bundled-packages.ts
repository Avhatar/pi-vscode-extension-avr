import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pi extensions (npm packages tagged `pi-package`) that ship inside the VSIX.
 * Each entry must also be a production dependency in package.json so it
 * survives `npm prune --omit=dev` before packaging.
 *
 * See AGENTS.md ("Bundled Pi extensions") for the rationale and procedure.
 */
export const BUNDLED_PI_PACKAGES: readonly string[] = [
    'pi-web-access',
    'pi-mcp-adapter',
];

/**
 * Resolve absolute paths to bundled Pi-package directories. Each path is
 * passed to `DefaultResourceLoader.additionalExtensionPaths`; Pi's package
 * manager treats it as a local pi-package and auto-discovers `pi.extensions`
 * and `pi.skills` from the package's own `package.json` manifest.
 *
 * Missing packages are skipped silently (defensive against a stale install
 * tree during development) and reported via the optional logger.
 */
/**
 * Skills bundled inside third-party Pi packages that the project hides from
 * agents. pi-web-access ships a `librarian` research skill alongside its web
 * tools; the tools are a core feature, the skill is not requested by this
 * project, so it is excluded at the resource-loader boundary via
 * `DefaultResourceLoader.skillsOverride` while the package's extension tools
 * keep loading.
 *
 * Exclusions apply only to skills physically located inside one of the
 * bundled package directories — a same-named skill in `.agents/skills` or
 * `~/.pi/agent/skills` is never hidden.
 */
export const HIDDEN_BUNDLED_PACKAGE_SKILLS: ReadonlySet<string> = new Set(['librarian']);

function isInsideBundledPackage(filePath: string): boolean {
    const segments = filePath.split(/[\\/]/);
    const index = segments.indexOf('node_modules');
    return index !== -1 && index + 1 < segments.length && BUNDLED_PI_PACKAGES.includes(segments[index + 1]);
}

/**
 * Filter a loaded skill set down to the skills the project wants surfaced.
 * Used as `DefaultResourceLoader.skillsOverride`, which the SDK applies to
 * the full merged skill set (project, user, and bundled-package sources).
 */
export function filterBundledPackageSkills<T extends { name: string; filePath: string }>(
    skills: readonly T[],
): T[] {
    return skills.filter((skill) => {
        if (!HIDDEN_BUNDLED_PACKAGE_SKILLS.has(skill.name)) {
            return true;
        }
        return !isInsideBundledPackage(skill.filePath);
    });
}

export function getBundledPiPackagePaths(extensionRoot: string, log?: (msg: string) => void): string[] {
    const resolved: string[] = [];
    for (const name of BUNDLED_PI_PACKAGES) {
        const pkgRoot = path.join(extensionRoot, 'node_modules', name);
        const pkgJsonPath = path.join(pkgRoot, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            log?.(`Bundled Pi package missing on disk, skipping: ${name} (expected at ${pkgRoot})`);
            continue;
        }
        resolved.push(pkgRoot);
    }
    return resolved;
}
