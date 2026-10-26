// The projects sidebar and the open project: Sync now, Undo, the project menu,
// and creating and deleting projects.
import {projectKey} from '../engine/paths';
import type {Activity, SyncStatus, SyncSummary} from '../shared/types';
import {api, el, icon, make, message} from './dom.js';
import styles from './styles.module.css';
import {FilesPanel} from './filesPanel.js';
import {StatusCard} from './statusCard.js';
import {UndoDialog} from './undoDialog.js';

type ProjectState = 'none' | 'ok' | 'syncing' | 'error';

export class ProjectsView {
  private readonly list = el('projects', HTMLUListElement);
  private readonly listError = el('projects-error', HTMLParagraphElement);
  private readonly empty = el('empty', HTMLElement);
  private readonly emptyTitle = el('empty-title', HTMLHeadingElement);
  private readonly emptyText = el('empty-text', HTMLParagraphElement);
  private readonly view = el('project', HTMLElement);
  private readonly name = el('project-name', HTMLHeadingElement);
  private readonly dir = el('project-dir', HTMLSpanElement);
  private readonly syncButton = el('sync-now', HTMLButtonElement);
  private readonly undoButton = el('undo', HTMLButtonElement);
  private readonly deleteDialog = el('delete-project-dialog', HTMLDialogElement);
  private readonly deleteName = el('delete-project-name', HTMLElement);
  private readonly deleteConfirm = el('delete-project-confirm', HTMLInputElement);
  private readonly deleteError = el('delete-project-error', HTMLParagraphElement);
  private readonly deleteSubmit = el('delete-project-submit', HTMLButtonElement);

  private readonly status = new StatusCard();
  private readonly files = new FilesPanel(
    () => this.current,
    (project) => this.changedInDropbox(project)
  );
  private readonly undo = new UndoDialog((project, fromUs) => void this.runUndo(project, fromUs));

  // The open project, if any.
  private current: string | undefined;
  private projects: string[] = [];
  // Counts load() calls, so a list that arrives after a newer load or a
  // sign-out is dropped.
  private loads = 0;
  // Maps keyed by project are keyed by projectKey(name).
  private readonly states = new Map<string, ProjectState>();
  private readonly summaries = new Map<string, SyncSummary>();
  // The error of each project whose last sync or undo failed, shown again when
  // it's reopened.
  private readonly errors = new Map<string, string>();
  // The latest step of each project that's syncing, shown again when it's reopened.
  private readonly syncing = new Map<string, SyncStatus>();
  // Counts openings of the delete dialog, so a late result from an earlier
  // opening leaves the current one alone.
  private deleteOpens = 0;
  // True while a project delete runs. It can't be canceled, so the dialog stays open.
  private deleting = false;

  constructor() {
    el('refresh-projects', HTMLButtonElement).addEventListener('click', () => void this.load());
    this.syncButton.addEventListener('click', () => {
      if (this.current) {
        void this.sync(this.current, false);
      }
    });
    this.undoButton.addEventListener('click', () => {
      if (this.current) {
        void this.openUndo(this.current);
      }
    });
    el('reveal-folder', HTMLButtonElement).addEventListener('click', () => {
      const project = this.current;
      if (project) {
        api.revealFolder(project).catch((err: unknown) => {
          if (this.isCurrent(project)) {
            this.status.set('error', 'Couldn’t open the folder', message(err));
          }
        });
      }
    });
    el('choose-folder', HTMLButtonElement).addEventListener('click', () => {
      const project = this.current;
      if (project) {
        api.chooseFolder(project).then(
          (info) => {
            if (!info) {
              return;
            }
            // The new folder hasn't been synced, so nothing about the old one applies.
            this.forget(project);
            if (this.isCurrent(project)) {
              this.dir.textContent = info.localDir;
              this.status.showNotSynced();
              this.files.reset();
            }
          },
          (err: unknown) => {
            if (this.isCurrent(project)) {
              this.status.set('error', 'Couldn’t change the folder', message(err));
            }
          }
        );
      }
    });
    this.onCreate(
      el('new-project', HTMLFormElement),
      el('new-project-name', HTMLInputElement),
      (text) => {
        this.listError.textContent = text;
      }
    );
    this.onCreate(
      el('empty-create', HTMLFormElement),
      el('empty-create-name', HTMLInputElement),
      (text) => {
        el('empty-error', HTMLParagraphElement).textContent = text;
      }
    );
    this.deleteConfirm.addEventListener('input', () => {
      this.deleteSubmit.disabled =
        this.deleting || this.deleteConfirm.value.trim() !== this.deleteName.textContent;
    });
    el('delete-project-cancel', HTMLButtonElement).addEventListener('click', () =>
      this.deleteDialog.close()
    );
    this.deleteDialog.addEventListener('cancel', (event) => {
      if (this.deleting) {
        event.preventDefault();
      }
    });
    this.deleteSubmit.addEventListener(
      'click',
      () => void this.deleteProject(this.deleteName.textContent)
    );
    setInterval(() => this.status.renderActivity(), 30_000);
  }

  // Status and activity from the main process, for any project.
  onSyncStatus(project: string, status: SyncStatus): void {
    if (status.kind === 'syncing') {
      this.syncing.set(projectKey(project), status);
    } else {
      this.syncing.delete(projectKey(project));
    }
    if (status.kind === 'error') {
      this.errors.set(projectKey(project), status.message);
      this.setState(project, 'error');
    } else if (status.kind === 'idle') {
      this.errors.delete(projectKey(project));
      // A pass stopped before deleting files synced nothing, so it replaces no
      // summary: the project isn't up to date.
      if (status.last?.massDelete) {
        this.summaries.delete(projectKey(project));
      } else if (status.last) {
        this.summaries.set(projectKey(project), status.last);
      } else {
        // An undo finished: Dropbox changed, so the last summary is out of date.
        this.summaries.delete(projectKey(project));
        if (this.states.get(projectKey(project)) === 'error') {
          // It finished after the app stopped waiting for it.
          this.setState(project, 'none');
        }
      }
    }
    if (this.isCurrent(project)) {
      this.status.showStatus(status);
    }
  }

  onActivity(project: string, activity: Activity): void {
    if (this.isCurrent(project)) {
      this.status.addActivity(activity);
    }
  }

  // Loads the project list. Closes the open project if it's no longer in Dropbox.
  async load(): Promise<void> {
    const load = ++this.loads;
    this.listError.textContent = '';
    let projects: string[];
    try {
      projects = await api.listProjects();
    } catch (err) {
      if (load === this.loads) {
        this.listError.textContent = message(err);
      }
      return;
    }
    if (load !== this.loads) {
      return;
    }
    this.projects = projects;
    if (this.current) {
      // A project renamed only in case is still the open project.
      const listed = this.listed(this.current);
      if (listed) {
        this.current = listed;
      } else {
        this.close();
      }
    }
    this.render();
    this.showEmptyState();
  }

  // Forgets everything about the signed-in user's projects, for signing out.
  reset(): void {
    this.loads++;
    this.close();
    this.projects = [];
    this.states.clear();
    this.summaries.clear();
    this.errors.clear();
    this.syncing.clear();
    this.render();
  }

  private render(): void {
    this.list.replaceChildren(...this.projects.map((name) => this.item(name)));
  }

  private item(name: string): HTMLLIElement {
    const button = make('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(this.isCurrent(name)));
    const dot = make('span', styles.dot);
    dot.dataset.state = this.states.get(projectKey(name)) ?? 'none';
    button.append(icon('folder'), make('span', styles.name, name), dot);
    button.addEventListener('click', () => void this.open(name));
    const more = make('button', styles.projectMore);
    more.type = 'button';
    more.title = 'More';
    more.setAttribute('aria-label', `More actions for ${name}`);
    more.append(icon('more'));
    more.addEventListener('click', () => void this.showMenu(name));
    const li = make('li');
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void this.showMenu(name);
    });
    li.append(button, more);
    return li;
  }

  // The main area when no project is open: create the first project, or pick one.
  private showEmptyState(): void {
    if (this.projects.length === 0) {
      this.emptyTitle.textContent = 'Create your first project';
      this.emptyText.textContent =
        'A project is a folder in this account’s Dropbox. FolderSync keeps it in sync with a folder on this computer.';
    } else {
      this.emptyTitle.textContent = 'Pick a project';
      this.emptyText.textContent = 'Choose a project on the left, or create a new one.';
    }
  }

  private async open(name: string): Promise<void> {
    // Hide the open project first, so its buttons can't act on the next one
    // while it loads.
    this.view.hidden = true;
    this.empty.hidden = false;
    this.current = name;
    this.render();
    try {
      const info = await api.openProject(name);
      if (!this.isCurrent(name)) {
        return;
      }
      this.name.textContent = info.name;
      this.dir.textContent = info.localDir;
      this.empty.hidden = true;
      this.view.hidden = false;
      const live = this.syncing.get(projectKey(name));
      const error = this.errors.get(projectKey(name));
      const last = this.summaries.get(projectKey(name));
      if (live) {
        this.status.showStatus(live);
      } else if (error) {
        this.status.showStatus({kind: 'error', message: error});
      } else if (last) {
        this.status.showSummary(last);
      } else {
        this.status.showNotSynced();
      }
      this.files.reset();
      this.status.setActivity([]);
      const activity = await api.recentActivity(name);
      if (this.isCurrent(name)) {
        this.status.setActivity(activity);
      }
    } catch (err) {
      if (this.isCurrent(name)) {
        this.listError.textContent = message(err);
      }
    }
  }

  private close(): void {
    this.current = undefined;
    this.view.hidden = true;
    this.empty.hidden = false;
  }

  private setState(name: string, state: ProjectState): void {
    this.states.set(projectKey(name), state);
    this.render();
  }

  // Runs a sync pass for the project. Returns true if it finished.
  private async sync(project: string, allowMassDelete: boolean): Promise<boolean> {
    this.syncButton.disabled = true;
    this.setState(project, 'syncing');
    try {
      const summary = await api.syncNow(project, allowMassDelete);
      if (summary.massDelete && !allowMassDelete) {
        // Only ask about the project on screen, so the answer can't apply to another one.
        const ok =
          this.isCurrent(project) &&
          window.confirm(
            `This sync would delete ${summary.massDelete.count} of ${summary.massDelete.total} items in “${project}”. Delete them?`
          );
        if (ok) {
          return await this.sync(project, true);
        }
        if (this.isCurrent(project)) {
          this.status.set('attention', 'Stopped before deleting files', 'Nothing was changed.');
        }
        // Not synced: the sidebar shows no dot, not the up-to-date one.
        this.setState(project, 'none');
        return false;
      }
      this.setState(project, summary.issues.length > 0 ? 'error' : 'ok');
      if (this.isCurrent(project)) {
        this.files.load();
      }
      return true;
    } catch (err) {
      this.setState(project, 'error');
      if (this.isCurrent(project)) {
        this.status.set('error', 'Couldn’t sync', message(err));
      }
      return false;
    } finally {
      this.syncButton.disabled = false;
    }
  }

  // Syncs first, so local edits are uploaded and listed, then opens the dialog.
  private async openUndo(project: string): Promise<void> {
    if ((await this.sync(project, false)) && this.isCurrent(project)) {
      await this.undo.open(project);
    }
  }

  private async runUndo(project: string, fromUs: number): Promise<void> {
    this.undoButton.disabled = true;
    this.syncButton.disabled = true;
    this.setState(project, 'syncing');
    try {
      await api.undoChanges(project, fromUs);
      await this.sync(project, false);
    } catch (err) {
      this.setState(project, 'error');
      if (this.isCurrent(project)) {
        this.status.set('error', 'Couldn’t undo', message(err));
      }
    } finally {
      this.undoButton.disabled = false;
      this.syncButton.disabled = false;
    }
  }

  private async showMenu(name: string): Promise<void> {
    this.listError.textContent = '';
    try {
      switch (await api.projectMenu(name)) {
        case 'reveal':
          await api.revealFolder(name);
          break;
        case 'remove': {
          const {localDir} = await api.openProject(name);
          const ok = window.confirm(
            `Stop syncing “${name}” on this Mac? Its files stay in Dropbox and in ${localDir}.`
          );
          if (ok) {
            await api.removeProject(name);
            this.forget(name);
            if (this.isCurrent(name)) {
              await this.open(name);
            }
          }
          break;
        }
        case 'delete':
          this.deleteOpens++;
          this.deleteName.textContent = name;
          this.deleteConfirm.value = '';
          this.deleteError.textContent = '';
          this.deleteSubmit.disabled = true;
          this.deleteDialog.showModal();
          this.deleteConfirm.focus();
          break;
        case undefined:
          break;
      }
    } catch (err) {
      this.listError.textContent = message(err);
    }
  }

  private async deleteProject(name: string): Promise<void> {
    const opening = this.deleteOpens;
    const sameDialog = (): boolean => opening === this.deleteOpens;
    const cancel = el('delete-project-cancel', HTMLButtonElement);
    this.deleteSubmit.disabled = true;
    this.deleteError.textContent = '';
    this.deleting = true;
    cancel.disabled = true;
    try {
      await api.deleteProject(name);
      if (sameDialog()) {
        this.deleteDialog.close();
      }
      // Gone from Dropbox, so it leaves the list even if the refresh fails.
      this.projects = this.projects.filter((p) => projectKey(p) !== projectKey(name));
      if (this.isCurrent(name)) {
        this.close();
      }
      this.forget(name);
      this.showEmptyState();
      await this.load();
    } catch (err) {
      // The Dropbox folder may be gone even if cleanup on this computer failed.
      await this.load();
      if (this.listed(name) && sameDialog() && this.deleteDialog.open) {
        this.deleteError.textContent = message(err);
        // The name may have been changed while the delete ran.
        this.deleteSubmit.disabled =
          this.deleteConfirm.value.trim() !== this.deleteName.textContent;
        return;
      }
      if (sameDialog()) {
        this.deleteDialog.close();
      }
      if (!this.listed(name)) {
        this.forget(name);
      }
      this.listError.textContent = message(err);
    } finally {
      this.deleting = false;
      cancel.disabled = false;
    }
  }

  private isCurrent(project: string): boolean {
    return this.current !== undefined && projectKey(project) === projectKey(this.current);
  }

  // The listed spelling of the project, if it's in the list.
  private listed(project: string): string | undefined {
    return this.projects.find((p) => projectKey(p) === projectKey(project));
  }

  // A file was deleted from Dropbox in the files panel, so the next sync has
  // work to do here.
  private changedInDropbox(project: string): void {
    this.summaries.delete(projectKey(project));
    if (this.states.get(projectKey(project)) === 'ok') {
      this.setState(project, 'none');
    }
    if (this.isCurrent(project)) {
      this.status.set('attention', 'Changed in Dropbox', 'Press Sync now to update this computer.');
    }
  }

  // Clears what the window remembers about a project that stopped syncing here.
  private forget(name: string): void {
    this.states.delete(projectKey(name));
    this.summaries.delete(projectKey(name));
    this.errors.delete(projectKey(name));
    this.syncing.delete(projectKey(name));
    this.render();
  }

  private onCreate(
    form: HTMLFormElement,
    input: HTMLInputElement,
    showError: (text: string) => void
  ): void {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      showError('');
      api
        .createProject(name)
        .then(async () => {
          input.value = '';
          await this.load();
          await this.open(name);
        })
        .catch((err: unknown) => showError(message(err)));
    });
  }
}
