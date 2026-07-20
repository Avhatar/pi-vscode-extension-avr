import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = resolve(packageRoot, 'dist', 'main.js');
const main = await readFile(mainPath, 'utf8');
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const failures = [];

if (main.includes('Dynamic require of "')) {
    failures.push('main.js contains esbuild dynamic-require shims that fail in Electron ESM');
}
if (/\/\/ .*node_modules\//.test(main)) {
    failures.push('main.js bundles CommonJS dependencies instead of loading packaged production dependencies');
}
if (main.includes('requestSingleInstanceLock')) {
    failures.push('main.js still redirects independent launches through Electron single-instance locking');
}

const coordinatedPiPackages = [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
];
for (const packageName of coordinatedPiPackages) {
    const declaredVersion = packageJson.dependencies?.[packageName];
    if (typeof declaredVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(declaredVersion)) {
        failures.push(`${packageName} must be declared as an exact coordinated SDK version`);
    }
}

const codingAgent = await import('@earendil-works/pi-coding-agent');
const requiredSdkFactories = [
    ['AuthStorage.create', codingAgent.AuthStorage?.create],
    ['ModelRegistry.create', codingAgent.ModelRegistry?.create],
    ['SessionManager.create', codingAgent.SessionManager?.create],
    ['SettingsManager.create', codingAgent.SettingsManager?.create],
    ['DefaultResourceLoader', codingAgent.DefaultResourceLoader],
    ['createAgentSession', codingAgent.createAgentSession],
    ['getAgentDir', codingAgent.getAgentDir],
];
for (const [name, value] of requiredSdkFactories) {
    if (typeof value !== 'function') failures.push(`packaged Pi SDK is missing ${name}`);
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`Desktop bundle verification failed: ${failure}`);
    process.exitCode = 1;
} else {
    console.log('Desktop bundle verified: production dependencies remain external to the ESM main bundle.');
}
