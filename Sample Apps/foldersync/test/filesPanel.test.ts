import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {DropboxFiles} from '../src/engine/dropboxApi';
import {statOrUndefined} from '../src/engine/localScan';
import {STATE_DIR} from '../src/engine/paths';
import {StateStore} from '../src/engine/stateStore';
import {Settings} from '../src/main/config';
import {FilesPanel} from '../src/main/filesPanel';
import {ProjectClients, type UserApi} from '../src/main/projectClients';
import type {RemoteEntry} from '../src/shared/types';
import {memoryDirectory} from './fakeRpc';

let dir: string;
let projectDir: string;
let downloads: string[];
let panel: FilesPanel;
// The fake Dropbox behind the panel; a test can replace its methods.
let files: DropboxFiles;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-panel-'));
  projectDir = join(dir, 'storyboard');
  await mkdir(join(projectDir, STATE_DIR), {recursive: true});
  downloads = [];
  const settings = await Settings.load(join(dir, 'settings.json'));
  settings.setLocalDir('storyboard', projectDir);
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  files = {
    listFolder: unused,
    listFolderContinue: unused,
    downloadToFile: async (path, dest) => {
      downloads.push(path);
      await writeFile(dest, 'downloaded');
      return {
        tag: 'file',
        id: 'id:a',
        pathLower: path.toLowerCase(),
        pathDisplay: path,
        rev: 'r1',
        contentHash: '',
        size: 10,
        clientModified: new Date(),
        serverModified: new Date(),
      };
    },
    upload: unused,
    deleteV2: unused,
    createFolder: unused,
  };
  const userApi = (): UserApi => ({...files, rpc: unused});
  panel = new FilesPanel(
    settings,
    new ProjectClients(userApi, () => memoryDirectory()),
    userApi,
    () => 'pid_user:a'
  );
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

// Records a local file as synced at rev r1.
async function recordSynced(rel: string): Promise<void> {
  const store = new StateStore(join(projectDir, STATE_DIR, 'state.db'));
  try {
    store.put({
      pathLower: `/storyboard/${rel}`.toLowerCase(),
      pathDisplay: `/storyboard/${rel}`,
      kind: 'file',
      id: 'id:a',
      rev: 'r1',
      contentHash: '',
      stat: await statOrUndefined(join(projectDir, rel)),
      uploadFailed: false,
    });
  } finally {
    store.close();
  }
}

function entry(rel: string, status: RemoteEntry['status']): RemoteEntry {
  return {
    kind: 'file',
    name: rel.split('/').pop() ?? rel,
    path: `/storyboard/${rel}`,
    rev: 'r1',
    status,
    onComputer: true,
  };
}

describe('FilesPanel', () => {
  it('opens the synced local copy', async () => {
    await writeFile(join(projectDir, 'a.txt'), 'local');
    await recordSynced('a.txt');

    expect(await panel.fileToOpen('storyboard', entry('a.txt', 'synced'))).toBe(
      join(projectDir, 'a.txt')
    );
    expect(downloads).toEqual([]);
  });

  it('ignores sync state recorded for another account', async () => {
    await writeFile(join(projectDir, 'a.txt'), 'local');
    await recordSynced('a.txt');
    const store = new StateStore(join(projectDir, STATE_DIR, 'state.db'));
    store.setAccount('pid_user:b');
    store.close();

    const opened = await panel.fileToOpen('storyboard', entry('a.txt', 'synced'));

    expect(opened).not.toBe(join(projectDir, 'a.txt'));
    expect(downloads).toEqual(['/storyboard/a.txt']);
    panel.removeOpenCopies();
  });

  it('leaves out folders deleted on this computer, which stay in Dropbox', async () => {
    const folder = (name: string) => ({
      tag: 'folder' as const,
      id: `id:${name}`,
      pathLower: `/storyboard/${name}`,
      pathDisplay: `/storyboard/${name}`,
    });
    files.listFolder = async () => ({
      entries: [folder('kept'), folder('deleted-here')],
      cursor: 'c1',
      hasMore: false,
    });
    const store = new StateStore(join(projectDir, STATE_DIR, 'state.db'));
    store.put({
      pathLower: '/storyboard/deleted-here',
      pathDisplay: '/storyboard/deleted-here',
      kind: 'folder',
      id: '',
      rev: '',
      contentHash: '',
      uploadFailed: false,
      deletedHere: true,
    });
    store.close();

    const entries = await panel.list('storyboard');

    expect(entries.map((e) => e.name)).toEqual(['kept']);
  });

  it('downloads a copy when the local file isn’t synced, whatever the window says', async () => {
    await writeFile(join(projectDir, 'a.txt'), 'local, never synced');

    const opened = await panel.fileToOpen('storyboard', entry('a.txt', 'synced'));

    expect(opened).not.toBe(join(projectDir, 'a.txt'));
    expect(downloads).toEqual(['/storyboard/a.txt']);
    panel.removeOpenCopies();
  });

  it('names the downloaded copy after the Dropbox path, not the window’s name', async () => {
    const opened = await panel.fileToOpen('storyboard', {
      ...entry('a.txt', 'not-synced'),
      name: 'payload.exe',
    });

    expect(opened.endsWith(`${'/'}a.txt`)).toBe(true);
    panel.removeOpenCopies();
  });

  it('won’t read the sync database through a .foldersync link', async () => {
    const outside = join(dir, 'outside-state');
    await mkdir(outside);
    await rm(join(projectDir, STATE_DIR), {recursive: true});
    await symlink(outside, join(projectDir, STATE_DIR));

    await expect(panel.fileToOpen('storyboard', entry('a.txt', 'synced'))).rejects.toThrow(
      /is a link/
    );
  });

  it.each(['state.db', 'state.db-wal'])(
    'won’t open the sync database when %s links outside',
    async (file) => {
      const outside = join(dir, 'outside.db');
      await writeFile(outside, '');
      await writeFile(join(projectDir, STATE_DIR, 'state.db'), '');
      await rm(join(projectDir, STATE_DIR, file), {force: true});
      await symlink(outside, join(projectDir, STATE_DIR, file));

      await expect(panel.fileToOpen('storyboard', entry('a.txt', 'synced'))).rejects.toThrow(
        /is a link/
      );
      expect(await readFile(outside, 'utf8')).toBe('');
    }
  );

  it('never opens or reveals a file through a symlink out of the project', async () => {
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(projectDir, 'link'));
    await recordSynced('link/secret.txt');

    const opened = await panel.fileToOpen('storyboard', entry('link/secret.txt', 'synced'));

    expect(await realpath(opened)).not.toBe(await realpath(join(outside, 'secret.txt')));
    expect(await readFile(opened, 'utf8')).toBe('downloaded');
    expect(downloads).toEqual(['/storyboard/link/secret.txt']);
    await expect(panel.fileToReveal('storyboard', '/storyboard/link/secret.txt')).rejects.toThrow(
      /isn’t in this project/
    );
    panel.removeOpenCopies();
  });
});
