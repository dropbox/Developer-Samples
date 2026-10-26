// One two-way sync pass for a project: compares local, remote, and the state
// saved at the last sync, then uploads, downloads, and deletes.
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink,
  utimes,
} from 'node:fs/promises';
import {basename, dirname, join, relative, sep} from 'node:path';

import type {Activity, ActivityKind, Issue, SyncSummary} from '../shared/types';
import {hashFile} from './contentHash';
import {
  ApiError,
  isConflict,
  isNotFound,
  type DropboxFiles,
  type FileMeta,
  type Metadata,
  type WriteMode,
} from './dropboxApi';
import {ensureRealFolder, sameStat, scanLocal, statOrUndefined, type LocalItem} from './localScan';
import {STATE_DIR, baseName, isIgnoredName, isUnder, joinDropbox, pathKey} from './paths';
import type {LocalStat, Row, StateStore} from './stateStore';

const MASS_DELETE_MIN_FILES = 20;
const CHANGED_DURING_DOWNLOAD =
  'The file changed while it was being downloaded. It will be synced again.';
// Saved rows are planned like Dropbox entries, so check them the same way:
// inside the project, and keyed by their own path. A damaged or edited state
// database could otherwise point a delete at another project.
function requireRowsInProject(rows: Map<string, Row>, dropboxRoot: string): void {
  const root = pathKey(dropboxRoot);
  for (const [key, row] of rows) {
    const parts = row.pathDisplay.slice(dropboxRoot.length).split('/').filter(Boolean);
    const inside =
      pathKey(row.pathDisplay).startsWith(`${root}/`) &&
      parts.length > 0 &&
      !parts.some((p) => p === '.' || p === '..');
    if (!inside || key !== pathKey(row.pathDisplay) || row.pathLower !== key) {
      throw new Error(
        `The sync state lists ${row.pathDisplay}, which isn’t in this project. Remove the project from this Mac, then sync it again.`
      );
    }
  }
}

async function isRealFolder(path: string): Promise<boolean> {
  const st = await lstat(path);
  return st.isDirectory() && !st.isSymbolicLink();
}

// Errors from link() on a volume without hard links.
const NO_HARD_LINKS = ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV'];
const DELETES = new Set<Action['type']>([
  'deleteRemote',
  'deleteLocal',
  'keepRemoteFolder',
  'deleteLocalFolder',
]);
const CHANGED_AFTER_SCAN = 'The file changed after the scan. It will be synced again.';
// A backup's name is a timestamp, a UUID, and the end of the original name.
// Bytes, not characters: Linux limits a name to 255 bytes, macOS to 255 characters.
const BACKUP_NAME_BYTES = 150;
const OLD_FILES_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const OLD_FILES_MAX_BYTES = 10 * 1024 * 1024 * 1024;

export interface PassOptions {
  api: DropboxFiles;
  store: StateStore;
  localRoot: string;
  // The project's Dropbox path, for example '/storyboard'.
  dropboxRoot: string;
  // The signed-in user's ID. A folder synced with another account is refused.
  accountId: string;
  allowMassDelete?: boolean;
  // List the project from scratch instead of continuing from the cursor.
  fullListing?: boolean;
  onStep?: (step: string) => void;
  // Called after each file is transferred, deleted, or saved as a conflict.
  onActivity?: (activity: Activity) => void;
  now?: () => Date;
}

type RemoteItem =
  | {kind: 'file'; pathDisplay: string; id: string; rev: string; contentHash: string}
  | {kind: 'folder'; pathDisplay: string; id: string};

type Action =
  | {type: 'upload'; key: string; local: LocalItem; mode: WriteMode; hash: string}
  | {
      type: 'download';
      key: string;
      remotePath: string;
      expect: LocalStat | undefined;
      localPath?: string;
    }
  | {type: 'record'; key: string; local: LocalItem; remote: RemoteItem}
  | {type: 'renameLocal'; key: string; local: LocalItem; remote: RemoteItem}
  | {type: 'deleteRemote'; key: string; row: Row}
  | {type: 'deleteLocal'; key: string; local: LocalItem}
  | {type: 'dropRow'; key: string}
  | {type: 'createRemoteFolder'; key: string; local: LocalItem}
  | {type: 'createLocalFolder'; key: string; remote: RemoteItem}
  | {type: 'keepRemoteFolder'; key: string; row: Row}
  | {type: 'deleteLocalFolder'; key: string; local: LocalItem};

const REMOTE_WRITES = new Set<Action['type']>(['upload', 'deleteRemote', 'createRemoteFolder']);

export async function runSyncPass(opts: PassOptions): Promise<SyncSummary> {
  return new SyncPass(opts).run();
}

class SyncPass {
  private readonly summary: SyncSummary;
  private readonly stateDir: string;
  private readonly newFilesDir: string;
  private readonly oldFilesDir: string;
  // Local versions that couldn't be put back. Never purged.
  private readonly keptDir: string;
  // The project folder's inode, recorded at the start of the pass.
  private rootInode: string | undefined;
  // The state folders' inodes, recorded at the start of the pass.
  private readonly stateInodes = new Map<string, string>();
  // Local folders renamed this pass, old path to new, so later actions use
  // the new path.
  private readonly renamed = new Map<string, string>();
  // The project folder with symlinks resolved, recorded with rootInode.
  private realRoot: string | undefined;
  private readonly now: () => Date;
  private errors = 0;
  // Paths left out of this pass's plan; see plan().
  private blockedPaths = 0;
  // Problems found this pass, by path key. Each pass reports its own.
  private readonly issues = new Map<string, Issue>();

  constructor(private readonly opts: PassOptions) {
    this.now = opts.now ?? (() => new Date());
    this.summary = {
      uploaded: 0,
      downloaded: 0,
      deletedRemote: 0,
      deletedLocal: 0,
      conflicts: 0,
      issues: [],
      finishedAt: '',
    };
    this.stateDir = join(opts.localRoot, STATE_DIR);
    this.newFilesDir = join(this.stateDir, 'new_files');
    this.oldFilesDir = join(this.stateDir, 'old_files');
    this.keptDir = join(this.stateDir, 'kept');
  }

  async run(): Promise<SyncSummary> {
    const {store} = this.opts;
    const rows = store.rows();
    requireRowsInProject(rows, this.opts.dropboxRoot);
    requireSameAccount(store, this.opts.accountId, this.opts.localRoot);
    const root = await lstat(this.opts.localRoot, {bigint: true}).catch((err: unknown) => {
      if (isErrnoCode(err, 'ENOENT')) {
        return undefined;
      }
      throw err;
    });
    if (rows.size > 0 && !root) {
      // Treating every row as a local delete would empty the project in Dropbox.
      throw new Error(
        `The project folder ${this.opts.localRoot} is missing. Reconnect the drive or choose the folder again.`
      );
    }
    if (root && (root.isSymbolicLink() || !root.isDirectory())) {
      throw new Error(
        `The project folder ${this.opts.localRoot} is a link or a file, so FolderSync won’t sync it.`
      );
    }
    for (const dir of [this.stateDir, this.newFilesDir, this.oldFilesDir, this.keptDir]) {
      await ensureRealFolder(dir);
    }
    // Record the project and state folders, so a swap during the pass is
    // caught before anything is written through them.
    const rootNow = await lstat(this.opts.localRoot, {bigint: true});
    if (root && rootNow.ino !== root.ino) {
      throw new Error(
        `The project folder ${this.opts.localRoot} was replaced while the sync started. Sync again.`
      );
    }
    this.rootInode = String(rootNow.ino);
    for (const dir of [this.stateDir, this.newFilesDir, this.oldFilesDir, this.keptDir]) {
      this.stateInodes.set(dir, String((await lstat(dir, {bigint: true})).ino));
    }
    this.realRoot = await realpath(this.opts.localRoot);
    await this.clearNewFiles();
    await this.purgeOldFiles();

    this.step('Listing Dropbox');
    const {remote, cursor} = await this.listRemote(rows);
    this.step('Scanning the folder');
    const {items: local, skipped} = await scanLocal(this.opts.localRoot, this.opts.dropboxRoot);
    for (const s of skipped) {
      this.issue(pathKey(s.dropboxPath), s.dropboxPath, s.reason);
    }

    this.step('Comparing');
    const actions = await this.plan(
      local,
      remote,
      rows,
      skipped.map((s) => pathKey(s.dropboxPath))
    );
    const deletes = actions.filter((a) => DELETES.has(a.type)).length;
    if (!this.opts.allowMassDelete && deletes >= MASS_DELETE_MIN_FILES && deletes * 2 > rows.size) {
      return this.finish({count: deletes, total: rows.size});
    }

    const order = (a: Action): number => {
      switch (a.type) {
        case 'createRemoteFolder':
        case 'createLocalFolder':
          return 0;
        case 'deleteRemote':
        case 'deleteLocal':
          return 2;
        case 'keepRemoteFolder':
        case 'deleteLocalFolder':
          return 3;
        default:
          return 1;
      }
    };
    const depth = (a: Action): number => a.key.split('/').length;
    actions.sort(
      (a, b) => order(a) - order(b) || (order(a) === 3 ? depth(b) - depth(a) : depth(a) - depth(b))
    );

    // Rows saved below are newer than the old cursor, so forget it first. If
    // the app quits partway through, the next pass lists from scratch.
    if (actions.length > 0) {
      store.clearCursor();
    }
    let done = 0;
    for (const action of actions) {
      done++;
      this.step(`Syncing ${done} of ${actions.length}`);
      await this.apply(action);
    }
    // list_folder/continue leaves out a path that was created and deleted after
    // the cursor, and blocked paths got no rows, so after writing to Dropbox or
    // blocking a path the next pass lists from scratch.
    // A failed action can leave rows newer than the old cursor, so that case
    // lists from scratch too.
    if (
      actions.some((a) => REMOTE_WRITES.has(a.type)) ||
      this.blockedPaths > 0 ||
      this.errors > 0
    ) {
      store.clearCursor();
    } else {
      store.setCursor(cursor);
    }
    return this.finish();
  }

  private finish(massDelete?: {count: number; total: number}): SyncSummary {
    this.summary.issues = [...this.issues.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.summary.finishedAt = this.now().toISOString();
    if (massDelete) {
      this.summary.massDelete = massDelete;
    }
    return this.summary;
  }

  private step(step: string): void {
    this.opts.onStep?.(step);
  }

  private activity(kind: ActivityKind, path: string): void {
    this.opts.onActivity?.({kind, path, at: this.now().toISOString()});
  }

  // Returns the remote view after reading every page of the listing.
  private async listRemote(
    rows: Map<string, Row>
  ): Promise<{remote: Map<string, RemoteItem>; cursor: string}> {
    const {api, store, dropboxRoot} = this.opts;
    const saved = store.getCursor();
    if (saved && !this.opts.fullListing) {
      const remote = new RemoteView();
      for (const row of rows.values()) {
        remote.set(row.pathLower, rowToRemote(row));
      }
      try {
        let res = await api.listFolderContinue(saved);
        applyEntries(remote, res.entries, dropboxRoot);
        while (res.hasMore) {
          res = await api.listFolderContinue(res.cursor);
          applyEntries(remote, res.entries, dropboxRoot);
        }
        return {remote: remote.items, cursor: res.cursor};
      } catch (err) {
        // A reset cursor means listing the project again from scratch.
        if (!(err instanceof ApiError && err.summary.includes('reset'))) {
          throw err;
        }
      }
    }
    const remote = new RemoteView();
    try {
      let res = await api.listFolder(dropboxRoot, true);
      applyEntries(remote, res.entries, dropboxRoot);
      while (res.hasMore) {
        res = await api.listFolderContinue(res.cursor);
        applyEntries(remote, res.entries, dropboxRoot);
      }
      return {remote: remote.items, cursor: res.cursor};
    } catch (err) {
      if (isNotFound(err) && rows.size === 0) {
        // A new project: the folder doesn't exist in Dropbox yet.
        await api.createFolder(dropboxRoot);
        return this.listRemote(rows);
      }
      if (isNotFound(err)) {
        throw new Error(
          `The project folder ${dropboxRoot} is missing in Dropbox, so nothing was synced.`
        );
      }
      throw err;
    }
  }

  // Plans one action per path. Skipped local paths, and everything under them,
  // are left alone: missing from the scan doesn't mean deleted.
  private async plan(
    local: Map<string, LocalItem>,
    remote: Map<string, RemoteItem>,
    rows: Map<string, Row>,
    skipped: string[]
  ): Promise<Action[]> {
    const actions: Action[] = [];
    const keys = new Set([...local.keys(), ...remote.keys(), ...rows.keys()]);
    // Paths left alone this pass, with everything under them: skipped local
    // items, and paths where a file and a folder have the same name.
    const blocked = new Set(skipped);
    // Saved rows of the other kind: the path was replaced by a file or a
    // folder since the last sync, so it's planned as new.
    const replaced = new Set<string>();
    for (const key of keys) {
      const l = local.get(key);
      const r = remote.get(key);
      if (l && r && l.kind !== r.kind) {
        blocked.add(key);
        this.issue(
          key,
          l.dropboxPath,
          'A file and a folder have the same path. Rename one of them.'
        );
        continue;
      }
      const row = rows.get(key);
      const kind = l?.kind ?? r?.kind;
      if (row && kind && row.kind !== kind) {
        replaced.add(key);
      }
    }
    this.blockedPaths = blocked.size;
    for (const key of keys) {
      if (isUnder(key, blocked)) {
        continue;
      }
      const l = local.get(key);
      const r = remote.get(key);
      const row = replaced.has(key) ? undefined : rows.get(key);
      const kind = l?.kind ?? r?.kind ?? row?.kind;
      let action: Action | undefined;
      try {
        action =
          kind === 'folder' ? planFolder(key, l, r, row) : await this.planFile(key, l, r, row);
      } catch (err) {
        // A file that can't be read, or is gone, waits for the next pass.
        this.errors++;
        this.issue(key, l?.dropboxPath ?? r?.pathDisplay ?? key, errorMessage(err));
        continue;
      }
      if (action) {
        actions.push(action);
      }
    }
    return actions;
  }

  private async planFile(
    key: string,
    l: LocalItem | undefined,
    r: RemoteItem | undefined,
    row: Row | undefined
  ): Promise<Action | undefined> {
    const remoteFile = r?.kind === 'file' ? r : undefined;
    if (!row) {
      if (l && remoteFile) {
        // New on both sides: identical, or a conflict.
        const hash = await hashFile(l.localPath);
        return hash === remoteFile.contentHash
          ? {type: 'record', key, local: l, remote: remoteFile}
          : {type: 'upload', key, local: l, mode: {kind: 'add'}, hash};
      }
      if (l) {
        return {
          type: 'upload',
          key,
          local: l,
          mode: {kind: 'add'},
          hash: await hashFile(l.localPath),
        };
      }
      if (remoteFile) {
        return {type: 'download', key, remotePath: remoteFile.pathDisplay, expect: undefined};
      }
      return undefined;
    }

    const remoteChanged = remoteFile !== undefined && remoteFile.rev !== row.rev;
    let localHash: string | undefined;
    let localChanged = false;
    if (l) {
      if (row.uploadFailed || !sameStat(l.stat, row.stat)) {
        localHash = await hashFile(l.localPath);
        localChanged = row.uploadFailed || localHash !== row.contentHash;
      }
    }

    if (l && remoteFile) {
      if (!localChanged && !remoteChanged && remoteFile.pathDisplay !== row.pathDisplay) {
        // Renamed in Dropbox in case only, like photo.txt to Photo.txt.
        return {type: 'renameLocal', key, local: l, remote: remoteFile};
      }
      if (!localChanged && !remoteChanged) {
        // Only the stat changed, for example a touch.
        return localHash === undefined
          ? undefined
          : {type: 'record', key, local: l, remote: remoteFile};
      }
      if (localChanged && !remoteChanged) {
        return {
          type: 'upload',
          key,
          local: l,
          mode: {kind: 'update', rev: row.rev},
          hash: localHash ?? (await hashFile(l.localPath)),
        };
      }
      if (!localChanged) {
        return {
          type: 'download',
          key,
          remotePath: remoteFile.pathDisplay,
          expect: l.stat,
          localPath: l.localPath,
        };
      }
      const hash = localHash ?? (await hashFile(l.localPath));
      if (hash === remoteFile.contentHash) {
        return {type: 'record', key, local: l, remote: remoteFile};
      }
      // Changed on both sides. The server saves our copy under a conflicted name.
      return {type: 'upload', key, local: l, mode: {kind: 'update', rev: row.rev}, hash};
    }
    if (remoteFile) {
      // Deleted locally.
      return remoteChanged
        ? {type: 'download', key, remotePath: remoteFile.pathDisplay, expect: undefined}
        : {type: 'deleteRemote', key, row};
    }
    if (l) {
      // Deleted in Dropbox.
      return localChanged
        ? {
            type: 'upload',
            key,
            local: l,
            mode: {kind: 'add'},
            hash: localHash ?? (await hashFile(l.localPath)),
          }
        : {type: 'deleteLocal', key, local: l};
    }
    return {type: 'dropRow', key};
  }

  private async apply(action: Action): Promise<void> {
    const {store} = this.opts;
    const display = actionPath(action);
    try {
      // A project folder swapped since the scan would turn the plan into
      // deletes of everything, so check it before every action.
      await this.requireRootUnchanged();
      this.rebaseAction(action);
      switch (action.type) {
        case 'upload':
          await this.upload(action.key, action.local, action.mode, action.hash);
          break;
        case 'download':
          await this.download(action.key, action.remotePath, action.expect, action.localPath);
          break;
        case 'record':
          store.put(rowFrom(action.remote, action.local.stat));
          break;
        case 'renameLocal':
          await this.renameLocal(action.local, action.remote);
          break;
        case 'deleteRemote':
          await this.deleteRemote(action.key, action.row);
          break;
        case 'deleteLocal':
          await this.deleteLocal(action.key, action.local);
          break;
        case 'dropRow':
          store.remove(action.key);
          break;
        case 'createRemoteFolder':
          await this.opts.api.createFolder(action.local.dropboxPath);
          store.put({
            pathLower: action.key,
            pathDisplay: action.local.dropboxPath,
            kind: 'folder',
            id: '',
            rev: '',
            contentHash: '',
            uploadFailed: false,
          });
          break;
        case 'createLocalFolder':
          await this.makeFolders(this.localPathFor(action.remote.pathDisplay));
          store.put(rowFrom(action.remote, undefined));
          break;
        case 'keepRemoteFolder':
          store.put({...action.row, deletedHere: true});
          break;
        case 'deleteLocalFolder':
          await this.deleteLocalFolder(action.key, action.local);
          break;
      }
    } catch (err) {
      this.errors++;
      if (action.type === 'upload') {
        const row = store.row(action.key);
        if (row) {
          store.put({...row, uploadFailed: true});
        }
      }
      this.issue(action.key, display, errorMessage(err));
    }
  }

  private async upload(
    key: string,
    local: LocalItem,
    mode: WriteMode,
    hash: string
  ): Promise<void> {
    // Never send a file from outside the project to Dropbox.
    await this.requireInProject(local.localPath);
    // Known limitation: if Dropbox saves the file but the response is lost, the
    // next pass uploads it again, and a conflicted copy is saved twice. A client
    // you ship should record pending uploads and check for them before retrying.
    const meta = await this.opts.api.upload({
      localPath: local.localPath,
      dropboxPath: local.dropboxPath,
      mode,
      clientModified: new Date(Number(BigInt(local.stat.mtimeNs) / 1_000_000n)),
      contentHash: hash,
      checkUnchanged: async () => {
        if (!sameStat(await statOrUndefined(local.localPath), local.stat)) {
          throw new Error(
            'The file changed while it was being uploaded. It will be uploaded again.'
          );
        }
      },
    });
    if (pathKey(meta.pathDisplay) === key) {
      this.opts.store.put(rowFrom(metaToRemote(meta), local.stat));
      this.summary.uploaded++;
      this.activity('uploaded', meta.pathDisplay);
      return;
    }
    // The server saved our copy under a conflicted-copy name. Rename the local
    // file to match, then download the other version to the original path.
    // If the file changed since the scan, leave it: the next pass syncs the edit.
    if (!sameStat(await statOrUndefined(local.localPath), local.stat)) {
      throw new Error(
        `The file changed while it was being uploaded. Dropbox saved the earlier version as ${meta.pathDisplay}.`
      );
    }
    this.summary.conflicts++;
    this.activity('conflict', meta.pathDisplay);
    const renamedPath = this.localPathFor(meta.pathDisplay);
    await this.makeFolders(dirname(renamedPath));
    // Move it aside in one rename first, so an editor saving over it now
    // leaves the new version at the original path instead of losing it.
    const backup = await this.backUp(local.localPath, local.stat);
    if (await moveIfFree(backup, renamedPath)) {
      // The stat from before the upload: an edit after it makes the next pass
      // compare the file again.
      this.opts.store.put(rowFrom(metaToRemote(meta), local.stat));
    }
    // Otherwise an unsynced local file already has that name. Ours stays in
    // old_files; Dropbox has it under the conflicted-copy name, so the next
    // pass syncs both files.
    this.issue(
      pathKey(meta.pathDisplay),
      meta.pathDisplay,
      `Conflict: your version was saved as ${meta.pathDisplay}.`
    );
    // Our file was moved away, so the download takes Dropbox's name, which
    // can differ from ours in case.
    await this.download(key, local.dropboxPath, undefined);
  }

  private async download(
    key: string,
    remotePath: string,
    expect: LocalStat | undefined,
    localPath?: string
  ): Promise<void> {
    await this.requireStateFolder(this.newFilesDir);
    const tmp = join(this.newFilesDir, randomUUID());
    try {
      const meta = await this.opts.api.downloadToFile(remotePath, tmp);
      // new_files could have been swapped for a link during the download.
      await this.requireStateFolder(this.newFilesDir);
      const inProject = this.localPathFor(meta.pathDisplay);
      if (localPath && pathKey(meta.pathDisplay) !== key) {
        throw new Error(`Dropbox sent ${meta.pathDisplay} for ${remotePath}.`);
      }
      // The file being replaced, and where the download goes: the same folder,
      // with Dropbox's name, which can differ from the local one in case.
      const replaced = localPath ?? inProject;
      const target = join(dirname(replaced), baseName(meta.pathDisplay));
      await this.makeFolders(dirname(target));
      const mtime = new Date(
        Math.min(meta.clientModified.getTime(), meta.serverModified.getTime(), this.now().getTime())
      );
      await utimes(tmp, mtime, mtime);
      // Take the stat before the file is visible, so an edit made right after
      // the move doesn't get recorded as synced.
      const synced = await statOrUndefined(tmp);
      // Swap only if the file is as this pass saw it: the same stat, or still missing.
      const current = await statOrUndefined(replaced);
      if (expect === undefined ? current !== undefined : !sameStat(current, expect)) {
        throw new Error(CHANGED_DURING_DOWNLOAD);
      }
      await this.requireInProject(target);
      const backup = expect ? await this.backUp(replaced, expect) : undefined;
      let moved: boolean;
      try {
        moved = await moveIfFree(tmp, target);
      } catch (err) {
        // For example, a full disk. Put the previous version back.
        if (backup && !(await this.putBack(backup, replaced))) {
          throw new Error(
            `Couldn’t save the download: ${errorMessage(err)}. The previous version is in ${await this.keep(backup)}.`
          );
        }
        throw err;
      }
      if (!moved) {
        // A local file appeared there during the download; keep it.
        throw new Error(
          'A file was created there while it was being downloaded. It will be synced again.'
        );
      }
      // Installing can change the file's ctime, so save its stat from after the
      // move. If it already changed, save none, and the next pass compares it.
      const installed = await statOrUndefined(target);
      const keep = installed && synced && sameFile(installed, synced) ? installed : undefined;
      this.opts.store.put(rowFrom(metaToRemote(meta), keep));
      this.summary.downloaded++;
      this.activity('downloaded', meta.pathDisplay);
      if (pathKey(meta.pathDisplay) !== key) {
        this.opts.store.remove(key);
      }
    } finally {
      // Never delete through a new_files swapped for a link.
      await this.requireStateFolder(this.newFilesDir);
      await rm(tmp, {force: true});
    }
  }

  private async deleteRemote(key: string, row: Row): Promise<void> {
    try {
      await this.opts.api.deleteV2(row.pathDisplay, row.rev);
      this.summary.deletedRemote++;
      this.activity('deleted-remote', row.pathDisplay);
      this.opts.store.remove(key);
    } catch (err) {
      if (isNotFound(err)) {
        this.opts.store.remove(key);
        return;
      }
      if (isConflict(err)) {
        // Changed in Dropbox since the last sync: download it again.
        await this.download(key, row.pathDisplay, undefined);
        return;
      }
      throw err;
    }
  }

  private async deleteLocal(key: string, local: LocalItem): Promise<void> {
    if (!sameStat(await statOrUndefined(local.localPath), local.stat)) {
      throw new Error(CHANGED_AFTER_SCAN);
    }
    await this.backUp(local.localPath, local.stat);
    this.opts.store.remove(key);
    this.summary.deletedLocal++;
    this.activity('deleted-local', local.dropboxPath);
  }

  // Throws unless the project folder is still the real folder the pass started with.
  private async requireRootUnchanged(): Promise<void> {
    const st = await lstat(this.opts.localRoot, {bigint: true});
    if (st.isSymbolicLink() || !st.isDirectory() || String(st.ino) !== this.rootInode) {
      throw new Error(
        'The project folder changed during the sync, so FolderSync stopped writing to it.'
      );
    }
  }

  // Throws unless .foldersync and its folder dir are the real folders the pass
  // started with, so nothing is moved or written through a swapped link.
  private async requireStateFolder(dir: string): Promise<void> {
    await this.requireRootUnchanged();
    for (const d of [this.stateDir, dir]) {
      const st = await lstat(d, {bigint: true});
      if (st.isSymbolicLink() || !st.isDirectory() || String(st.ino) !== this.stateInodes.get(d)) {
        throw new Error(`${d} changed during the sync, so FolderSync stopped using it.`);
      }
    }
  }

  // Throws unless path's folder, after following symlinks, is in the project.
  // A parent folder swapped for a symlink after the scan could lead outside.
  private async requireInProject(path: string): Promise<void> {
    await this.requireRootUnchanged();
    const dir = await realpath(dirname(path));
    if (dir !== this.realRoot && !dir.startsWith(`${this.realRoot}${sep}`)) {
      throw new Error(
        'A folder above it is now outside the project, so FolderSync won’t change it.'
      );
    }
  }

  // Moves an action's scanned local path under any folder renamed earlier in
  // the pass. Actions run shallowest first, so parents are renamed first.
  private rebaseAction(action: Action): void {
    if ('local' in action) {
      action.local = {...action.local, localPath: this.rebased(action.local.localPath)};
    }
    if (action.type === 'download' && action.localPath) {
      action.localPath = this.rebased(action.localPath);
    }
  }

  private rebased(path: string): string {
    // Repeated, for a renamed folder inside another renamed folder.
    for (let pass = 0; pass <= this.renamed.size; pass++) {
      const match = [...this.renamed].find(([from]) => path.startsWith(`${from}${sep}`));
      if (!match) {
        break;
      }
      path = match[1] + path.slice(match[0].length);
    }
    return path;
  }

  // Gives a local item the name it has in Dropbox, which differs only in case,
  // then saves the new name. Only the last part of the path changes; a renamed
  // parent folder is handled first, since actions run shallowest first.
  private async renameLocal(local: LocalItem, remote: RemoteItem): Promise<void> {
    const target = join(dirname(local.localPath), baseName(remote.pathDisplay));
    if (local.dropboxPath !== remote.pathDisplay && target !== local.localPath) {
      if (!sameStat(await statOrUndefined(local.localPath), local.stat)) {
        throw new Error(CHANGED_AFTER_SCAN);
      }
      await this.requireInProject(local.localPath);
      // On a case-insensitive volume the target is this same item.
      const existing = await statOrUndefined(target);
      if (existing && existing.inode !== local.stat.inode) {
        throw new Error(
          `Couldn’t rename it to ${baseName(remote.pathDisplay)}: something else has that name.`
        );
      }
      await rename(local.localPath, target);
      if (local.kind === 'folder') {
        this.renamed.set(local.localPath, target);
      }
    }
    // The scanned stat: an edit made after the scan makes the next pass
    // compare the file again.
    this.opts.store.put(rowFrom(remote, local.stat));
  }

  private async deleteLocalFolder(key: string, local: LocalItem): Promise<void> {
    await this.requireInProject(local.localPath);
    // Still the folder the scan saw, not a link or a different folder.
    const st = await statOrUndefined(local.localPath);
    if (!st || st.inode !== local.stat.inode || !(await isRealFolder(local.localPath))) {
      throw new Error(CHANGED_AFTER_SCAN);
    }
    if ((await readdir(local.localPath)).length > 0) {
      throw new Error('The folder wasn’t deleted because something new is in it.');
    }
    await rmdir(local.localPath);
    this.opts.store.remove(key);
    this.summary.deletedLocal++;
    this.activity('deleted-local', local.dropboxPath);
  }

  // Moves a file that sync would replace or delete into old_files, and returns
  // its new path. The backup's name keeps the end of the original name.
  private async moveToOldFiles(path: string): Promise<string> {
    await this.requireStateFolder(this.oldFilesDir);
    const name = basename(path);
    const backup = join(
      this.oldFilesDir,
      `${Date.now()}-${randomUUID()}-${tailBytes(name, BACKUP_NAME_BYTES)}`
    );
    await rename(path, backup);
    return backup;
  }

  // Moves a file into old_files if it's still as the pass saw it. An edit saved
  // just before the move is put back for the next pass.
  private async backUp(path: string, expect: LocalStat): Promise<string> {
    await this.requireInProject(path);
    const backup = await this.moveToOldFiles(path);
    if (sameFile(await statOrUndefined(backup), expect)) {
      return backup;
    }
    if (!(await this.putBack(backup, path))) {
      throw new Error(
        `The file changed after the scan. Your version is in ${await this.keep(backup)}.`
      );
    }
    throw new Error(CHANGED_AFTER_SCAN);
  }

  // Moves a backup back to path, if path is free. A failure counts as not free.
  private async putBack(backup: string, path: string): Promise<boolean> {
    try {
      return await moveIfFree(backup, path);
    } catch {
      return false;
    }
  }

  // Moves a backup that couldn't be put back out of old_files, so the purge
  // never deletes it, and returns its new path. A rename needs no free space.
  private async keep(backup: string): Promise<string> {
    await this.requireStateFolder(this.keptDir);
    const kept = join(this.keptDir, basename(backup));
    await rename(backup, kept);
    return kept;
  }

  // Deletes downloads left in new_files by a pass that didn't finish, for
  // example when the app quit mid-download.
  private async clearNewFiles(): Promise<void> {
    await this.requireStateFolder(this.newFilesDir);
    for (const name of await readdir(this.newFilesDir)) {
      // Never delete through a new_files swapped for a link. It holds only files.
      await this.requireStateFolder(this.newFilesDir);
      await rm(join(this.newFilesDir, name), {force: true});
    }
  }

  // Deletes old_files entries older than 3 days, then the oldest ones while the
  // folder is over 10 GB or 10% of the free space.
  private async purgeOldFiles(): Promise<void> {
    await this.requireStateFolder(this.oldFilesDir);
    const entries = [];
    for (const name of await readdir(this.oldFilesDir)) {
      const path = join(this.oldFilesDir, name);
      const st = await lstat(path);
      // A backup's age is from when it was made, the timestamp in its name, not
      // its mtime, which is the original file's.
      const made = Number(name.slice(0, name.indexOf('-')));
      entries.push({
        path,
        size: st.size,
        mtimeMs: Number.isFinite(made) && made > 0 ? made : st.mtimeMs,
      });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const fs = await statfs(this.oldFilesDir);
    const cap = Math.min(OLD_FILES_MAX_BYTES, fs.bavail * fs.bsize * 0.1);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    const cutoff = this.now().getTime() - OLD_FILES_MAX_AGE_MS;
    for (const e of entries) {
      if (e.mtimeMs >= cutoff && total <= cap) {
        break;
      }
      // Never delete through an old_files swapped for a link.
      await this.requireStateFolder(this.oldFilesDir);
      await unlink(e.path);
      total -= e.size;
    }
  }

  // Maps a Dropbox path in the project to its local path. Throws for a path
  // that would leave the project folder or go into the state folder.
  private localPathFor(dropboxPath: string): string {
    const parts = projectParts(dropboxPath, this.opts.dropboxRoot);
    if (!parts) {
      throw new Error(`${dropboxPath} isn’t a path FolderSync can sync.`);
    }
    return join(this.opts.localRoot, ...parts);
  }

  // Creates a local folder and its parents in the project. Refuses to go
  // through a symlink, which could point outside the project folder.
  private async makeFolders(localDir: string): Promise<void> {
    await this.requireRootUnchanged();
    const parts = relative(this.opts.localRoot, localDir).split(sep).filter(Boolean);
    let dir = this.opts.localRoot;
    let dropboxDir = this.opts.dropboxRoot;
    for (const part of parts) {
      dir = join(dir, part);
      dropboxDir = joinDropbox(dropboxDir, part.normalize('NFC'));
      const st = await lstat(dir).catch((err: unknown) => {
        if (isErrnoCode(err, 'ENOENT')) {
          return undefined;
        }
        throw err;
      });
      if (!st) {
        await mkdir(dir);
        // A folder deleted here is back, so it's synced again.
        const row = this.opts.store.row(pathKey(dropboxDir));
        if (row?.deletedHere) {
          this.opts.store.put({...row, deletedHere: false});
        }
      } else if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`${dir} is a link or a file, so FolderSync won’t write inside it.`);
      }
    }
  }

  private issue(key: string, display: string, message: string): void {
    this.issues.set(key, {path: display, message});
  }
}

// A folder's sync state belongs to one account: planned against another
// account's Dropbox, it would delete or upload the wrong files. State saved
// before accounts were recorded has none, and the first account to sync claims it.
function requireSameAccount(store: StateStore, accountId: string, localRoot: string): void {
  const owner = store.getAccount();
  if (owner === undefined) {
    store.setAccount(accountId);
  } else if (owner !== accountId) {
    throw new Error(
      `${localRoot} is synced with another Dropbox account. Choose another folder for this project.`
    );
  }
}

function planFolder(
  key: string,
  l: LocalItem | undefined,
  r: RemoteItem | undefined,
  saved: Row | undefined
): Action | undefined {
  let row = saved;
  if (row?.deletedHere) {
    if (r && !l) {
      return undefined;
    }
    if (!r && !l) {
      return {type: 'dropRow', key};
    }
    // Back on this computer, for example with a new file in it: plan it as new.
    row = undefined;
  }
  if (!row) {
    if (l && r) {
      return {type: 'record', key, local: l, remote: r};
    }
    if (l) {
      return {type: 'createRemoteFolder', key, local: l};
    }
    return r ? {type: 'createLocalFolder', key, remote: r} : undefined;
  }
  if (l && r) {
    // Renamed in Dropbox in case only.
    return r.pathDisplay === row.pathDisplay
      ? undefined
      : {type: 'renameLocal', key, local: l, remote: r};
  }
  if (r) {
    // Deleted here. The folder stays in Dropbox, since delete_v2 on a folder
    // deletes whatever is in it; its files are deleted on their own.
    return {type: 'keepRemoteFolder', key, row};
  }
  if (l) {
    return {type: 'deleteLocalFolder', key, local: l};
  }
  return {type: 'dropRow', key};
}

// The path's parts below the project folder, or undefined if it's outside the
// project, has "." or ".." parts, or is in FolderSync's own state folder.
function projectParts(dropboxPath: string, dropboxRoot: string): string[] | undefined {
  const root = pathKey(dropboxRoot);
  if (!pathKey(dropboxPath).startsWith(`${root}/`)) {
    return undefined;
  }
  const parts = dropboxPath.slice(dropboxRoot.length).split('/').filter(Boolean);
  // Names that never sync are left alone in Dropbox too, so they're neither
  // downloaded nor, missing from the local scan, deleted.
  const unsafe =
    parts.some((p) => p === '.' || p === '..' || isIgnoredName(p)) ||
    pathKey(parts[0] ?? '') === STATE_DIR;
  return parts.length === 0 || unsafe ? undefined : parts;
}

// The remote view: items by key, plus each folder's direct children, so
// removing a folder's contents visits only what's inside it.
class RemoteView {
  readonly items = new Map<string, RemoteItem>();
  private readonly children = new Map<string, Set<string>>();

  get(key: string): RemoteItem | undefined {
    return this.items.get(key);
  }

  set(key: string, item: RemoteItem): void {
    this.items.set(key, item);
    const parent = parentKey(key);
    let siblings = this.children.get(parent);
    if (!siblings) {
      siblings = new Set();
      this.children.set(parent, siblings);
    }
    siblings.add(key);
  }

  delete(key: string): void {
    this.items.delete(key);
    this.children.get(parentKey(key))?.delete(key);
  }

  // Removes everything under key, not key itself.
  removeContents(key: string): void {
    const kids = this.children.get(key);
    if (!kids) {
      return;
    }
    this.children.delete(key);
    for (const kid of kids) {
      this.items.delete(kid);
      this.removeContents(kid);
    }
  }
}

function parentKey(key: string): string {
  return key.slice(0, Math.max(key.lastIndexOf('/'), 0));
}

// Adds listing entries to the remote view. Entries FolderSync can't sync, like
// its own state folder, are left out.
function applyEntries(remote: RemoteView, entries: Metadata[], dropboxRoot: string): void {
  for (const e of entries) {
    if (!projectParts(e.pathDisplay, dropboxRoot)) {
      continue;
    }
    // Keyed like the local scan, not by Dropbox's path_lower, so both sides
    // agree on which paths are the same.
    const key = pathKey(e.pathDisplay);
    const before = remote.get(key);
    if (e.tag === 'deleted') {
      remote.delete(key);
      if (before?.kind !== 'file') {
        remote.removeContents(key);
      }
      continue;
    }
    if (e.tag === 'file') {
      // A file replaces a folder at its path, including the folder's children.
      if (before?.kind === 'folder') {
        remote.removeContents(key);
      }
      remote.set(key, metaToRemote(e));
      continue;
    }
    remote.set(key, {kind: 'folder', pathDisplay: e.pathDisplay, id: e.id});
  }
}

// Moves a file only if nothing is at the destination; returns false if
// something is. rename() would replace it.
async function moveIfFree(from: string, to: string): Promise<boolean> {
  try {
    await link(from, to);
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST')) {
      return false;
    }
    if (!NO_HARD_LINKS.some((code) => isErrnoCode(err, code))) {
      throw err;
    }
    // The volume has no hard links, for example exFAT. Copy without replacing,
    // keeping the modified time, then remove the original.
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if (isErrnoCode(copyErr, 'EEXIST')) {
        return false;
      }
      throw copyErr;
    }
    const {atime, mtime} = await stat(from);
    await utimes(to, atime, mtime);
  }
  await unlink(from);
  return true;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

function metaToRemote(m: FileMeta): RemoteItem {
  return {
    kind: 'file',
    pathDisplay: m.pathDisplay,
    id: m.id,
    rev: m.rev,
    contentHash: m.contentHash,
  };
}

function rowToRemote(row: Row): RemoteItem {
  return row.kind === 'file'
    ? {
        kind: 'file',
        pathDisplay: row.pathDisplay,
        id: row.id,
        rev: row.rev,
        contentHash: row.contentHash,
      }
    : {kind: 'folder', pathDisplay: row.pathDisplay, id: row.id};
}

// The end of a name, at most maxBytes long in UTF-8, without splitting a character.
function tailBytes(name: string, maxBytes: number): string {
  const chars = [...name];
  let start = chars.length;
  let bytes = 0;
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1] ?? '');
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    start--;
  }
  return chars.slice(start).join('');
}

// Whether a file is the same and unchanged, ignoring ctime, which a rename updates.
function sameFile(a: LocalStat | undefined, b: LocalStat): boolean {
  return a !== undefined && a.inode === b.inode && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function rowFrom(r: RemoteItem, stat: LocalStat | undefined): Row {
  return {
    pathLower: pathKey(r.pathDisplay),
    pathDisplay: r.pathDisplay,
    kind: r.kind,
    id: r.id,
    rev: r.kind === 'file' ? r.rev : '',
    contentHash: r.kind === 'file' ? r.contentHash : '',
    stat,
    uploadFailed: false,
  };
}

function actionPath(a: Action): string {
  switch (a.type) {
    case 'upload':
    case 'deleteLocal':
    case 'createRemoteFolder':
    case 'deleteLocalFolder':
    case 'record':
      return a.local.dropboxPath;
    case 'renameLocal':
      return a.remote.pathDisplay;
    case 'download':
      return a.remotePath;
    case 'createLocalFolder':
      return a.remote.pathDisplay;
    case 'deleteRemote':
    case 'keepRemoteFolder':
      return a.row.pathDisplay;
    case 'dropRow':
      return a.key;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && 'code' in err) {
    switch (err.code) {
      case 'ENOSPC':
        return 'The disk is full.';
      case 'ENAMETOOLONG':
        return 'The name is too long for this disk.';
      case 'EACCES':
      case 'EPERM':
        return 'The app doesn’t have permission to change this file.';
      case 'EBUSY':
        return 'The file is in use. It will be synced again.';
    }
  }
  return err instanceof Error ? err.message : String(err);
}
