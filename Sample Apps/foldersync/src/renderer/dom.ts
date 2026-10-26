// Small helpers the window's modules share: the preload API, elements, icons,
// and formatting.
import type {FoldersyncApi} from '../shared/types';
import styles from './styles.module.css';

// Every method preload.ts exposes. The type makes the compiler check the list
// is complete.
const API_METHODS: Record<keyof FoldersyncApi, true> = {
  getSetup: true,
  signIn: true,
  signOut: true,
  deleteAccount: true,
  tokenServerStatus: true,
  getTokenState: true,
  listProjects: true,
  createProject: true,
  openProject: true,
  chooseFolder: true,
  revealFolder: true,
  projectMenu: true,
  removeProject: true,
  deleteProject: true,
  recentActivity: true,
  remoteList: true,
  fileMenu: true,
  openFile: true,
  revealFile: true,
  deleteFile: true,
  projectChanges: true,
  undoChanges: true,
  syncNow: true,
  onTokenState: true,
  onSyncStatus: true,
  onActivity: true,
};

function isFoldersyncApi(value: unknown): value is FoldersyncApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(API_METHODS).every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

// Reads the API preload.ts puts on window.
function preloadApi(): FoldersyncApi {
  const value: unknown = Reflect.get(window, 'foldersync');
  if (!isFoldersyncApi(value)) {
    throw new Error('FolderSync’s preload script didn’t load.');
  }
  return value;
}

// The API preload.ts exposes. Every call goes to the main process over IPC.
export const api = preloadApi();

// Stroke icons, 24x24.
const ICONS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8 M21 3v5h-5',
  folder:
    'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
  upload: 'M12 19V5 M5 12l7-7 7 7',
  download: 'M12 5v14 M19 12l-7 7-7-7',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  alert:
    'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  plus: 'M12 5v14 M5 12h14',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  sync: 'M3 12a9 9 0 0 1 15.4-6.4L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.4 6.4L3 16 M3 21v-5h5',
  dot: 'M12 12h.01',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  undo: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  file: 'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z M14 3v5h5',
  'chevron-down': 'M6 9l6 6 6-6',
};

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', styles.icon);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.dot ?? '');
  svg.append(path);
  return svg;
}

// Gives each element in the page with data-css="a b" the stylesheet's class
// names for a and b. The names are unique to the bundle, so the page can't
// use them directly.
export function applyCss(): void {
  for (const node of document.querySelectorAll('[data-css]')) {
    for (const name of (node.getAttribute('data-css') ?? '').split(' ').filter(Boolean)) {
      const className = (styles as Record<string, string | undefined>)[name];
      if (!className) {
        throw new Error(
          `index.html uses the class ${name}, which styles.module.css doesn't define.`
        );
      }
      node.classList.add(className);
    }
  }
}

// Replaces each <span data-icon="name"> placeholder in the page with its icon.
export function fillIcons(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    slot.replaceWith(icon(slot.dataset.icon ?? 'dot'));
  }
}

// Gets an element by ID and checks its type.
export function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) {
    throw new Error(`Missing element #${id}`);
  }
  return node;
}

export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// The message of an error from an IPC call, without Electron's prefix.
export function message(err: unknown): string {
  return err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(err);
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  return new Date(iso).toLocaleDateString();
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatSize(bytes: number): string {
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < SIZE_UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  const value = unit === 0 || n >= 10 ? String(Math.round(n)) : n.toFixed(1);
  return `${value} ${SIZE_UNITS[unit] ?? ''}`;
}
