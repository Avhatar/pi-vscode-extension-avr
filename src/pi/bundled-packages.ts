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

const EXTENSION_ROOT = path.resolve(__dirname, '..');

/**
 * Resolve absolute paths to bundled Pi-package directories. Each path is
 * passed to `DefaultResourceLoader.additionalExtensionPaths`; Pi's package
 * manager treats it as a local pi-package and auto-discovers `pi.extensions`
 * and `pi.skills` from the package's own `package.json` manifest.
 *
 * Missing packages are skipped silently (defensive against a stale install
 * tree during development) and reported via the optional logger.
 */
export function getBundledPiPackagePaths(log?: (msg: string) => void): string[] {
    const resolved: string[] = [];
    for (const name of BUNDLED_PI_PACKAGES) {
        const pkgRoot = path.join(EXTENSION_ROOT, 'node_modules', name);
        const pkgJsonPath = path.join(pkgRoot, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            log?.(`Bundled Pi package missing on disk, skipping: ${name} (expected at ${pkgRoot})`);
            continue;
        }
        resolved.push(pkgRoot);
    }
    return resolved;
}
