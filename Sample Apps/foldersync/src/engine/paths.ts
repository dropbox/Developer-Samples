// Path keys and the names that never sync.

// The app's own folder inside each project. Never scanned, uploaded, or watched.
export const STATE_DIR = '.foldersync';

// Names the Dropbox server rejects with disallowed_name, compared lowercase.
const IGNORED_NAMES = new Set([
  '.dropbox',
  '.dropbox.attr',
  '.ds_store',
  'desktop.ini',
  'icon\r',
  'thumbs.db',
]);

const MAX_NAME_LENGTH = 255;

// Returns the key used to compare Dropbox paths: NFC, lowercase.
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

// Reports whether a file name is never synced.
export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    IGNORED_NAMES.has(lower) ||
    lower.startsWith('~$') ||
    lower.startsWith('.~') ||
    lower.startsWith('.dbtmp-') ||
    // AppleDouble files, where macOS keeps extended attributes on volumes
    // without them, such as exFAT: ._name next to name.
    lower.startsWith('._') ||
    (lower.startsWith('~') && lower.endsWith('.tmp'))
  );
}

// Returns why the server would reject a name, or undefined if it's fine.
export function invalidNameReason(name: string): string | undefined {
  if (name.endsWith(' ')) {
    return 'The name ends with a space.';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return 'The name is longer than 255 characters.';
  }
  if (name.includes('\\') || name.includes('\0')) {
    return 'The name contains a backslash or a NUL character.';
  }
  return undefined;
}

// Joins a Dropbox folder path and a child name.
export function joinDropbox(parent: string, name: string): string {
  return parent === '' || parent === '/' ? `/${name}` : `${parent}/${name}`;
}

// Returns the parent of a Dropbox path, or '' for a top-level item.
export function parentDropbox(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

// Returns the last component of a Dropbox path.
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// Whether a path key or one of its parent folders is in the set.
export function isUnder(key: string, keys: Set<string>): boolean {
  if (keys.size === 0) {
    return false;
  }
  for (let k = key; k; k = k.slice(0, Math.max(k.lastIndexOf('/'), 0))) {
    if (keys.has(k)) {
      return true;
    }
  }
  return false;
}
