import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Agent Skills cross-client locations, ordered from user to project scope. */
export function getStandardSkillPaths(cwd: string, homeDirectory = os.homedir()): string[] {
    return [
        path.join(homeDirectory, '.agents', 'skills'),
        path.join(cwd, '.agents', 'skills'),
    ].filter(isDirectory);
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}
