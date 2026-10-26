// Copies the renderer's HTML, CSS, and images next to its compiled script.
import {cpSync, mkdirSync} from 'node:fs';

mkdirSync('dist/renderer', {recursive: true});
for (const name of ['index.html', 'styles.css', 'assets']) {
  cpSync(`src/renderer/${name}`, `dist/renderer/${name}`, {recursive: true});
}
