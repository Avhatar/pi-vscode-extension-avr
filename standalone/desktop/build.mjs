import { build } from 'esbuild';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

// renderer/assets is a private git submodule (unlicensed third-party IP).
// Fail early with an actionable message so contributors without access do not see a raw ENOENT.
try {
  await access(resolve(root, 'renderer/assets/VT323-Regular.ttf'));
} catch {
  console.error(
    'standalone renderer assets are missing.\n' +
    'This directory is a git submodule pointing at a private repository.\n' +
    'Run:  git submodule update --init standalone/desktop/renderer/assets\n' +
    '(requires access to https://github.com/Avhatar/pi-code-standalone-assets)',
  );
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(root, 'src/main.ts')],
    outfile: resolve(dist, 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    external: [
      'electron',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      'pi-mcp-adapter',
      'pi-web-access',
    ],
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, 'src/preload.ts')],
    outfile: resolve(dist, 'preload.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, 'renderer/app.ts')],
    outfile: resolve(dist, 'renderer.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
  }),
]);

const html = await readFile(resolve(root, 'renderer/index.html'), 'utf8');
await writeFile(resolve(dist, 'index.html'), html, 'utf8');
await writeFile(
  resolve(dist, 'styles.css'),
  await readFile(resolve(root, 'renderer/styles.css'), 'utf8'),
  'utf8',
);
await cp(resolve(root, 'renderer/assets'), resolve(dist, 'assets'), {
  recursive: true,
});

console.log(`Pi Code desktop renderer built at ${dist}`);
