import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {Settings} from '../src/main/config';
import {ProjectClients, type UserApi} from '../src/main/projectClients';
import {Projects} from '../src/main/projects';
import type {SyncStatus} from '../src/shared/types';
import type {DropboxFiles} from '../src/engine/dropboxApi';
import {FakeRpc, agent, memoryDirectory} from './fakeRpc';

const WAIT_MS = 10 * 60 * 1000;
const STATUS = 'agent_filesystem/agents/restore_writes/status';

let dir: string;
let statuses: SyncStatus[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-projects-'));
  process.env.FOLDERSYNC_PROJECTS = join(dir, 'projects');
  statuses = [];
});

afterEach(async () => {
  delete process.env.FOLDERSYNC_PROJECTS;
  await rm(dir, {recursive: true, force: true});
});

function userApi(rpc: FakeRpc): UserApi {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    listFolder: unused,
    listFolderContinue: unused,
    downloadToFile: unused,
    upload: unused,
    deleteV2: unused,
    createFolder: unused,
    rpc: (route, arg, opts) => rpc.rpc(route, arg, opts),
  };
}

// Projects with a fake Dropbox whose undo status comes from undoState().
// Poll sleeps return on the next tick; the long wait returns when releaseWait() is called.
// undoState can return an Error to make a status check fail.
async function setup(
  undoState: () => string | Error,
  agentDelete: () => Promise<void> = async () => {},
  createFolder?: () => Promise<void>
): Promise<{projects: Projects; releaseWait: () => void}> {
  const rpc = new FakeRpc({
    'agent_filesystem/agents/list': [{agents: [agent('a1', [['/storyboard', 'read_write']])]}],
    'agent_filesystem/agents/restore_writes': [{cursor: 'undo-1'}],
    [STATUS]: () => {
      const state = undoState();
      return state instanceof Error
        ? state
        : {status: {'.tag': `restore_agent_writes_status_${state}`}};
    },
  });
  let releaseWait = (): void => {};
  const waited = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const settings = await Settings.load(join(dir, 'settings.json'));
  const api = (): UserApi => ({
    ...userApi(rpc),
    ...(createFolder && {createFolder: async () => createFolder()}),
  });
  const agentFiles: DropboxFiles = {...userApi(rpc), deleteV2: () => agentDelete()};
  const projects = new Projects({
    settings,
    clients: new ProjectClients(
      api,
      () => memoryDirectory({'/storyboard': 'a1'}),
      () => agentFiles
    ),
    userApi: api,
    accountId: () => 'pid_user:a',
    onStatus: (_project, status) => statuses.push(status),
    onActivity: () => {},
    sleep: (ms) => (ms === WAIT_MS ? waited : new Promise((resolve) => setTimeout(resolve, 0))),
  });
  return {projects, releaseWait};
}

// Retries an action until it succeeds, for state that changes in the background.
async function eventually(action: () => Promise<void>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await action();
    } catch (err) {
      if (i === 200) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe('Projects.undo', () => {
  it('returns when Dropbox finishes the undo', async () => {
    let polls = 0;
    const {projects} = await setup(() => (++polls < 3 ? 'in_progress' : 'complete'));

    await projects.undo('storyboard', 1_792_614_782_000_000);

    expect(polls).toBe(3);
    expect(statuses[0]).toEqual({kind: 'syncing', step: 'Undoing changes in Dropbox…'});
    expect(statuses.at(-1)).toEqual({kind: 'idle', message: 'The undo finished in Dropbox.'});
  });

  it('reports a failed undo', async () => {
    const {projects} = await setup(() => 'failed');

    await expect(projects.undo('storyboard', 1_792_614_782_000_000)).rejects.toThrow(
      /couldn’t finish the undo/
    );
    expect(statuses.at(-1)?.kind).toBe('error');
  });

  it('keeps sync paused while an undo is still running after the wait', async () => {
    let state = 'in_progress';
    const {projects, releaseWait} = await setup(() => state);

    const undo = projects.undo('storyboard', 1_792_614_782_000_000);
    releaseWait();
    await expect(undo).rejects.toThrow(/still running in Dropbox/);
    await expect(projects.sync('storyboard', false)).rejects.toThrow(/Wait for the undo/);
    await expect(projects.remove('storyboard')).rejects.toThrow(/Wait for the sync/);
    expect(() => projects.requireAllIdle()).toThrow(/Wait for the undo in “storyboard”/);
    await expect(projects.setLocalDir('storyboard', join(dir, 'elsewhere'))).rejects.toThrow(
      /Wait for the sync/
    );

    // Once the background check sees the undo finish, the project is unblocked.
    state = 'complete';
    await eventually(() => projects.remove('storyboard'));
    projects.requireAllIdle();
    expect(statuses.at(-1)).toEqual({
      kind: 'idle',
      message: 'The undo finished in Dropbox. Press Sync now to get the result.',
    });
  });

  it('stays paused through failed status checks until Dropbox answers', async () => {
    let state: string | Error = 'in_progress';
    const {projects, releaseWait} = await setup(() => state);

    const undo = projects.undo('storyboard', 1_792_614_782_000_000);
    releaseWait();
    await expect(undo).rejects.toThrow(/still running/);
    state = new Error('offline');
    const offline = (st: SyncStatus): boolean =>
      st.kind === 'error' && st.message.startsWith('Can’t check the undo: offline');
    await eventually(async () => {
      if (!statuses.some(offline)) {
        throw new Error('not shown yet');
      }
    });
    await expect(projects.remove('storyboard')).rejects.toThrow(/Wait for the sync/);

    state = 'failed';
    await eventually(() => projects.remove('storyboard'));
    expect(statuses.at(-1)).toEqual({
      kind: 'error',
      message: 'Dropbox couldn’t finish the undo. Some changes may be undone; check the list.',
    });
  });
});

describe('Projects.setLocalDir', () => {
  it('keeps the previous folder when settings can’t be saved', async () => {
    const {projects} = await setup(() => 'complete');
    await projects.setLocalDir('storyboard', join(dir, 'first'));
    // settings.json can't be replaced once it's a folder.
    await rm(join(dir, 'settings.json'));
    await mkdir(join(dir, 'settings.json'));

    await expect(projects.setLocalDir('storyboard', join(dir, 'second'))).rejects.toThrow();
    expect(projects.info('storyboard').localDir).toBe(join(dir, 'first'));
  });
});

describe('Projects.delete', () => {
  it('blocks sync until the delete finishes', async () => {
    let finishDelete = (): void => {};
    const {projects} = await setup(
      () => 'complete',
      () =>
        new Promise((resolve) => {
          finishDelete = resolve;
        })
    );

    const deleting = projects.delete('storyboard');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(projects.sync('storyboard', false)).rejects.toThrow(/Wait for the delete/);

    finishDelete();
    await deleting;
    await expect(projects.remove('storyboard')).resolves.toBeUndefined();
  });
});

describe('Projects.duringAccountChange', () => {
  it('refuses project actions while an account change runs', async () => {
    const {projects} = await setup(() => 'complete');
    let finish = (): void => {};
    const change = projects.duringAccountChange(
      () => new Promise<void>((resolve) => (finish = resolve))
    );

    await expect(projects.sync('storyboard', false)).rejects.toThrow(/account change/);
    await expect(projects.remove('storyboard')).rejects.toThrow(/account change/);
    await expect(projects.create('trailer')).rejects.toThrow(/account change/);

    finish();
    await change;
    await expect(projects.remove('storyboard')).resolves.toBeUndefined();
  });

  it('waits for a project being created before changing the account', async () => {
    let finish = (): void => {};
    const {projects} = await setup(
      () => 'complete',
      undefined,
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    const creating = projects.create('trailer');

    await expect(projects.duringAccountChange(async () => {})).rejects.toThrow(
      /Wait for the project creation in “trailer”/
    );

    finish();
    await creating;
    await expect(projects.duringAccountChange(async () => {})).resolves.toBeUndefined();
  });

  it('refuses a second account change while one runs', async () => {
    const {projects} = await setup(() => 'complete');
    let finish = (): void => {};
    const first = projects.duringAccountChange(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    let ran = false;

    await expect(
      projects.duringAccountChange(async () => {
        ran = true;
      })
    ).rejects.toThrow(/account change/);

    expect(ran).toBe(false);
    finish();
    await first;
  });
});

describe('Projects.exclusive', () => {
  it('waits for an undo, and blocks sync while it runs', async () => {
    let state = 'in_progress';
    const {projects, releaseWait} = await setup(() => state);
    const undo = projects.undo('storyboard', 1_792_614_782_000_000);
    releaseWait();
    await expect(undo).rejects.toThrow(/still running in Dropbox/);
    let ran = false;

    await expect(
      projects.exclusive('storyboard', 'file delete', async () => {
        ran = true;
      })
    ).rejects.toThrow(/Wait for the sync/);
    expect(ran).toBe(false);

    state = 'complete';
    await eventually(() => projects.exclusive('storyboard', 'file delete', async () => {}));
    let release = (): void => {};
    const deleting = projects.exclusive(
      'storyboard',
      'file delete',
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await expect(projects.sync('storyboard', false)).rejects.toThrow(/Wait for the file delete/);
    release();
    await deleting;
  });
});

describe('Projects.setLocalDir folders', () => {
  it('refuses a folder that overlaps another project’s folder', async () => {
    const {projects} = await setup(() => 'complete');
    const mine = join(dir, 'work', 'storyboard');
    await projects.setLocalDir('storyboard', mine);

    for (const folder of [
      mine,
      join(mine, 'inside'),
      join(dir, 'work'),
      '/',
      // macOS folder names ignore case.
      ...(process.platform === 'darwin' ? [join(dir, 'WORK', 'storyboard')] : []),
    ]) {
      await expect(projects.setLocalDir('trailer', folder)).rejects.toThrow(
        /overlaps “storyboard”/
      );
    }
    await expect(
      projects.setLocalDir('trailer', join(dir, 'work', 'trailer'))
    ).resolves.toMatchObject({
      localDir: join(dir, 'work', 'trailer'),
    });
  });

  it.runIf(process.platform === 'darwin')(
    'refuses a new folder whose name differs only in Unicode form',
    async () => {
      const {projects} = await setup(() => 'complete');
      await projects.setLocalDir('storyboard', join(dir, 'café'.normalize('NFC')));

      await expect(
        projects.setLocalDir('trailer', join(dir, 'café'.normalize('NFD')))
      ).rejects.toThrow(/overlaps “storyboard”/);
    }
  );

  it('won’t change a folder while another project is busy', async () => {
    const {projects} = await setup(() => 'complete');
    let release = (): void => {};
    const held = projects.exclusive(
      'storyboard',
      'file delete',
      () => new Promise<void>((r) => (release = r))
    );

    await expect(projects.setLocalDir('trailer', join(dir, 'work', 'trailer'))).rejects.toThrow(
      /Wait for the file delete in “storyboard”/
    );
    release();
    await held;
  });

  it('treats a project renamed only in case as the same project', async () => {
    const {projects} = await setup(() => 'complete');
    const folder = join(dir, 'work', 'Foo');
    await projects.setLocalDir('Foo', folder);

    expect(projects.info('foo').localDir).toBe(folder);
    await expect(projects.setLocalDir('foo', folder)).resolves.toMatchObject({localDir: folder});

    let release = (): void => {};
    const held = projects.exclusive(
      'Foo',
      'file delete',
      () => new Promise<void>((r) => (release = r))
    );
    await expect(projects.setLocalDir('foo', folder)).rejects.toThrow(/Wait for the sync/);
    release();
    await held;
  });

  it('refuses another project’s folder reached through a linked parent', async () => {
    const {projects} = await setup(() => 'complete');
    await mkdir(join(dir, 'real', 'work'), {recursive: true});
    await symlink(join(dir, 'real'), join(dir, 'alias'));
    await projects.setLocalDir('storyboard', join(dir, 'real', 'work', 'storyboard'));

    await expect(
      projects.setLocalDir('trailer', join(dir, 'alias', 'work', 'storyboard'))
    ).rejects.toThrow(/overlaps “storyboard”/);
  });

  it('refuses another project’s folder right after that project is created', async () => {
    const {projects} = await setup(
      () => 'complete',
      undefined,
      async () => {}
    );
    await projects.create('trailer');

    await expect(
      projects.setLocalDir('storyboard', join(dir, 'projects', 'trailer'))
    ).rejects.toThrow(/overlaps “trailer”/);
  });

  it('refuses a project whose default folder is another project’s folder', async () => {
    const {projects} = await setup(() => 'complete');
    // storyboard uses the folder trailer would get by default.
    await projects.setLocalDir('storyboard', join(dir, 'projects', 'trailer'));

    await expect(projects.create('trailer')).rejects.toThrow(/overlaps “storyboard”/);
    await expect(projects.sync('trailer', false)).rejects.toThrow(/overlaps “storyboard”/);
    await expect(projects.remove('trailer')).rejects.toThrow(/overlaps “storyboard”/);
  });
});

describe('Projects.remove', () => {
  it('forgets the sync state but keeps the files', async () => {
    const {projects} = await setup(() => 'complete');
    const local = join(dir, 'projects', 'storyboard');
    await mkdir(join(local, '.foldersync', 'old_files'), {recursive: true});
    await writeFile(join(local, '.foldersync', 'state.db'), '');
    await writeFile(join(local, '.foldersync', 'old_files', 'backup.txt'), 'keep');
    await writeFile(join(local, 'a.txt'), 'a');

    await projects.remove('storyboard');

    expect(existsSync(join(local, 'a.txt'))).toBe(true);
    expect(existsSync(join(local, '.foldersync', 'state.db'))).toBe(false);
    expect(existsSync(join(local, '.foldersync', 'old_files', 'backup.txt'))).toBe(true);
  });

  it('keeps the sync state when settings can’t be saved', async () => {
    const {projects} = await setup(() => 'complete');
    const local = join(dir, 'projects', 'storyboard');
    await mkdir(join(local, '.foldersync'), {recursive: true});
    await writeFile(join(local, '.foldersync', 'state.db'), '');
    // settings.json can't be replaced once it's a folder.
    await mkdir(join(dir, 'settings.json'));

    await expect(projects.remove('storyboard')).rejects.toThrow();

    expect(existsSync(join(local, '.foldersync', 'state.db'))).toBe(true);
  });

  it('says so when the project is removed but its sync state can’t be deleted', async () => {
    const {projects} = await setup(() => 'complete');
    await projects.setLocalDir('storyboard', join(dir, 'work', 'storyboard'));
    const state = join(dir, 'work', 'storyboard', '.foldersync');
    await mkdir(state, {recursive: true});
    await writeFile(join(state, 'state.db'), '');
    await chmod(state, 0o500);

    try {
      await expect(projects.remove('storyboard')).rejects.toThrow(
        /project was removed, but its sync state/
      );
      expect(projects.info('storyboard').localDir).toBe(join(dir, 'projects', 'storyboard'));
    } finally {
      await chmod(state, 0o700);
    }
  });

  it('won’t open a state.db that links outside the project', async () => {
    const {projects} = await setup(() => 'complete');
    const local = join(dir, 'projects', 'storyboard');
    const outside = join(dir, 'outside.db');
    await mkdir(join(local, '.foldersync'), {recursive: true});
    await writeFile(outside, '');
    await symlink(outside, join(local, '.foldersync', 'state.db'));

    await expect(projects.sync('storyboard', false)).rejects.toThrow(/is a link/);

    expect(await readFile(outside, 'utf8')).toBe('');
  });

  it('won’t open the sync database through a .foldersync link', async () => {
    const {projects} = await setup(() => 'complete');
    const local = join(dir, 'projects', 'storyboard');
    const outside = join(dir, 'outside');
    await mkdir(local, {recursive: true});
    await mkdir(outside);
    await symlink(outside, join(local, '.foldersync'));

    await expect(projects.sync('storyboard', false)).rejects.toThrow(/is a link/);

    expect(existsSync(join(outside, 'state.db'))).toBe(false);
  });

  it('won’t delete through a .foldersync that links outside the project', async () => {
    const {projects} = await setup(() => 'complete');
    const local = join(dir, 'projects', 'storyboard');
    const outside = join(dir, 'outside');
    await mkdir(local, {recursive: true});
    await mkdir(outside);
    await writeFile(join(outside, 'state.db'), 'not ours');
    await symlink(outside, join(local, '.foldersync'));

    await expect(projects.remove('storyboard')).rejects.toThrow(/is a link/);

    expect(existsSync(join(outside, 'state.db'))).toBe(true);
  });
});
