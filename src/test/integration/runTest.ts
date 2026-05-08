import * as childProcess from 'child_process';
import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    await runVSCodeCli(cliPath, [
        ...cliArgs,
        '--disable-extensions',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
        `--extensionTestsPath=${extensionTestsPath}`,
    ]);
}

function runVSCodeCli(cliPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = process.platform === 'win32' && cliPath.endsWith('.cmd')
            ? childProcess.spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cliPath, ...args], { stdio: 'inherit' })
            : childProcess.spawn(cliPath, args, { stdio: 'inherit' });

        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(signal ? `VS Code test run terminated with ${signal}` : `VS Code test run failed with code ${code}`));
        });
    });
}

main().catch((err) => {
    console.error('Failed to run tests:', err);
    process.exit(1);
});
