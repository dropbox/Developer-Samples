import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {statOrUndefined} from '../src/engine/localScan';
import {STATE_DIR} from '../src/engine/paths';
import type {DropboxFiles} from '../src/engine/dropboxApi';
import {StateStore} from '../src/engine/stateStore';
import {runSyncPass} from '../src/engine/syncPass';
import {FakeDropbox} from './fakeDropbox';

const ROOT = '/project';
const ACCOUNT = 'pid_user:a';

let dir: string;
let dropbox: FakeDropbox;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-'));
  dropbox = new FakeDropbox();
  await dropbox.createFolder(ROOT);
  await mkdir(join(dir, STATE_DIR), {recursive: true});
  store = new StateStore(join(dir, STATE_DIR, 'state.db'));
});

afterEach(async () => {
  store.close();
  await rm(dir, {recursive: true, force: true});
});

function sync(
  allowMassDelete = false,
  api: DropboxFiles = dropbox
): ReturnType<typeof runSyncPass> {
  return runSyncPass({
    api,
    store,
    localRoot: dir,
    dropboxRoot: ROOT,
    accountId: ACCOUNT,
    allowMassDelete,
  });
}

// The fake Dropbox with some calls replaced.
function filesWith(overrides: Partial<DropboxFiles>): DropboxFiles {
  return {
    listFolder: dropbox.listFolder.bind(dropbox),
    listFolderContinue: dropbox.listFolderContinue.bind(dropbox),
    downloadToFile: dropbox.downloadToFile.bind(dropbox),
    upload: dropbox.upload.bind(dropbox),
    deleteV2: dropbox.deleteV2.bind(dropbox),
    createFolder: dropbox.createFolder.bind(dropbox),
    ...overrides,
  };
}

// Reopens the state database, as a restart does.
function reopenStore(): void {
  store.close();
  store = new StateStore(join(dir, STATE_DIR, 'state.db'));
}

// A local file's content, or undefined if it doesn't exist.
async function local(rel: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, rel), 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

async function writeLocal(rel: string, content: string): Promise<void> {
  await mkdir(join(dir, rel, '..'), {recursive: true});
  await writeFile(join(dir, rel), content);
}

describe('sync pass', () => {
  it('downloads a project, then does nothing on the next pass', async () => {
    dropbox.put('/project/a.txt', 'A');
    dropbox.put('/project/scenes/b.txt', 'B');

    const first = await sync();
    expect(first).toMatchObject({downloaded: 2, uploaded: 0});
    expect(await local('a.txt')).toBe('A');
    expect(await local('scenes/b.txt')).toBe('B');

    const second = await sync();
    expect(second).toMatchObject({downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0});
    expect(dropbox.downloads).toBe(2);
  });

  it('uploads new and edited local files', async () => {
    await writeLocal('new.txt', 'one');
    await sync();
    expect(dropbox.content('/project/new.txt')).toBe('one');

    await writeLocal('new.txt', 'two, edited');
    expect(await sync()).toMatchObject({uploaded: 1});
    expect(dropbox.content('/project/new.txt')).toBe('two, edited');
  });

  it('downloads a file changed in Dropbox', async () => {
    dropbox.put('/project/render.txt', 'v1');
    await sync();

    dropbox.put('/project/render.txt', 'v2 from the agent');
    expect(await sync()).toMatchObject({downloaded: 1});
    expect(await local('render.txt')).toBe('v2 from the agent');
  });

  it('keeps both versions when a file changed on both sides', async () => {
    dropbox.put('/project/doc.txt', 'base');
    await sync();
    dropbox.put('/project/doc.txt', 'remote edit');
    await writeLocal('doc.txt', 'local edit');

    expect(await sync()).toMatchObject({conflicts: 1});
    expect(await local('doc.txt')).toBe('remote edit');
    expect(await local("doc (user's conflicted copy).txt")).toBe('local edit');
    expect(dropbox.content("/project/doc (user's conflicted copy).txt")).toBe('local edit');
    expect(dropbox.content('/project/doc.txt')).toBe('remote edit');

    expect(await sync()).toMatchObject({uploaded: 0, downloaded: 0, conflicts: 0});
  });

  it('propagates deletes in both directions', async () => {
    dropbox.put('/project/local-delete.txt', 'x');
    dropbox.put('/project/remote-delete.txt', 'y');
    await sync();

    await rm(join(dir, 'local-delete.txt'));
    dropbox.remove('/project/remote-delete.txt');

    expect(await sync()).toMatchObject({deletedRemote: 1, deletedLocal: 1});
    expect(dropbox.content('/project/local-delete.txt')).toBeUndefined();
    expect(await local('remote-delete.txt')).toBeUndefined();
    const oldFiles = await readdir(join(dir, STATE_DIR, 'old_files'));
    expect(oldFiles.some((name) => name.endsWith('remote-delete.txt'))).toBe(true);
  });

  it('deletes a file locally that was deleted in Dropbox right after this computer uploaded it', async () => {
    await sync();
    await writeLocal('new.txt', 'one');
    expect(await sync()).toMatchObject({uploaded: 1});

    dropbox.remove('/project/new.txt');
    expect(await sync()).toMatchObject({deletedLocal: 1});
    expect(await local('new.txt')).toBeUndefined();
  });

  it('downloads a file again when it was deleted locally but changed in Dropbox', async () => {
    dropbox.put('/project/f.txt', 'v1');
    await sync();
    await rm(join(dir, 'f.txt'));
    dropbox.put('/project/f.txt', 'v2');

    expect(await sync()).toMatchObject({downloaded: 1, deletedRemote: 0});
    expect(await local('f.txt')).toBe('v2');
  });

  it('uploads a file again when it was deleted in Dropbox but changed locally', async () => {
    dropbox.put('/project/f.txt', 'v1');
    await sync();
    dropbox.remove('/project/f.txt');
    await writeLocal('f.txt', 'local v2');

    expect(await sync()).toMatchObject({uploaded: 1, deletedLocal: 0});
    expect(dropbox.content('/project/f.txt')).toBe('local v2');
  });

  it('records identical files that are new on both sides without a transfer', async () => {
    dropbox.put('/project/same.txt', 'same');
    await writeLocal('same.txt', 'same');

    expect(await sync()).toMatchObject({uploaded: 0, downloaded: 0, conflicts: 0});
    expect(dropbox.uploads).toBe(0);
  });

  it('keeps both versions when different files are new on both sides', async () => {
    dropbox.put('/project/new.txt', 'remote');
    await writeLocal('new.txt', 'local');

    expect(await sync()).toMatchObject({conflicts: 1});
    expect(await local('new.txt')).toBe('remote');
    expect(await local('new (1).txt')).toBe('local');
  });

  it('merges an existing local folder, then does nothing after a restart', async () => {
    dropbox.put('/project/remote-only.txt', 'remote only');
    dropbox.put('/project/same.txt', 'same');
    dropbox.put('/project/different.txt', 'remote version');
    await writeLocal('local-only.txt', 'local only');
    await writeLocal('same.txt', 'same');
    await writeLocal('different.txt', 'local version');

    await sync();
    expect(await local('remote-only.txt')).toBe('remote only');
    expect(dropbox.content('/project/local-only.txt')).toBe('local only');
    expect(await local('different.txt')).toBe('remote version');
    expect(await local('different (1).txt')).toBe('local version');

    reopenStore();
    for (let pass = 0; pass < 3; pass++) {
      expect(await sync()).toMatchObject({
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        issues: [],
      });
    }
  });

  it('settles after Dropbox saves an upload but the response is lost', async () => {
    await writeLocal('a.txt', 'local');
    const responseLost = filesWith({
      upload: async (req) => {
        await dropbox.upload(req);
        throw new Error('response lost');
      },
    });

    expect((await sync(false, responseLost)).issues.map((i) => i.path)).toEqual(['/project/a.txt']);
    reopenStore();

    expect(await sync()).toMatchObject({uploaded: 0, downloaded: 0, conflicts: 0, issues: []});
    expect(dropbox.content('/project/a.txt')).toBe('local');
  });

  it('settles after Dropbox deletes a file but the response is lost', async () => {
    dropbox.put('/project/a.txt', 'remote');
    await sync();
    await rm(join(dir, 'a.txt'));
    const responseLost = filesWith({
      deleteV2: async (path, rev) => {
        await dropbox.deleteV2(path, rev);
        throw new Error('response lost');
      },
    });

    expect((await sync(false, responseLost)).issues.map((i) => i.path)).toEqual(['/project/a.txt']);
    reopenStore();

    expect(await sync()).toMatchObject({deletedRemote: 0, deletedLocal: 0, issues: []});
    expect(dropbox.content('/project/a.txt')).toBeUndefined();
  });

  it('stops before deleting more than half of the files', async () => {
    for (let i = 0; i < 25; i++) {
      dropbox.put(`/project/f${i}.txt`, `${i}`);
    }
    await sync();
    for (let i = 0; i < 25; i++) {
      await rm(join(dir, `f${i}.txt`));
    }

    const stopped = await sync();
    expect(stopped.massDelete).toEqual({count: 25, total: 25});
    expect(dropbox.files.size).toBe(25);

    expect(await sync(true)).toMatchObject({deletedRemote: 25});
    expect(dropbox.files.size).toBe(0);
  });

  it('refuses to sync when the project folder is missing', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    await rm(dir, {recursive: true, force: true});

    await expect(sync()).rejects.toThrow('is missing');
    expect(dropbox.files.size).toBe(1);
  });

  it('deletes a locally deleted folder’s files in Dropbox but keeps the folder', async () => {
    dropbox.put('/project/old/a.txt', 'A');
    await sync();
    await rm(join(dir, 'old'), {recursive: true});

    const summary = await sync();

    expect(dropbox.files.size).toBe(0);
    expect(dropbox.folders.has('/project/old')).toBe(true);
    expect(summary.deletedRemote).toBe(1);
    expect(store.row('/project/old')?.deletedHere).toBe(true);
    // It isn't brought back on this computer.
    expect(await sync()).toMatchObject({downloaded: 0, uploaded: 0});
    expect(existsSync(join(dir, 'old'))).toBe(false);
  });

  it('never deletes a file added in Dropbox to a folder being deleted here', async () => {
    dropbox.put('/project/old/a.txt', 'A');
    await sync();
    await rm(join(dir, 'old'), {recursive: true});
    // Another client adds a file while this pass deletes the folder's files.
    dropbox.beforeDelete = () => {
      dropbox.beforeDelete = undefined;
      dropbox.put('/project/old/new.txt', 'from another client');
    };

    await sync();
    expect(dropbox.content('/project/old/new.txt')).toBe('from another client');

    await sync();
    expect(await local('old/new.txt')).toBe('from another client');
    expect(store.row('/project/old')?.deletedHere).toBe(false);
  });

  it('forgets a folder deleted here once it’s gone from Dropbox too', async () => {
    dropbox.put('/project/old/a.txt', 'A');
    await sync();
    await rm(join(dir, 'old'), {recursive: true});
    await sync();
    dropbox.remove('/project/old');

    await sync();

    expect(store.row('/project/old')).toBeUndefined();
  });

  it('counts an empty local folder removed after Dropbox deleted it', async () => {
    await dropbox.createFolder('/project/empty');
    await sync();
    expect(existsSync(join(dir, 'empty'))).toBe(true);
    dropbox.remove('/project/empty');

    const summary = await sync();

    expect(existsSync(join(dir, 'empty'))).toBe(false);
    expect(summary.deletedLocal).toBe(1);
  });

  it('brings a deleted folder back when something new is in it remotely', async () => {
    dropbox.put('/project/shots/a.txt', 'A');
    await sync();
    await rm(join(dir, 'shots'), {recursive: true});
    dropbox.put('/project/shots/new.txt', 'from the agent');

    await sync();
    expect(dropbox.folders.has('/project/shots')).toBe(true);
    expect(dropbox.content('/project/shots/a.txt')).toBeUndefined();
    expect(await local('shots/new.txt')).toBe('from the agent');
  });

  it('never uploads ignored files or its own state folder', async () => {
    await writeLocal('.DS_Store', 'finder');
    await writeLocal('~$draft.docx', 'lock');
    await writeLocal('keep.txt', 'keep');

    await sync();
    expect([...dropbox.files.keys()]).toEqual(['/project/keep.txt']);
  });

  it('leaves AppleDouble ._ files alone on both sides', async () => {
    dropbox.put('/project/._remote.txt', 'attributes');
    await writeLocal('._local.txt', 'attributes');
    await writeLocal('keep.txt', 'keep');

    await sync();
    await sync();

    expect(await local('._remote.txt')).toBeUndefined();
    expect(dropbox.content('/project/._remote.txt')).toBe('attributes');
    expect(dropbox.content('/project/._local.txt')).toBeUndefined();
    expect(dropbox.content('/project/keep.txt')).toBe('keep');
  });

  it('never downloads remote files into its own state folder', async () => {
    dropbox.put('/project/.foldersync/state.db', 'not ours');
    dropbox.put('/project/a.txt', 'A');

    expect(await sync()).toMatchObject({downloaded: 1});
    expect(await local('a.txt')).toBe('A');
    expect(await local('.foldersync/state.db')).not.toBe('not ours');
  });

  it('keeps an unsynced local file that has the conflicted-copy name', async () => {
    dropbox.put('/project/a.txt', 'v1');
    await sync();
    await writeLocal('a.txt', 'mine');
    dropbox.put('/project/a.txt', 'theirs');
    await writeLocal("a (user's conflicted copy).txt", 'unsynced');

    await sync();

    // Dropbox never reuses a name, so every version is kept on both sides.
    expect(await local("a (user's conflicted copy).txt")).toBe('unsynced');
    expect(await local('a.txt')).toBe('theirs');
    expect(await local("a (user's conflicted copy 2).txt")).toBe('mine');
    expect(dropbox.content("/project/a (user's conflicted copy).txt")).toBe('unsynced');
    expect(dropbox.content("/project/a (user's conflicted copy 2).txt")).toBe('mine');
  });

  it('keeps every version through repeated conflicts on one file', async () => {
    dropbox.put('/project/a.txt', 'v1');
    await sync();
    for (const round of [1, 2]) {
      await writeLocal('a.txt', `mine ${round}`);
      dropbox.put('/project/a.txt', `theirs ${round}`);
      await sync();
    }

    expect(await local('a.txt')).toBe('theirs 2');
    expect(dropbox.content("/project/a (user's conflicted copy).txt")).toBe('mine 1');
    expect(dropbox.content("/project/a (user's conflicted copy 2).txt")).toBe('mine 2');
  });

  it('never writes through a symlinked folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    await symlink(outside, join(dir, 'shots'));
    dropbox.put('/project/shots/x.txt', 'x');

    const summary = await sync();

    expect(summary.issues.map((i) => i.path)).toContain('/project/shots');
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, {recursive: true, force: true});
  });

  it('refuses a folder synced with another account', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    expect(store.getAccount()).toBe(ACCOUNT);
    const uploads = dropbox.uploads;

    await expect(
      runSyncPass({api: dropbox, store, localRoot: dir, dropboxRoot: ROOT, accountId: 'pid_user:b'})
    ).rejects.toThrow(/synced with another Dropbox account/);

    expect(await local('a.txt')).toBe('A');
    expect(dropbox.uploads).toBe(uploads);
  });

  it('claims sync state saved before accounts were recorded', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    const db = new DatabaseSync(join(dir, STATE_DIR, 'state.db'));
    db.exec("DELETE FROM meta WHERE key = 'account'");
    db.close();
    expect(store.getAccount()).toBeUndefined();

    await sync();

    expect(store.getAccount()).toBe(ACCOUNT);
  });

  it('drops an issue once its cause is gone', async () => {
    await symlink('/etc/hosts', join(dir, 'link'));
    expect((await sync()).issues.map((i) => i.path)).toEqual(['/project/link']);
    await rm(join(dir, 'link'));

    expect((await sync()).issues).toEqual([]);
  });

  it('syncs the other files when one can’t be read', async () => {
    await writeLocal('locked.txt', 'L');
    await writeLocal('a.txt', 'A');
    await chmod(join(dir, 'locked.txt'), 0o000);

    const summary = await sync();

    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(dropbox.content('/project/locked.txt')).toBeUndefined();
    expect(summary.issues.map((i) => i.path)).toEqual(['/project/locked.txt']);

    await chmod(join(dir, 'locked.txt'), 0o600);
    expect((await sync()).issues).toEqual([]);
    expect(dropbox.content('/project/locked.txt')).toBe('L');
  });

  it('syncs the rest of the project when a folder can’t be read', async () => {
    dropbox.put('/project/locked/keep.txt', 'K');
    await sync();
    await writeLocal('a.txt', 'A');
    await chmod(join(dir, 'locked'), 0o000);

    const summary = await sync();
    await chmod(join(dir, 'locked'), 0o700);

    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(dropbox.content('/project/locked/keep.txt')).toBe('K');
    expect(summary.issues.map((i) => i.path)).toEqual(['/project/locked']);
    expect((await sync()).issues).toEqual([]);
  });

  it('syncs the rest of the project when a folder’s items can’t be read', async () => {
    dropbox.put('/project/listed/keep.txt', 'K');
    await sync();
    await writeLocal('a.txt', 'A');
    // Listing works without search permission, but reading each item doesn't.
    await chmod(join(dir, 'listed'), 0o400);

    const summary = await sync();
    await chmod(join(dir, 'listed'), 0o700);

    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(dropbox.content('/project/listed/keep.txt')).toBe('K');
    expect(summary.issues.map((i) => i.path)).toEqual(['/project/listed/keep.txt']);
  });

  it('keeps a synced file in Dropbox after it is replaced by a symlink', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    await rm(join(dir, 'a.txt'));
    await symlink('/etc/hosts', join(dir, 'a.txt'));

    const summary = await sync();

    expect(summary.deletedRemote).toBe(0);
    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(summary.issues.map((i) => i.path)).toContain('/project/a.txt');
  });

  it('stops instead of deleting through a symlinked old_files folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(dir, STATE_DIR, 'old_files'));

    await expect(sync()).rejects.toThrow(/link or a file/);
    expect(await readdir(outside)).toEqual(['keep.txt']);
    await rm(outside, {recursive: true, force: true});
  });

  it('leaves a file edited during a conflicted upload for the next pass', async () => {
    dropbox.put('/project/a.txt', 'v1');
    await sync();
    await writeLocal('a.txt', 'mine');
    dropbox.put('/project/a.txt', 'theirs');
    dropbox.afterUpload = () => writeLocal('a.txt', 'newer');

    const summary = await sync();

    expect(await local('a.txt')).toBe('newer');
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(
      /changed while it was being uploaded/
    );
  });

  it('keeps a folder’s files in Dropbox when the folder is replaced by a file locally', async () => {
    dropbox.put('/project/shots/a.txt', 'A');
    await sync();
    await rm(join(dir, 'shots'), {recursive: true});
    await writeLocal('shots', 'now a file');

    const summary = await sync();

    expect(summary.deletedRemote).toBe(0);
    expect(dropbox.content('/project/shots/a.txt')).toBe('A');
    expect(summary.issues.map((i) => i.path)).toContain('/project/shots');
  });

  it('syncs a path that was replaced by a folder on both sides', async () => {
    dropbox.put('/project/shots', 'a file');
    await sync();
    await rm(join(dir, 'shots'));
    await writeLocal('shots/mine.txt', 'M');
    dropbox.remove('/project/shots');
    dropbox.put('/project/shots/theirs.txt', 'T');

    const summary = await sync();

    expect(summary.issues).toEqual([]);
    expect(dropbox.content('/project/shots/mine.txt')).toBe('M');
    expect(await local('shots/theirs.txt')).toBe('T');
  });

  it('forgets the saved cursor before it changes anything', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    await sync();
    expect(store.getCursor()).toBeDefined();
    await writeLocal('b.txt', 'B');
    let cursorDuringUpload: string | undefined = 'not checked';
    dropbox.afterUpload = async () => {
      cursorDuringUpload = store.getCursor();
    };

    await sync();

    expect(cursorDuringUpload).toBeUndefined();
  });

  it('uses Dropbox’s name for a file whose name differs only in case', async () => {
    dropbox.put('/project/Photo.txt', 'theirs');
    await writeLocal('photo.txt', 'mine');

    expect(await sync()).toMatchObject({conflicts: 1});

    const names = (await readdir(dir)).filter((n) => /^photo/i.test(n)).sort();
    expect(names).toEqual(['Photo.txt', 'photo (1).txt']);
    expect(await local('Photo.txt')).toBe('theirs');
    expect(await local('photo (1).txt')).toBe('mine');
  });

  it('keeps a local edit saved while a newer version downloads', async () => {
    dropbox.put('/project/a.txt', 'v1');
    await sync();
    dropbox.put('/project/a.txt', 'theirs');
    dropbox.afterDownload = () => writeLocal('a.txt', 'mine, saved during the download');

    const summary = await sync();

    expect(await local('a.txt')).toBe('mine, saved during the download');
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(
      /changed while it was being downloaded/
    );
    dropbox.afterDownload = undefined;
    expect(await sync()).toMatchObject({conflicts: 1});
  });

  it('backs up a file with a long CJK name before deleting it', async () => {
    const name = `${'漢'.repeat(80)}.txt`;
    dropbox.put(`/project/${name}`, 'A');
    await sync();
    dropbox.remove(`/project/${name}`);

    const summary = await sync();

    expect(summary).toMatchObject({deletedLocal: 1, issues: []});
    const backups = await readdir(join(dir, STATE_DIR, 'old_files'));
    expect(backups.some((n) => n.endsWith('漢.txt'))).toBe(true);
  });

  it('never uploads the state folder when it is spelled .FolderSync', async () => {
    await rename(join(dir, STATE_DIR), join(dir, '.FolderSync'));
    await writeLocal('.FolderSync/notes.txt', 'private');
    await writeLocal('a.txt', 'A');

    expect(await sync()).toMatchObject({uploaded: 1});
    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(dropbox.content('/project/.FolderSync/notes.txt')).toBeUndefined();
  });

  it('saves the downloaded file’s stat from after it is installed', async () => {
    dropbox.put('/project/a.txt', 'A');

    await sync();

    expect(store.row('/project/a.txt')?.stat).toEqual(await statOrUndefined(join(dir, 'a.txt')));
  });

  it('counts deleted folders when asking before deleting most of a project', async () => {
    for (let i = 0; i < 25; i++) {
      await mkdir(join(dir, `folder-${i}`));
    }
    await sync();
    for (let i = 0; i < 25; i++) {
      await rm(join(dir, `folder-${i}`), {recursive: true});
    }

    const summary = await sync();

    expect(summary.massDelete).toEqual({count: 25, total: 25});
  });

  it('keeps a local folder that has something new in it, and says why', async () => {
    await mkdir(join(dir, 'shots'));
    await sync();
    dropbox.remove('/project/shots');
    await writeLocal('shots/new.txt', 'new');

    const summary = await sync();

    expect(await local('shots/new.txt')).toBe('new');
    expect(summary.issues.map((i) => i.message)).toContain(
      'The folder wasn’t deleted because something new is in it.'
    );
  });

  it('renames a local file renamed in case only in Dropbox', async () => {
    dropbox.put('/project/photo.txt', 'P');
    await sync();
    dropbox.renameCase('/project/photo.txt', '/project/Photo.txt');

    await sync();

    expect((await readdir(dir)).filter((n) => /photo/i.test(n))).toEqual(['Photo.txt']);
    expect(await local('Photo.txt')).toBe('P');
    expect(await sync()).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
    });
  });

  it('takes Dropbox’s new case for a file also changed in Dropbox', async () => {
    dropbox.put('/project/photo.txt', 'P');
    await sync();
    dropbox.renameCase('/project/photo.txt', '/project/Photo.txt');
    dropbox.put('/project/Photo.txt', 'P2');

    expect(await sync()).toMatchObject({downloaded: 1});

    expect((await readdir(dir)).filter((n) => /photo/i.test(n))).toEqual(['Photo.txt']);
    expect(await local('Photo.txt')).toBe('P2');
    expect(await sync()).toMatchObject({uploaded: 0, downloaded: 0});
  });

  it('won’t install a download that Dropbox says is somewhere else', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    dropbox.put('/project/a.txt', 'A2');
    const download = dropbox.downloadToFile.bind(dropbox);
    dropbox.downloadToFile = async (path, dest) => ({
      ...(await download(path, dest)),
      pathDisplay: '/other/a.txt',
    });

    const summary = await sync();

    expect(summary.downloaded).toBe(0);
    expect(await local('a.txt')).toBe('A');
    expect(store.row('/project/a.txt')).toBeDefined();
    expect(store.row('/other/a.txt')).toBeUndefined();
  });

  it('renames a local folder renamed in case only in Dropbox', async () => {
    dropbox.put('/project/shots/a.txt', 'A');
    await sync();
    dropbox.renameCase('/project/shots', '/project/Shots');

    await sync();

    expect((await readdir(dir)).filter((n) => /shots/i.test(n))).toEqual(['Shots']);
    expect(await local('Shots/a.txt')).toBe('A');
    expect(await sync()).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
    });
  });

  it('syncs an edit made after the scan to a file in a folder renamed in case only', async () => {
    dropbox.put('/project/shots/a.txt', 'A');
    await sync();
    // a0.txt downloads before the rename reaches shots/a.txt.
    dropbox.put('/project/a0.txt', 'new');
    dropbox.renameCase('/project/shots', '/project/Shots');
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      await writeLocal('shots/a.txt', 'edited after the scan');
    };

    await sync();
    await sync();

    expect(dropbox.content('/project/Shots/a.txt')).toBe('edited after the scan');
  });

  it('won’t delete a file whose folder was swapped for a link to outside the project', async () => {
    dropbox.put('/project/shots/a.txt', 'A');
    await sync();
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    dropbox.remove('/project/shots/a.txt');
    // b.txt downloads before the delete, and the swap happens then.
    dropbox.put('/project/b.txt', 'B');
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      await rename(join(dir, 'shots'), join(outside, 'shots'));
      await symlink(join(outside, 'shots'), join(dir, 'shots'));
    };

    const summary = await sync();

    expect(await readFile(join(outside, 'shots', 'a.txt'), 'utf8')).toBe('A');
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(/outside the project/);
    await rm(outside, {recursive: true, force: true});
  });

  it('won’t upload a file whose folder was swapped for a link to outside the project', async () => {
    dropbox.put('/project/shots/keep.txt', 'K');
    await sync();
    await writeLocal('shots/new.txt', 'private');
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    // a0.txt downloads before the upload, and the swap happens then.
    dropbox.put('/project/a0.txt', 'new');
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      await rename(join(dir, 'shots'), join(outside, 'shots'));
      await symlink(join(outside, 'shots'), join(dir, 'shots'));
    };

    const summary = await sync();

    expect(dropbox.content('/project/shots/new.txt')).toBeUndefined();
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(/outside the project/);
    await rm(outside, {recursive: true, force: true});
  });

  it('stops writing when the project folder is swapped for a link during the pass', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    const moved = `${dir}-moved`;
    dropbox.put('/project/b.txt', 'B');
    dropbox.put('/project/c.txt', 'C');
    // After b.txt downloads, the project folder becomes a link to its old self.
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      await rename(dir, moved);
      await symlink(moved, dir);
    };

    const summary = await sync();

    expect(existsSync(join(moved, 'c.txt'))).toBe(false);
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(/project folder changed/);
    await rm(dir, {force: true});
    await rename(moved, dir);
  });

  it('deletes nothing in Dropbox when the project folder is replaced before the scan', async () => {
    dropbox.put('/project/a.txt', 'A');
    dropbox.put('/project/b.txt', 'B');
    await sync();
    const moved = `${dir}-moved`;
    // The real folder moves away and an empty one takes its place.
    dropbox.beforeList = async () => {
      dropbox.beforeList = undefined;
      await rename(dir, moved);
      await mkdir(dir);
    };

    const summary = await sync();

    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(dropbox.content('/project/b.txt')).toBe('B');
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(/project folder changed/);
    await rm(dir, {recursive: true, force: true});
    await rename(moved, dir);
  });

  it('won’t remove an empty folder whose parent was swapped for a link outside', async () => {
    await mkdir(join(dir, 'shots', 'empty'), {recursive: true});
    await sync();
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    dropbox.remove('/project/shots/empty');
    dropbox.put('/project/b.txt', 'B');
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      await rename(join(dir, 'shots'), join(outside, 'shots'));
      await symlink(join(outside, 'shots'), join(dir, 'shots'));
    };

    await sync();

    expect(existsSync(join(outside, 'shots', 'empty'))).toBe(true);
    await rm(outside, {recursive: true, force: true});
  });

  it('won’t back up a file into an old_files folder swapped for a link outside', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    dropbox.remove('/project/a.txt');
    // b.txt downloads before the delete, and the swap happens then.
    dropbox.put('/project/b.txt', 'B');
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      const oldFiles = join(dir, STATE_DIR, 'old_files');
      await rm(oldFiles, {recursive: true});
      await symlink(outside, oldFiles);
    };

    const summary = await sync();

    expect(await local('a.txt')).toBe('A');
    expect(await readdir(outside)).toEqual([]);
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(/changed during the sync/);
    await rm(outside, {recursive: true, force: true});
  });

  it('won’t use or delete a download through a new_files swapped for a link', async () => {
    dropbox.put('/project/a.txt', 'A');
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    // Swap new_files for a link to a folder holding a file of the same name.
    dropbox.afterDownload = async () => {
      dropbox.afterDownload = undefined;
      const newFiles = join(dir, STATE_DIR, 'new_files');
      const [name] = await readdir(newFiles);
      await writeFile(join(outside, name ?? ''), 'not ours');
      await rm(newFiles, {recursive: true});
      await symlink(outside, newFiles);
    };

    const summary = await sync();

    expect(await local('a.txt')).toBeUndefined();
    const left = await readdir(outside);
    expect(left).toHaveLength(1);
    expect(await readFile(join(outside, left[0] ?? ''), 'utf8')).toBe('not ours');
    expect(summary.issues.map((i) => i.message).join(' ')).toMatch(/changed during the sync/);
    await rm(outside, {recursive: true, force: true});
  });

  it('won’t purge old backups through an old_files swapped for a link', async () => {
    const oldFiles = join(dir, STATE_DIR, 'old_files');
    const name = '1000-old-backup.txt';
    await mkdir(oldFiles, {recursive: true});
    await writeFile(join(oldFiles, name), 'old');
    const outside = await mkdtemp(join(tmpdir(), 'foldersync-outside-'));
    await writeFile(join(outside, name), 'not ours');
    let swapped = false;

    // The purge asks for the time after listing old_files, before deleting.
    const pass = runSyncPass({
      api: dropbox,
      store,
      localRoot: dir,
      dropboxRoot: ROOT,
      accountId: ACCOUNT,
      now: () => {
        if (!swapped) {
          swapped = true;
          execFileSync('mv', [oldFiles, `${oldFiles}-moved`]);
          execFileSync('ln', ['-s', outside, oldFiles]);
        }
        return new Date();
      },
    });

    await expect(pass).rejects.toThrow(/changed during the sync/);
    expect(await readFile(join(outside, name), 'utf8')).toBe('not ours');
    await rm(outside, {recursive: true, force: true});
  });

  it('refuses a sync state that points outside the project', async () => {
    await dropbox.createFolder('/other-project/empty');
    store.put({
      pathLower: '/other-project/empty',
      pathDisplay: '/other-project/empty',
      kind: 'folder',
      id: 'id:other',
      rev: '',
      contentHash: '',
      stat: undefined,
      uploadFailed: false,
    });
    store.setCursor('saved');

    await expect(sync()).rejects.toThrow(/isn’t in this project/);

    expect(dropbox.folders.has('/other-project/empty')).toBe(true);
  });

  it('downloads a file again when Dropbox changes it just before a delete', async () => {
    dropbox.put('/project/a.txt', 'v1');
    await sync();
    await rm(join(dir, 'a.txt'));
    dropbox.beforeDelete = () => {
      dropbox.beforeDelete = undefined;
      dropbox.put('/project/a.txt', 'newer');
    };

    await sync();

    expect(await local('a.txt')).toBe('newer');
    expect(dropbox.content('/project/a.txt')).toBe('newer');
  });

  it('matches paths by their own key, whatever path_lower Dropbox sends', async () => {
    await writeLocal('a.txt', 'A');
    await sync();
    // A listing whose path_lower disagrees with the display path.
    const skewed = (res: Awaited<ReturnType<FakeDropbox['listFolder']>>) => ({
      ...res,
      entries: res.entries.map((e) => ({...e, pathLower: `${e.pathLower}-skewed`})),
    });
    const api = {
      ...dropbox,
      listFolder: async (path: string, recursive: boolean) =>
        skewed(await dropbox.listFolder(path, recursive)),
      listFolderContinue: async (cursor: string) =>
        skewed(await dropbox.listFolderContinue(cursor)),
      downloadToFile: dropbox.downloadToFile.bind(dropbox),
      upload: dropbox.upload.bind(dropbox),
      deleteV2: dropbox.deleteV2.bind(dropbox),
      createFolder: dropbox.createFolder.bind(dropbox),
    };

    const summary = await runSyncPass({
      api,
      store,
      localRoot: dir,
      dropboxRoot: ROOT,
      accountId: ACCOUNT,
      allowMassDelete: false,
      fullListing: true,
    });

    expect(summary).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
    });
  });

  it('clears downloads left behind by a pass that didn’t finish', async () => {
    await mkdir(join(dir, STATE_DIR, 'new_files'), {recursive: true});
    await writeFile(join(dir, STATE_DIR, 'new_files', 'abandoned'), 'partial');

    await sync();

    expect(await readdir(join(dir, STATE_DIR, 'new_files'))).toEqual([]);
  });

  it('keeps the backup of an old file for the retention period', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, 'a.txt'), old, old);
    await sync();
    dropbox.remove('/project/a.txt');
    expect(await sync()).toMatchObject({deletedLocal: 1});

    await sync();

    const backups = await readdir(join(dir, STATE_DIR, 'old_files'));
    expect(backups.some((name) => name.endsWith('a.txt'))).toBe(true);
  });

  it('syncs files under a path once whatever blocked it is gone', async () => {
    dropbox.put('/project/shots/a.txt', 'A');
    await symlink('/tmp', join(dir, 'shots'));
    await sync();
    await rm(join(dir, 'shots'));

    expect(await sync()).toMatchObject({downloaded: 1});
    expect(await local('shots/a.txt')).toBe('A');
  });

  it('keeps a synced file in Dropbox after it is replaced by a FIFO', async () => {
    dropbox.put('/project/a.txt', 'A');
    await sync();
    await rm(join(dir, 'a.txt'));
    execFileSync('mkfifo', [join(dir, 'a.txt')]);

    const summary = await sync();

    expect(summary.deletedRemote).toBe(0);
    expect(dropbox.content('/project/a.txt')).toBe('A');
    expect(summary.issues.map((i) => i.message)).toContain('Only files and folders are synced.');
  });

  it('refuses to sync a project folder that is a symlink', async () => {
    const real = await mkdtemp(join(tmpdir(), 'foldersync-real-'));
    const link = join(await mkdtemp(join(tmpdir(), 'foldersync-link-')), 'project');
    await symlink(real, link);
    const linked = runSyncPass({
      api: dropbox,
      store,
      localRoot: link,
      dropboxRoot: ROOT,
      accountId: ACCOUNT,
      allowMassDelete: false,
    });

    await expect(linked).rejects.toThrow(/is a link or a file/);
    await rm(real, {recursive: true, force: true});
  });
});
