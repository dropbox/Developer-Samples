// The Dropbox files panel: the open project's files as they are in Dropbox,
// with each file's status on this computer. Folders load when opened.
import {projectKey} from '../engine/paths';
import type {FileAction, FileStatus, RemoteEntry} from '../shared/types';
import {api, el, formatSize, icon, make, message, relativeTime} from './dom.js';
import styles from './styles.module.css';

const STATUS_LABELS: Record<FileStatus, string> = {
  synced: 'Synced',
  'dropbox-newer': 'Changed in Dropbox',
  'local-newer': 'Changed on this computer',
  'deleted-here': 'Deleted on this computer',
  'both-changed': 'Changed on both sides',
  'not-on-computer': 'Not on this computer yet',
  'not-synced': 'Not synced yet',
};

function placeholder(text: string, depth: number): HTMLLIElement {
  const li = make('li', styles.placeholder, text);
  li.style.paddingLeft = `${8 + depth * 18}px`;
  return li;
}

export class FilesPanel {
  private readonly toggleButton = el('files-toggle', HTMLButtonElement);
  private readonly refreshButton = el('files-refresh', HTMLButtonElement);
  private readonly body = el('files-body', HTMLDivElement);
  private readonly note = el('files-note', HTMLParagraphElement);
  private readonly tree = el('files-tree', HTMLUListElement);
  // Dropbox paths of the folders that are open.
  private readonly expanded = new Set<string>();
  // The latest load of each list, by list.
  private readonly loads = new WeakMap<HTMLUListElement, number>();

  // current returns the open project, so late responses for another one are
  // dropped. onDeleted runs after a file is deleted from Dropbox here.
  constructor(
    private readonly current: () => string | undefined,
    private readonly onDeleted: (project: string) => void
  ) {
    this.toggleButton.addEventListener('click', () =>
      this.setOpen(this.toggleButton.getAttribute('aria-expanded') !== 'true')
    );
    this.refreshButton.addEventListener('click', () => {
      this.note.textContent = '';
      this.load();
    });
  }

  // Clears the panel for a newly opened project and loads it.
  reset(): void {
    this.note.textContent = '';
    this.tree.replaceChildren();
    this.load();
  }

  load(): void {
    const project = this.current();
    if (project && !this.body.hidden) {
      void this.loadFolder(project, `/${project}`, this.tree, 0, 'No files yet.');
    }
  }

  private setOpen(open: boolean): void {
    this.toggleButton.setAttribute('aria-expanded', String(open));
    this.body.hidden = !open;
    this.load();
  }

  private async loadFolder(
    project: string,
    folder: string,
    list: HTMLUListElement,
    depth: number,
    emptyText: string
  ): Promise<void> {
    // Each load of a list gets a number, so an older, slower response is dropped.
    const load = (this.loads.get(list) ?? 0) + 1;
    this.loads.set(list, load);
    const stale = (): boolean => !this.isOpen(project) || this.loads.get(list) !== load;
    if (list.childElementCount === 0) {
      list.replaceChildren(placeholder('Loading…', depth));
    }
    try {
      const entries = await api.remoteList(project, folder);
      if (stale()) {
        return;
      }
      list.replaceChildren(
        ...(entries.length > 0
          ? entries.map((entry) => this.item(project, entry, depth))
          : [placeholder(emptyText, depth)])
      );
    } catch (err) {
      if (!stale()) {
        list.replaceChildren(placeholder(message(err), depth));
      }
    }
  }

  private item(project: string, entry: RemoteEntry, depth: number): HTMLLIElement {
    const li = make('li');
    const row = make('div', styles.row);
    row.setAttribute('role', 'treeitem');
    row.tabIndex = 0;
    row.dataset.kind = entry.kind;
    row.title = entry.path;
    const name = make('div', styles.rowName);
    name.style.paddingLeft = `${depth * 18}px`;
    const twisty = make('span', styles.twisty);
    if (entry.kind === 'folder') {
      twisty.append(icon('chevron-down'));
    }
    name.append(twisty, icon(entry.kind), make('span', undefined, entry.name));
    const status = make('div', styles.rowStatus, entry.status ? STATUS_LABELS[entry.status] : '');
    if (entry.status) {
      status.dataset.status = entry.status;
    }
    row.append(
      name,
      make('div', styles.rowSize, entry.size === undefined ? '' : formatSize(entry.size)),
      make('div', styles.rowTime, entry.modified ? relativeTime(entry.modified) : ''),
      status
    );
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      api
        .fileMenu(entry)
        .then(async (action) => {
          if (action) {
            await this.run(project, entry, action);
          }
        })
        .catch((err: unknown) => {
          if (this.isOpen(project)) {
            this.note.textContent = message(err);
          }
        });
    });
    li.append(row);

    if (entry.kind === 'file') {
      row.addEventListener('dblclick', () => void this.run(project, entry, 'open'));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          void this.run(project, entry, 'open');
        }
      });
      return li;
    }
    const children = make('ul');
    children.setAttribute('role', 'group');
    li.append(children);
    const setOpen = (open: boolean): void => {
      row.setAttribute('aria-expanded', String(open));
      children.hidden = !open;
      if (open) {
        this.expanded.add(entry.path);
        void this.loadFolder(project, entry.path, children, depth + 1, 'Empty folder');
      } else {
        this.expanded.delete(entry.path);
      }
    };
    const toggle = (): void => setOpen(row.getAttribute('aria-expanded') !== 'true');
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    setOpen(this.expanded.has(entry.path));
    return li;
  }

  // Runs a right-click menu action and shows any error in the panel. Results
  // that arrive after another project is opened are dropped.
  private async run(project: string, entry: RemoteEntry, action: FileAction): Promise<void> {
    const stillOpen = (): boolean => this.isOpen(project);
    if (!stillOpen()) {
      return;
    }
    this.note.textContent = '';
    try {
      switch (action) {
        case 'open':
          if (entry.status !== 'synced') {
            this.note.textContent = `Downloading “${entry.name}”…`;
          }
          await api.openFile(project, entry);
          if (stillOpen()) {
            this.note.textContent = '';
          }
          break;
        case 'reveal':
          await api.revealFile(project, entry.path);
          break;
        case 'delete':
          await this.deleteFromDropbox(project, entry, stillOpen);
          break;
      }
    } catch (err) {
      if (stillOpen()) {
        this.note.textContent = message(err);
      }
    }
  }

  private async deleteFromDropbox(
    project: string,
    entry: RemoteEntry,
    stillOpen: () => boolean
  ): Promise<void> {
    const ok = window.confirm(
      `Delete “${entry.name}” from Dropbox? The next Sync now also deletes it from this computer.`
    );
    if (!ok || !entry.rev) {
      return;
    }
    await api.deleteFile(project, entry.path, entry.rev);
    this.onDeleted(project);
    if (stillOpen()) {
      this.note.textContent = `Deleted “${entry.name}” from Dropbox.`;
      this.load();
    }
  }

  private isOpen(project: string): boolean {
    const open = this.current();
    return open !== undefined && projectKey(open) === projectKey(project);
  }
}
