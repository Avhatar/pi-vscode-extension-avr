import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getStandardSkillPaths } from '../../../pi/standard-resources';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('cross-client agent resources', () => {
    it('discovers existing user and project .agents/skills directories in scope order', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-standard-resources-'));
        temporaryDirectories.push(root);
        const home = path.join(root, 'home');
        const cwd = path.join(root, 'workspace');
        const userSkills = path.join(home, '.agents', 'skills');
        const projectSkills = path.join(cwd, '.agents', 'skills');
        fs.mkdirSync(userSkills, { recursive: true });
        fs.mkdirSync(projectSkills, { recursive: true });

        expect(getStandardSkillPaths(cwd, home)).toEqual([userSkills, projectSkills]);
    });

    it('omits missing paths and non-directory entries', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-standard-resources-'));
        temporaryDirectories.push(root);
        const home = path.join(root, 'home');
        const cwd = path.join(root, 'workspace');
        const projectSkills = path.join(cwd, '.agents', 'skills');
        fs.mkdirSync(path.dirname(projectSkills), { recursive: true });
        fs.writeFileSync(projectSkills, 'not a directory', 'utf8');

        expect(getStandardSkillPaths(cwd, home)).toEqual([]);
    });
});
