// The Dropbox files panel: one folder level of a project as it is in Dropbox,
// each file's status on this computer, and the Open, Show in Finder, and
// Delete from Dropbox actions.
import {existsSync, rmSync} from 'node:fs';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';

import {isConflict, type Metadata} from '../engine/dropboxApi';
import {fileStatus} from '../engine/fileStatus';
import {refuseLinks, statOrUndefined} from '../engine/localScan';
import {STATE_DIR, baseName, pathKey} from '../engine/paths';
import {openStateStore, type Row} from '../engine/stateStore';
import type {RemoteEntry} from '../shared/types';
import type {Settings} from './config';
import type {ProjectClients, UserApi} from './projectClients';

export class FilesPanel {
  // Temporary folders with copies downloaded for Open.
  private readonly openCopies = new Set<string>();

  constructor(
    private readonly settings: Settings,
    private readonly clients: ProjectClients,
    private readonly userApi: () => UserApi,
    // The signed-in user's ID; another account's sync state is ignored.
    private readonly accountId: () => string
  ) {}

  // Lists one folder level of a project in Dropbox, folders first.
  async list(project: string, folder = `/${project}`): Promise<RemoteEntry[]> {
    this.localPath(project, folder);
    const api = this.userApi();
    let res = await api.listFolder(folder, false);
    const entries: Metadata[] = [...res.entries];
    while (res.hasMore) {
      res = await api.listFolderContinue(res.cursor);
      entries.push(...res.entries);
    }
    const rows = await this.syncedRows(project);
    const result: RemoteEntry[] = [];
    for (const e of entries) {
      // Folders deleted on this computer stay in Dropbox, empty; don't list them here.
      if (e.tag === 'deleted' || (e.tag === 'folder' && rows.get(e.pathLower)?.deletedHere)) {
        continue;
      }
      const local = await statOrUndefined(this.localPath(project, e.pathDisplay));
      const common = {
        name: baseName(e.pathDisplay),
        path: e.pathDisplay,
        onComputer: local !== undefined,
      };
      if (e.tag === 'folder') {
        result.push({kind: 'folder', ...common});
        continue;
      }
      result.push({
        kind: 'file',
        ...common,
        size: e.size,
        modified: e.serverModified.toISOString(),
        rev: e.rev,
        status: fileStatus(e.rev, rows.get(e.pathLower), local),
      });
    }
    return result.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1
    );
  }

  // The local file to open: the synced copy, or a downloaded copy in a
  // temporary folder. Whether the copy is synced is checked here, not taken
  // from the window.
  async fileToOpen(project: string, entry: RemoteEntry): Promise<string> {
    const local = this.localPath(project, entry.path);
    const row = (await this.syncedRows(project)).get(pathKey(entry.path));
    if (
      entry.rev !== undefined &&
      fileStatus(entry.rev, row, await statOrUndefined(local)) === 'synced' &&
      (await this.insideProject(project, local))
    ) {
      return local;
    }
    const dir = await mkdtemp(join(tmpdir(), 'foldersync-open-'));
    this.openCopies.add(dir);
    // From the checked path, not the window's name, which could differ.
    const target = join(dir, baseName(entry.path));
    try {
      await this.userApi().downloadToFile(entry.path, target);
    } catch (err) {
      this.openCopies.delete(dir);
      await rm(dir, {recursive: true, force: true});
      throw err;
    }
    return target;
  }

  // Deletes the copies downloaded for Open. Runs when the app quits.
  removeOpenCopies(): void {
    for (const dir of this.openCopies) {
      try {
        rmSync(dir, {recursive: true, force: true});
      } catch {
        // The app is quitting, so there's no one to tell. macOS clears the
        // temporary folder later.
      }
    }
    this.openCopies.clear();
  }

  // The local copy to show in Finder.
  async fileToReveal(project: string, path: string): Promise<string> {
    const local = this.localPath(project, path);
    if (!existsSync(local)) {
      throw new Error('It isn’t on this computer yet. Press Sync now first.');
    }
    if (!(await this.insideProject(project, local))) {
      throw new Error('That item isn’t in this project.');
    }
    return local;
  }

  // Deletes a file with the agent's token, so it can be undone. parent_rev
  // makes Dropbox refuse if the file changed since the list was loaded.
  async delete(project: string, path: string, rev: string): Promise<void> {
    this.localPath(project, path);
    const api = await this.clients.agentClient(project);
    try {
      await api.deleteV2(path, rev);
    } catch (err) {
      if (isConflict(err)) {
        throw new Error('It changed in Dropbox since the list was loaded. Refresh and try again.');
      }
      throw err;
    }
  }

  // Maps a Dropbox path in a project to its local path. Throws for a path
  // outside the project.
  private localPath(project: string, dropboxPath: string): string {
    const root = pathKey(`/${project}`);
    const key = pathKey(dropboxPath);
    if (key !== root && !key.startsWith(`${root}/`)) {
      throw new Error('That item isn’t in this project.');
    }
    const rel = dropboxPath.slice(root.length).split('/').filter(Boolean);
    return join(this.settings.project(project).localDir, ...rel);
  }

  // Whether a local path, after following symlinks, is inside the project folder.
  private async insideProject(project: string, path: string): Promise<boolean> {
    const [root, real] = await Promise.all([
      realpath(this.settings.project(project).localDir),
      realpath(path),
    ]);
    return real.startsWith(`${root}${sep}`);
  }

  // The project's last-synced rows, or none if it was never synced here.
  private async syncedRows(project: string): Promise<Map<string, Row>> {
    const {localDir} = this.settings.project(project);
    // Never read a database through a link, which could point outside.
    await refuseLinks(localDir, join(localDir, STATE_DIR));
    if (!existsSync(join(localDir, STATE_DIR, 'state.db'))) {
      return new Map();
    }
    const store = await openStateStore(join(localDir, STATE_DIR));
    try {
      const owner = store.getAccount();
      return owner === undefined || owner === this.accountId() ? store.rows() : new Map();
    } finally {
      store.close();
    }
  }
}
