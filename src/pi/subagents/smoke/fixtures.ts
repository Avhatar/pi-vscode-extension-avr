import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RegistrySmokeFixture {
    root: string;
    cwd: string;
    userAgentsDirectory: string;
    projectAgentsDirectory: string;
    cleanup(): Promise<void>;
}

export async function createRegistrySmokeFixture(): Promise<RegistrySmokeFixture> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-smoke-'));
    const cwd = path.join(root, 'workspace');
    const userAgentsDirectory = path.join(root, 'home', '.pi', 'agent', 'agents');
    const projectAgentsDirectory = path.join(cwd, '.pi', 'agents');

    try {
        await writeAgent(path.join(userAgentsDirectory, 'research.md'), [
        '---',
        'name: research',
        'description: User research agent',
        'model: deepseek/deepseek-reasoner',
        'tools: [read, grep, bash]',
        'maxTurns: 80',
        '---',
        'Collect evidence and return concise findings.',
    ]);
    await writeAgent(path.join(userAgentsDirectory, 'reviewer.md'), [
        '---',
        'name: reviewer',
        'description: User reviewer',
        'model: openai/gpt-parent',
        'tools: [read, grep]',
        '---',
        'Review from the user scope.',
    ]);
    await writeAgent(path.join(projectAgentsDirectory, 'reviewer.md'), [
        '---',
        'name: reviewer',
        'description: Project reviewer',
        'model: anthropic/claude-review',
        'tools: [read, grep]',
        'disallowedTools: [bash]',
        '---',
        'Review from the trusted project scope.',
    ]);
    await writeAgent(path.join(projectAgentsDirectory, 'duplicates', 'one.md'), [
        '---',
        'name: duplicate',
        'description: First duplicate',
        '---',
        'First.',
    ]);
    await writeAgent(path.join(projectAgentsDirectory, 'duplicates', 'two.md'), [
        '---',
        'name: DUPLICATE',
        'description: Second duplicate',
        '---',
        'Second.',
    ]);
    await writeAgent(path.join(projectAgentsDirectory, 'malformed.md'), [
        '---',
        'name: malformed',
        'description: Invalid because an unknown field is present',
        'unknownCapability: true',
        '---',
        'This file must be rejected.',
    ]);

        return {
            root,
            cwd,
            userAgentsDirectory,
            projectAgentsDirectory,
            cleanup: () => fs.promises.rm(root, { recursive: true, force: true }),
        };
    } catch (error) {
        await fs.promises.rm(root, { recursive: true, force: true });
        throw error;
    }
}

async function writeAgent(filePath: string, lines: string[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}
