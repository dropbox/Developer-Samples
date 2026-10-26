// Projects: top-level folders in the managed user's Dropbox, each synced with
// a local folder. Sync, undo, and removing or deleting a project.
import {realpathSync} from 'node:fs';
import {mkdir, rm, rmdir} from 'node:fs/promises';
import {basename, dirname, join, resolve, sep} from 'node:path';

import {groupChanges, listChanges, startUndo, undoStatus, type UndoStatus} from '../engine/agents';
import {ensureRealFolder, refuseLinks} from '../engine/localScan';
import {STATE_DIR, pathKey} from '../engine/paths';
import {STATE_DB_FILES, openStateStore} from '../engine/stateStore';
import {runSyncPass} from '../engine/syncPass';
import type {Activity, ChangeGroup, ProjectInfo, SyncStatus, SyncSummary} from '../shared/types';
import type {Settings} from './config';
import type {ProjectClients, UserApi} from './projectClients';

const MAX_ACTIVITY = 50;
const UNDO_FAILED = 'Dropbox couldn’t finish the undo. Some changes may be undone; check the list.';
const UNDO_POLL_MS = 1500;
// The longest wait between undo status checks, after errors.
const UNDO_MAX_POLL_MS = 30 * 1000;
// Failed undo status checks in a row before the error is shown.
const UNDO_FAILURES_SHOWN = 5;
// How long undo() waits before returning; the undo keeps running in Dropbox
// and is checked in the background until it finishes.
const UNDO_WAIT_MS = 10 * 60 * 1000;

export interface ProjectsOptions {
  settings: Settings;
  clients: ProjectClients;
  userApi: () => UserApi;
  // The signed-in user's ID, so a folder synced with another account isn't used.
  accountId: () => string;
  onStatus: (project: string, status: SyncStatus) => void;
  onActivity: (project: string, activity: Activity) => void;
  sleep?: (ms: number) => Promise<void>;
}

const ACCOUNT_CHANGING = 'Wait for the account change to finish, then try again.';

export class Projects {
  // Maps keyed by project are keyed by pathKey(name): Dropbox names ignore case,
  // so Foo and foo are the same project.
  // Projects with a pass running, so only one pass runs per project.
  private readonly running = new Map<string, Promise<SyncSummary>>();
  // Projects with an undo or delete running, by what's running. Sync and the
  // other actions wait until it finishes.
  private readonly busy = new Map<
    string,
    'undo' | 'delete' | 'remove' | 'folder change' | 'file delete' | 'project creation'
  >();
  // The project names from the last list(), to check folders against.
  private known = new Set<string>();
  // True while signing in, signing out, or deleting the account.
  private accountChanging = false;
  // The most recent activity per project, newest first.
  private readonly activityLog = new Map<string, Activity[]>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ProjectsOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // The project folders in the user's Dropbox, by name.
  async list(): Promise<string[]> {
    const api = this.opts.userApi();
    let res = await api.listFolder('', false);
    const names = folderNames(res.entries);
    while (res.hasMore) {
      res = await api.listFolderContinue(res.cursor);
      names.push(...folderNames(res.entries));
    }
    this.known = new Set(names);
    return names.sort((a, b) => a.localeCompare(b));
  }

  async create(name: string): Promise<void> {
    this.requireOwnFolder(name);
    await this.exclusive(name, 'project creation', () =>
      this.opts.userApi().createFolder(`/${name}`)
    );
    this.known.add(name);
  }

  // One folder per project: two projects in one folder would share and delete
  // each other's sync state. Checks dir, or the project's current folder.
  private requireOwnFolder(name: string, dir = this.info(name).localDir): void {
    const others = new Map<string, string>();
    for (const other of [...this.opts.settings.chosenProjects(), ...this.known]) {
      others.set(pathKey(other), other);
    }
    others.delete(pathKey(name));
    for (const other of others.values()) {
      const theirs = this.info(other).localDir;
      if (overlaps(dir, theirs)) {
        throw new Error(
          `The folder ${dir} overlaps “${other}”’s folder, ${theirs}. Give each project a folder of its own.`
        );
      }
    }
  }

  info(name: string): ProjectInfo {
    return this.opts.settings.project(name);
  }

  // Changes the project's local folder. If it can't be saved, the old one stays.
  async setLocalDir(name: string, dir: string): Promise<ProjectInfo> {
    this.requireIdle(name);
    // A project being removed has already given up its folder setting, but
    // its sync state is still being deleted.
    this.requireAllIdle();
    this.requireOwnFolder(name, dir);
    this.busy.set(pathKey(name), 'folder change');
    const settings = this.opts.settings;
    const previous = settings.chosenLocalDir(name);
    settings.setLocalDir(name, dir);
    try {
      await settings.save();
    } catch (err) {
      if (previous === undefined) {
        settings.forgetProject(name);
      } else {
        settings.setLocalDir(name, previous);
      }
      throw err;
    } finally {
      this.busy.delete(pathKey(name));
    }
    return this.info(name);
  }

  activity(name: string): Activity[] {
    return this.activityLog.get(pathKey(name)) ?? [];
  }

  // Runs one sync pass. A second call while a pass runs gets the same pass.
  async sync(name: string, allowMassDelete: boolean): Promise<SyncSummary> {
    const existing = this.running.get(pathKey(name));
    if (existing) {
      return existing;
    }
    if (this.accountChanging) {
      throw new Error(ACCOUNT_CHANGING);
    }
    const busy = this.busy.get(pathKey(name));
    if (busy) {
      throw new Error(`Wait for the ${busy} to finish, then try again.`);
    }
    this.requireOwnFolder(name);
    const pass = this.runPass(name, allowMassDelete);
    this.running.set(pathKey(name), pass);
    try {
      return await pass;
    } finally {
      this.running.delete(pathKey(name));
    }
  }

  // Stops syncing the project on this computer. Its files stay here and in Dropbox.
  async remove(name: string): Promise<void> {
    this.requireIdle(name);
    this.requireOwnFolder(name);
    this.busy.set(pathKey(name), 'remove');
    try {
      await this.forget(name);
    } finally {
      this.busy.delete(pathKey(name));
    }
  }

  // Deletes the project folder from Dropbox with the agent's token, so Dropbox
  // records it as the agent's change and agents/restore_writes can bring it
  // back. The local files stay.
  async delete(name: string): Promise<void> {
    this.requireIdle(name);
    this.requireOwnFolder(name);
    this.busy.set(pathKey(name), 'delete');
    try {
      const api = await this.opts.clients.agentClient(name);
      await api.deleteV2(`/${name}`);
      await this.forget(name);
    } finally {
      this.busy.delete(pathKey(name));
    }
  }

  // The project agent's changes, newest first, grouped by second.
  async changes(name: string): Promise<ChangeGroup[]> {
    const {agentId} = await this.opts.clients.agent(name);
    return groupChanges(await listChanges(this.opts.userApi(), agentId, `/${name}`));
  }

  // Undoes the project agent's changes at fromUs and later, and waits for
  // Dropbox to finish. If Dropbox is still restoring after UNDO_WAIT_MS, this
  // throws, and sync stays blocked until a background check sees it finish.
  async undo(name: string, fromUs: number): Promise<void> {
    this.requireIdle(name);
    this.busy.set(pathKey(name), 'undo');
    let stillRunning = false;
    try {
      this.opts.onStatus(name, {kind: 'syncing', step: 'Undoing changes in Dropbox…'});
      const api = this.opts.userApi();
      const {agentId} = await this.opts.clients.agent(name);
      // Dropbox undoes writes after the given time, so this includes the chosen second.
      const cursor = await startUndo(api, agentId, fromUs - 1);
      const done = this.waitForUndo(name, api, cursor);
      const timeout = this.sleep(UNDO_WAIT_MS).then((): 'waiting' => 'waiting');
      const result = await Promise.race([done, timeout]);
      if (result === 'waiting') {
        stillRunning = true;
        void done.then((state) => this.finishUndo(name, state));
        throw new Error('The undo is still running in Dropbox. Sync is paused until it finishes.');
      }
      if (result === 'failed') {
        throw new Error(UNDO_FAILED);
      }
      this.opts.onStatus(name, {kind: 'idle', message: 'The undo finished in Dropbox.'});
    } catch (err) {
      this.opts.onStatus(name, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (!stillRunning) {
        this.busy.delete(pathKey(name));
      }
    }
  }

  // Unblocks a project when an undo checked in the background finishes.
  private finishUndo(name: string, state: 'complete' | 'failed'): void {
    this.busy.delete(pathKey(name));
    this.opts.onStatus(
      name,
      state === 'complete'
        ? {kind: 'idle', message: 'The undo finished in Dropbox. Press Sync now to get the result.'}
        : {kind: 'error', message: UNDO_FAILED}
    );
  }

  private async runPass(name: string, allowMassDelete: boolean): Promise<SyncSummary> {
    const {localDir} = this.info(name);
    // Never open the database through a link, which could point outside.
    await mkdir(localDir, {recursive: true});
    await refuseLinks(localDir);
    await ensureRealFolder(join(localDir, STATE_DIR));
    const store = await openStateStore(join(localDir, STATE_DIR));
    try {
      const summary = await runSyncPass({
        api: await this.opts.clients.syncFiles(name),
        store,
        localRoot: localDir,
        dropboxRoot: `/${name}`,
        accountId: this.opts.accountId(),
        allowMassDelete,
        onStep: (step) => this.opts.onStatus(name, {kind: 'syncing', step}),
        onActivity: (activity) => this.recordActivity(name, activity),
      });
      this.opts.onStatus(name, {kind: 'idle', last: summary});
      return summary;
    } catch (err) {
      this.opts.onStatus(name, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      store.close();
    }
  }

  // Polls an undo until Dropbox reports it complete or failed. Errors while
  // polling, like a dropped connection, are retried with backoff: the undo is
  // still running in Dropbox, so sync can't resume until its result is known.
  // After several failed checks in a row, the error is shown.
  private async waitForUndo(
    name: string,
    api: UserApi,
    cursor: string
  ): Promise<Exclude<UndoStatus, 'running'>> {
    let delay = UNDO_POLL_MS;
    let failures = 0;
    for (;;) {
      await this.sleep(delay);
      try {
        const state = await undoStatus(api, cursor);
        if (state !== 'running') {
          return state;
        }
        if (failures >= UNDO_FAILURES_SHOWN) {
          this.opts.onStatus(name, {kind: 'syncing', step: 'Undoing changes in Dropbox…'});
        }
        failures = 0;
        delay = UNDO_POLL_MS;
      } catch (err) {
        failures++;
        if (failures === UNDO_FAILURES_SHOWN) {
          const reason = err instanceof Error ? err.message : String(err);
          this.opts.onStatus(name, {
            kind: 'error',
            message: `Can’t check the undo: ${reason}. Sync stays paused until Dropbox says it finished.`,
          });
        }
        delay = Math.min(delay * 2, UNDO_MAX_POLL_MS);
      }
    }
  }

  // Forgets recent activity, for example when the user signs out.
  clearActivity(): void {
    this.activityLog.clear();
  }

  // Runs an account change (sign-in, sign-out, or account deletion) with every
  // project action refused until it ends.
  async duringAccountChange<T>(change: () => Promise<T>): Promise<T> {
    if (this.accountChanging) {
      throw new Error(ACCOUNT_CHANGING);
    }
    this.requireAllIdle();
    this.accountChanging = true;
    try {
      return await change();
    } finally {
      this.accountChanging = false;
    }
  }

  // Runs action with the project marked busy, so no sync, undo, or other
  // project action runs at the same time.
  async exclusive<T>(
    name: string,
    what: 'file delete' | 'project creation',
    action: () => Promise<T>
  ): Promise<T> {
    this.requireIdle(name);
    this.busy.set(pathKey(name), what);
    try {
      return await action();
    } finally {
      this.busy.delete(pathKey(name));
    }
  }

  // Throws if any project has a sync, undo, or delete running, so it doesn't
  // finish under another account.
  requireAllIdle(): void {
    const [name] = [...this.running.keys(), ...this.busy.keys()];
    if (name !== undefined) {
      const what = this.busy.get(pathKey(name)) ?? 'sync';
      throw new Error(`Wait for the ${what} in “${name}” to finish, then try again.`);
    }
  }

  private requireIdle(name: string): void {
    if (this.accountChanging) {
      throw new Error(ACCOUNT_CHANGING);
    }
    if (this.running.has(pathKey(name)) || this.busy.has(pathKey(name))) {
      throw new Error('Wait for the sync to finish, then try again.');
    }
  }

  private recordActivity(name: string, activity: Activity): void {
    this.activityLog.set(pathKey(name), [activity, ...this.activity(name)].slice(0, MAX_ACTIVITY));
    this.opts.onActivity(name, activity);
  }

  // Forgets the project on this computer: its folder setting, sync state, and
  // agent session. Its files stay, and so do the copies in old_files.
  private async forget(name: string): Promise<void> {
    const {localDir} = this.info(name);
    const stateDir = join(localDir, STATE_DIR);
    // Never delete through a link, which could point outside the project.
    await refuseLinks(localDir, stateDir);
    // Settings first: if they can't be saved, the sync state is still there.
    const settings = this.opts.settings;
    const chosen = settings.chosenLocalDir(name);
    settings.forgetProject(name);
    try {
      await settings.save();
    } catch (err) {
      if (chosen !== undefined) {
        settings.setLocalDir(name, chosen);
      }
      throw err;
    }
    this.activityLog.delete(pathKey(name));
    this.opts.clients.forget(name);
    try {
      for (const file of STATE_DB_FILES) {
        await rm(join(stateDir, file), {force: true});
      }
      await rm(join(stateDir, 'new_files'), {recursive: true, force: true});
      for (const dir of [join(stateDir, 'old_files'), stateDir]) {
        await removeIfEmpty(dir);
      }
    } catch (err) {
      throw new Error(
        `The project was removed, but its sync state in ${stateDir} couldn’t be deleted: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function folderNames(entries: {tag: string; pathDisplay: string}[]): string[] {
  return entries.filter((e) => e.tag === 'folder').map((e) => e.pathDisplay.slice(1));
}

// Removes a folder if it's empty. A missing or non-empty folder is fine.
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw err;
    }
  }
}

// Whether two folders are the same or one is inside the other. macOS folder
// names ignore case and Unicode normalization.
function overlaps(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const full = realFolderPath(p);
    return process.platform === 'darwin' ? full.normalize('NFC').toLowerCase() : full;
  };
  // resolve() keeps the separator at the end of a root like /.
  const under = (p: string, dir: string): boolean =>
    p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
  const [x, y] = [norm(a), norm(b)];
  return x === y || under(x, y) || under(y, x);
}

// The folder's path with links in its existing part resolved, so a folder
// reached through a linked parent compares equal to itself.
function realFolderPath(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
    }
    const parent = dirname(head);
    if (parent === head) {
      return resolve(path);
    }
    rest.unshift(basename(head));
    head = parent;
  }
}
