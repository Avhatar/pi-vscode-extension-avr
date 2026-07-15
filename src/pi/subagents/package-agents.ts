import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseAgentFile } from './registry';
import type { AgentDefinition, AgentDefinitionDiagnostic } from './types';

interface PackageManifest {
    name?: string;
    pi?: { agents?: string | string[] };
}

export interface PackageAgentIndex {
    definitions: AgentDefinition[];
    diagnostics: AgentDefinitionDiagnostic[];
}

/** Load only package-manifest-declared native agent files. No package code is
 * executed, and paths cannot escape the package root. */
export async function indexPackageAgents(packageRoots: readonly string[]): Promise<PackageAgentIndex> {
    const definitions: AgentDefinition[] = [];
    const diagnostics: AgentDefinitionDiagnostic[] = [];
    for (const packageRoot of packageRoots) {
        const manifestPath = path.join(packageRoot, 'package.json');
        let manifest: PackageManifest;
        try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PackageManifest; }
        catch (error) {
            diagnostics.push({
                code: 'invalid-package-manifest', severity: 'warning', source: 'package', filePath: manifestPath,
                message: `Could not read package agent manifest: ${(error as Error).message}`,
            });
            continue;
        }
        const packageName = typeof manifest.name === 'string' && manifest.name.trim()
            ? manifest.name.trim()
            : path.basename(packageRoot);
        const entries = typeof manifest.pi?.agents === 'string'
            ? [manifest.pi.agents]
            : Array.isArray(manifest.pi?.agents) ? manifest.pi!.agents! : [];
        for (const entry of entries) {
            if (typeof entry !== 'string' || !entry.trim()) continue;
            const candidate = path.resolve(packageRoot, entry);
            if (!isWithin(packageRoot, candidate)) {
                diagnostics.push({
                    code: 'invalid-package-manifest', severity: 'error', source: 'package',
                    filePath: candidate,
                    message: `Package ${packageName} agent path escapes package root: ${entry}`,
                });
                continue;
            }
            const files = await markdownFiles(candidate, packageName, diagnostics);
            for (const filePath of files) {
                const parsed = await parseAgentFile(filePath, 'package');
                diagnostics.push(...parsed.diagnostics);
                if (parsed.definition) definitions.push({
                    ...parsed.definition,
                    source: 'package', scope: 'package', packageName,
                });
            }
        }
    }
    return { definitions, diagnostics };
}

async function markdownFiles(
    candidate: string,
    packageName: string,
    diagnostics: AgentDefinitionDiagnostic[],
): Promise<string[]> {
    let stats;
    try { stats = await fs.lstat(candidate); }
    catch (error) {
        diagnostics.push({
            code: 'read-error', severity: 'warning', source: 'package', filePath: candidate,
            message: `Package ${packageName} agent source is unavailable: ${(error as Error).message}`,
        });
        return [];
    }
    if (stats.isSymbolicLink()) {
        diagnostics.push({
            code: 'unsafe-path', severity: 'warning', source: 'package', filePath: candidate,
            message: `Skipped symbolic-link package agent source from ${packageName}.`,
        });
        return [];
    }
    if (stats.isFile()) return candidate.toLowerCase().endsWith('.md') ? [candidate] : [];
    if (!stats.isDirectory()) return [];
    const files: string[] = [];
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        const child = path.join(candidate, entry.name);
        if (entry.isSymbolicLink()) {
            diagnostics.push({
                code: 'unsafe-path', severity: 'warning', source: 'package', filePath: child,
                message: `Skipped symbolic-link package agent source from ${packageName}.`,
            });
        } else if (entry.isDirectory()) files.push(...await markdownFiles(child, packageName, diagnostics));
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(child);
    }
    return files;
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
