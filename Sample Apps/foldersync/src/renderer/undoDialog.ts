// The Undo dialog: the project agent's changes in Dropbox, newest first. The
// user picks the oldest change to undo; it and every later change are undone.
import type {Change, ChangeGroup} from '../shared/types';
import {api, el, make, message} from './dom.js';
import styles from './styles.module.css';

const CHANGE_LABELS: Record<string, string> = {
  add: 'Added',
  edit: 'Edited',
  delete: 'Deleted',
  move: 'Moved',
  rename: 'Renamed',
  move_in: 'Moved in',
  move_out: 'Moved out',
  restore: 'Restored',
  restore_version: 'Restored',
  rollback: 'Undo',
};

const MAX_NAME = 36;
const MAX_FOLDER = 28;

function timeOf(us: number): string {
  return new Date(us / 1000).toLocaleString();
}

// Shortens a long name in the middle so the extension stays, like the
// Dropbox desktop app's sync errors.
function shortName(name: string): string {
  if (name.length <= MAX_NAME) {
    return name;
  }
  const front = Math.ceil((3 * MAX_NAME) / 4);
  return `${name.slice(0, front)}…${name.slice(name.length - (MAX_NAME - front - 1))}`;
}

// Shortens a long folder path from the left, keeping the folders nearest the file.
function shortFolder(folder: string): string {
  if (folder.length <= MAX_FOLDER) {
    return folder;
  }
  const parts = folder.split('/');
  let kept = shortName(parts.pop() ?? '');
  for (let part = parts.pop(); part !== undefined; part = parts.pop()) {
    if (kept.length + part.length + 3 > MAX_FOLDER) {
      break;
    }
    kept = `${part}/${kept}`;
  }
  return `…/${kept}`;
}

function splitPath(path: string): [string, string] {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? ['', path] : [path.slice(0, slash), path.slice(slash + 1)];
}

// One change on one line: name, folder in gray, action, and time.
function changeLine(change: Change, time: string): HTMLDivElement {
  const line = make('div', styles.change);
  const name = make('span');
  const [folder, base] = splitPath(change.path);
  let folderText = shortFolder(folder);
  if (change.op === 'rollback') {
    name.textContent =
      change.undidAfterUs === undefined
        ? 'Earlier changes'
        : `Changes after ${timeOf(change.undidAfterUs)}`;
  } else if (change.toPath) {
    const [toFolder, toBase] = splitPath(change.toPath);
    if (toFolder === folder) {
      name.textContent = `${shortName(base)} → ${shortName(toBase)}`;
    } else {
      name.textContent = shortName(base);
      folderText = `${folderText || '/'} → ${shortFolder(toFolder) || '/'}`;
    }
    line.title = `${change.path} → ${change.toPath}`;
  } else {
    name.textContent = shortName(base);
    line.title = change.path;
  }
  const cell = make('div', styles.changeWhat);
  cell.append(name, make('span', styles.changeFolder, folderText));
  line.append(
    cell,
    make('div', styles.changeOp, CHANGE_LABELS[change.op] ?? change.op),
    make('div', styles.changeTime, time)
  );
  return line;
}

// Undo rows show what an earlier undo did; they can't be chosen.
function isUndoRow(group: ChangeGroup): boolean {
  return group.changes.every((change) => change.op === 'rollback');
}

function countChanges(groups: ChangeGroup[]): number {
  return groups.reduce(
    (n, group) => n + group.changes.filter((change) => change.op !== 'rollback').length,
    0
  );
}

export class UndoDialog {
  private readonly dialog = el('undo-dialog', HTMLDialogElement);
  private readonly list = el('undo-list', HTMLUListElement);
  private readonly error = el('undo-error', HTMLParagraphElement);
  private readonly submit = el('undo-submit', HTMLButtonElement);
  private project: string | undefined;
  private groups: ChangeGroup[] = [];
  private choice: number | undefined;
  // Counts open() calls, so a response from an earlier one is dropped.
  private opens = 0;

  // onUndo runs the undo for the chosen change's timestamp.
  constructor(private readonly onUndo: (project: string, fromUs: number) => void) {
    el('undo-cancel', HTMLButtonElement).addEventListener('click', () => this.dialog.close());
    this.submit.addEventListener('click', () => {
      const group = this.choice === undefined ? undefined : this.groups[this.choice];
      if (this.project && group) {
        this.dialog.close();
        this.onUndo(this.project, group.timestampUs);
      }
    });
  }

  async open(project: string): Promise<void> {
    const open = ++this.opens;
    this.project = project;
    this.groups = [];
    this.choice = undefined;
    this.error.textContent = '';
    this.list.replaceChildren(make('li', styles.placeholder, 'Loading…'));
    this.updateSubmit();
    this.dialog.showModal();
    try {
      const groups = await api.projectChanges(project);
      if (open === this.opens) {
        this.groups = groups;
        this.render();
      }
    } catch (err) {
      if (open !== this.opens) {
        return;
      }
      this.list.replaceChildren();
      this.error.textContent = message(err);
    }
  }

  private choose(index: number): void {
    this.choice = index;
    this.render();
    const item = this.list.children.item(index);
    if (item instanceof HTMLElement) {
      item.focus();
    }
  }

  private render(): void {
    if (this.groups.length === 0) {
      this.list.replaceChildren(
        make(
          'li',
          styles.placeholder,
          'No changes yet. Changes FolderSync makes in Dropbox show up here.'
        )
      );
    } else {
      this.list.replaceChildren(...this.groups.map((group, i) => this.row(group, i)));
    }
    this.updateSubmit();
  }

  private row(group: ChangeGroup, i: number): HTMLLIElement {
    const li = make('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(this.choice !== undefined && i <= this.choice));
    li.dataset.undo = String(isUndoRow(group));
    const shown = group.changes.slice(0, 3);
    li.append(
      ...shown.map((change, j) => changeLine(change, j === 0 ? timeOf(group.timestampUs) : ''))
    );
    if (group.changes.length > shown.length) {
      li.append(make('div', styles.changeMore, `and ${group.changes.length - shown.length} more`));
    }
    if (!isUndoRow(group)) {
      li.tabIndex = 0;
      li.addEventListener('click', () => this.choose(i));
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.choose(i);
        }
      });
    }
    return li;
  }

  private updateSubmit(): void {
    const count =
      this.choice === undefined ? 0 : countChanges(this.groups.slice(0, this.choice + 1));
    this.submit.disabled = count === 0;
    this.submit.textContent =
      count === 0 ? 'Undo' : `Undo ${count} ${count === 1 ? 'change' : 'changes'}`;
  }
}
