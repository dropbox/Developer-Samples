// Copies the renderer's HTML and images next to its bundled script.
import {cpSync, mkdirSync} from 'node:fs';

mkdirSync('dist/renderer', {recursive: true});
for (const name of ['index.html', 'assets']) {
  cpSync(`src/renderer/${name}`, `dist/renderer/${name}`, {recursive: true});
}
