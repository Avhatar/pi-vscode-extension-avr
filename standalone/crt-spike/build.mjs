import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(root, 'src/host.ts')],
    outfile: resolve(dist, 'host.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, 'src/electron-main.ts')],
    outfile: resolve(dist, 'electron-main.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, 'renderer/app.ts')],
    outfile: resolve(dist, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
  }),
]);

const html = await readFile(resolve(root, 'renderer/index.html'), 'utf8');
await writeFile(
  resolve(dist, 'index.html'),
  html.replace('<script src="app.ts" type="module"></script>', '<script src="app.js"></script>'),
  'utf8',
);
await cp(resolve(root, 'renderer/styles.css'), resolve(dist, 'styles.css'));
await cp(resolve(root, 'renderer/assets'), resolve(dist, 'assets'), { recursive: true });

console.log(`CRT spike built at ${dist}`);
