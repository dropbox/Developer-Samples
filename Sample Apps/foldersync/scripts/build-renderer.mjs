// Bundles the window's script with esbuild. styles.module.css is a CSS module:
// esbuild gives its classes unique names and writes them to renderer.css.
import {rmSync} from 'node:fs';

import {build} from 'esbuild';

// Drop output from earlier builds, so only this bundle ships.
rmSync('dist/renderer', {recursive: true, force: true});

await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2023',
  outdir: 'dist/renderer',
  sourcemap: true,
  loader: {'.module.css': 'local-css'},
  logLevel: 'warning',
});
