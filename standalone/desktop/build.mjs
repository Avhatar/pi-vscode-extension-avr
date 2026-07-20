import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

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

console.log(`Pi Code desktop transport shell built at ${dist}`);
