// Projects across account switches and project renames, with the real
// coordinator, settings, and SQLite sync state.
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {Settings} from '../src/main/config';
import {ProjectClients, type UserApi} from '../src/main/projectClients';
import {Projects} from '../src/main/projects';
import {FakeDropbox} from './fakeDropbox';
import {FakeRpc, memoryDirectory} from './fakeRpc';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-lifecycle-'));
  process.env.FOLDERSYNC_PROJECTS = join(dir, 'projects');
});

afterEach(async () => {
  delete process.env.FOLDERSYNC_PROJECTS;
  await rm(dir, {recursive: true, force: true});
});

function api(dropbox: FakeDropbox): UserApi {
  const rpc = new FakeRpc({});
  return {
    listFolder: dropbox.listFolder.bind(dropbox),
    listFolderContinue: dropbox.listFolderContinue.bind(dropbox),
    downloadToFile: dropbox.downloadToFile.bind(dropbox),
    upload: dropbox.upload.bind(dropbox),
    deleteV2: dropbox.deleteV2.bind(dropbox),
    createFolder: dropbox.createFolder.bind(dropbox),
    rpc: (route, arg, opts) => rpc.rpc(route, arg, opts),
  };
}

// Projects for whichever account current() names, each with its own Dropbox.
async function projectsFor(
  accounts: Map<string, FakeDropbox>,
  current: () => string
): Promise<Projects> {
  const dropbox = (): FakeDropbox => {
    const d = accounts.get(current());
    if (!d) {
      throw new Error(`no Dropbox for ${current()}`);
    }
    return d;
  };
  const userApi = (): UserApi => api(dropbox());
  return new Projects({
    settings: await Settings.load(join(dir, 'settings.json')),
    clients: new ProjectClients(
      userApi,
      () => memoryDirectory({'/storyboard': 'agent-1'}),
      () => dropbox()
    ),
    userApi,
    accountId: () => `pid_user:${current()}`,
    onStatus: () => {},
    onActivity: () => {},
  });
}

describe('project lifetime', () => {
  it('won’t sync one account’s project folder into another account', async () => {
    const a = new FakeDropbox();
    const b = new FakeDropbox();
    await a.createFolder('/storyboard');
    await b.createFolder('/storyboard');
    a.put('/storyboard/from-a.txt', 'only account A has this');
    b.put('/storyboard/from-b.txt', 'only account B has this');
    let user = 'a';
    const projects = await projectsFor(
      new Map([
        ['a', a],
        ['b', b],
      ]),
      () => user
    );
    await projects.list();
    await projects.sync('storyboard', false);
    const folder = projects.info('storyboard').localDir;
    await writeFile(join(folder, 'a-draft.txt'), 'private A draft');

    user = 'b';
    await projects.list();

    await expect(projects.sync('storyboard', false)).rejects.toThrow(/another Dropbox account/);
    expect(b.content('/storyboard/a-draft.txt')).toBeUndefined();
    expect(await readFile(join(folder, 'from-a.txt'), 'utf8')).toBe('only account A has this');
    expect(await readFile(join(folder, 'a-draft.txt'), 'utf8')).toBe('private A draft');
  });

  it('keeps a chosen folder after the project is renamed only in case', async () => {
    const dropbox = new FakeDropbox();
    await dropbox.createFolder('/Storyboard');
    dropbox.put('/Storyboard/a.txt', 'remote');
    const projects = await projectsFor(new Map([['a', dropbox]]), () => 'a');
    const folder = join(dir, 'chosen-folder');
    await projects.list();
    await projects.setLocalDir('Storyboard', folder);

    dropbox.renameCase('/Storyboard', '/storyboard');
    await projects.list();

    expect(await projects.sync('storyboard', false)).toMatchObject({downloaded: 1});
    expect(projects.info('storyboard').localDir).toBe(folder);
    expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('remote');
  });
});
