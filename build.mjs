import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron', '@lydell/node-pty'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer.ts'],
    outfile: 'dist/renderer.js',
    platform: 'browser',
    format: 'iife',
  }),
]);

copyFileSync('src/index.html', 'dist/index.html');
