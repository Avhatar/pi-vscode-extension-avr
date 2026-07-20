import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [packageRoot, ...process.argv.slice(2)], {
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
});
child.once('error', (error) => {
    console.error(`Failed to launch Electron: ${error.message}`);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
});
