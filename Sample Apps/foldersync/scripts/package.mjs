// Builds the zip, out/FolderSync-mac-arm64.zip, with FolderSync.app,
// tokenserver, start.sh, and README.md in a FolderSync folder, so Finder and
// unzip both extract to one folder. Runs on macOS only.
import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {packager} from '@electron/packager';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const tokenServer = join(out, 'tokenserver');
const zipPath = join(out, 'FolderSync-mac-arm64.zip');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, {stdio: ['ignore', 'ignore', 'inherit'], ...opts});
}

if (!existsSync(tokenServer)) {
  throw new Error('out/tokenserver is missing. Build it first with npm run build:tokenserver.');
}
const kind = execFileSync('file', ['-b', tokenServer], {encoding: 'utf8'}).trim();
if (!kind.includes('Mach-O 64-bit executable arm64')) {
  throw new Error(`out/tokenserver isn’t a macOS arm64 binary: ${kind}`);
}

// The app icon, from build/icon.png.
const iconset = join(out, 'FolderSync.iconset');
rmSync(iconset, {recursive: true, force: true});
mkdirSync(iconset, {recursive: true});
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = String(size * scale);
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
    run('sips', ['-z', px, px, join(root, 'build', 'icon.png'), '--out', join(iconset, name)]);
  }
}
const icon = join(out, 'FolderSync.icns');
run('iconutil', ['-c', 'icns', iconset, '-o', icon]);
rmSync(iconset, {recursive: true});

console.log('Building…');
execFileSync('npm', ['run', 'build'], {cwd: root, stdio: 'inherit'});

console.log('Packaging FolderSync.app…');
const [appDir] = await packager({
  dir: root,
  out: join(out, 'packager'),
  overwrite: true,
  platform: 'darwin',
  arch: 'arm64',
  name: 'FolderSync',
  appBundleId: 'com.example.foldersync',
  appCategoryType: 'public.app-category.productivity',
  icon,
  asar: true,
  prune: true,
  // The app needs only dist/, build/icon.png, and package.json. It has no
  // runtime dependencies, so node_modules stays out too.
  ignore: [
    /^\/(src|test|scripts|package|out|node_modules|README\.md|tsconfig.*\.json|vitest\.config\.mts|\.gitignore)(\/|$)/,
    /^\/build\/icon\.svg$/,
  ],
});

// The packager changes Electron's bundle but keeps its old ad-hoc signature,
// so sign the whole bundle again (still ad-hoc, no developer ID) and check it.
const app = join(appDir, 'FolderSync.app');
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);

console.log('Zipping…');
const staging = join(out, 'zip');
const folder = join(staging, 'FolderSync');
rmSync(staging, {recursive: true, force: true});
mkdirSync(folder, {recursive: true});
// ditto keeps the app's symlinks and permissions.
run('ditto', [app, join(folder, 'FolderSync.app')]);
copyFileSync(tokenServer, join(folder, 'tokenserver'));
copyFileSync(join(root, 'package', 'start.sh'), join(folder, 'start.sh'));
copyFileSync(join(root, 'README.md'), join(folder, 'README.md'));
chmodSync(join(folder, 'tokenserver'), 0o755);
chmodSync(join(folder, 'start.sh'), 0o755);
rmSync(zipPath, {force: true});
run('zip', ['-qry', zipPath, 'FolderSync'], {cwd: staging});
rmSync(staging, {recursive: true});
console.log(`Wrote ${zipPath}`);
