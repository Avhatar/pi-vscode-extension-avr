const { execFileSync, execSync } = require('node:child_process');

const executionOptions = {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
};
const output = process.platform === 'win32'
    ? execSync('npx.cmd @vscode/vsce ls', executionOptions)
    : execFileSync('npx', ['@vscode/vsce', 'ls'], executionOptions);

const forbiddenPrefixes = ['standalone/'];
const packagedFiles = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const violations = packagedFiles.filter((file) =>
    forbiddenPrefixes.some((prefix) => file.replaceAll('\\', '/').startsWith(prefix))
);

if (violations.length > 0) {
    console.error('Standalone client files would be included in the VSIX:');
    for (const file of violations) console.error(`- ${file}`);
    process.exit(1);
}

console.log('VSIX boundary verified: standalone/** is excluded.');
