// @vitest-environment happy-dom
// The window's views against the real index.html, with a fake preload API.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {
  Activity,
  ChangeGroup,
  FoldersyncApi,
  ProjectInfo,
  SyncSummary,
} from '../src/shared/types';

const page = readFileSync(join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

// A promise and the functions that settle it.
function deferred<T>(): {promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void} {
  let resolve = (_v: T): void => {};
  let reject = (_e: Error): void => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

function summary(overrides: Partial<SyncSummary> = {}): SyncSummary {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    conflicts: 0,
    issues: [],
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Every API call resolves with an empty result unless a test replaces it.
function fakeApi(): FoldersyncApi {
  const none = async (): Promise<undefined> => undefined;
  return {
    getSetup: async () => ({tokenServerUrl: 'http://127.0.0.1:8787', signedIn: true}),
    signIn: async () => ({
      setup: {tokenServerUrl: 'http://127.0.0.1:8787', signedIn: true},
      created: false,
    }),
    signOut: none,
    deleteAccount: none,
    tokenServerStatus: async () => ({running: true, appKey: 'k'}),
    getTokenState: async () => ({kind: 'missing'}),
    listProjects: async () => ['a', 'b'],
    createProject: none,
    openProject: async (name): Promise<ProjectInfo> => ({name, localDir: `/tmp/${name}`}),
    chooseFolder: none,
    revealFolder: none,
    projectMenu: none,
    removeProject: none,
    deleteProject: none,
    recentActivity: async () => [],
    remoteList: async () => [],
    fileMenu: none,
    openFile: none,
    revealFile: none,
    deleteFile: none,
    projectChanges: async () => [],
    undoChanges: none,
    syncNow: async () => summary(),
    onTokenState: () => {},
    onSyncStatus: () => {},
    onActivity: () => {},
  };
}

let api: FoldersyncApi;

beforeEach(() => {
  // The page without its script; the test imports the views itself.
  const body = page.slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[^>]*><\/script>/g, '');
  api = fakeApi();
  Reflect.set(window, 'foldersync', api);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// happy-dom has no confirm(), so the tests supply one.
function stubConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  Reflect.set(window, 'confirm', confirm);
  return confirm;
}

// Lets pending promise callbacks run.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function projectButton(name: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('#projects li > button:first-child'),
  ].find((b) => b.textContent?.includes(name));
  if (!button) {
    throw new Error(`no button for ${name}`);
  }
  return button;
}

// The sidebar dot's state for a project.
function dotState(name: string): string | undefined {
  return projectButton(name).querySelector<HTMLElement>('[data-state]')?.dataset.state;
}

async function projectsView() {
  const {ProjectsView} = await import('../src/renderer/projectsView');
  const view = new ProjectsView();
  await view.load();
  return view;
}

const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`no #${id}`);
  }
  return node;
};

describe('ProjectsView', () => {
  it('hides the open project while another one loads', async () => {
    const b = deferred<ProjectInfo>();
    api.openProject = async (name) => (name === 'b' ? b.promise : {name, localDir: `/tmp/${name}`});
    const sync = vi.spyOn(api, 'syncNow');
    await projectsView();
    projectButton('a').click();
    await settle();
    expect(byId('project').hidden).toBe(false);

    projectButton('b').click();
    await settle();

    expect(byId('project').hidden).toBe(true);
    b.resolve({name: 'b', localDir: '/tmp/b'});
    await settle();
    expect(byId('project').hidden).toBe(false);
    expect(byId('project-name').textContent).toBe('b');
    expect(sync).not.toHaveBeenCalled();
  });

  it('stops before deleting most of a project when the user says no', async () => {
    const calls: [string, boolean][] = [];
    api.syncNow = async (name, allow) => {
      calls.push([name, allow]);
      return summary({massDelete: {count: 30, total: 40}});
    };
    stubConfirm(false);
    await projectsView();
    projectButton('a').click();
    await settle();

    byId('sync-now').click();
    await settle();

    expect(calls).toEqual([['a', false]]);
    expect(byId('status-title').textContent).toBe('Stopped before deleting files');
    expect(dotState('a')).toBe('none');
  });

  it('syncs again, allowing the deletes, only for the project the user said yes to', async () => {
    const calls: [string, boolean][] = [];
    api.syncNow = async (name, allow) => {
      calls.push([name, allow]);
      return allow ? summary({deletedLocal: 30}) : summary({massDelete: {count: 30, total: 40}});
    };
    stubConfirm(true);
    await projectsView();
    projectButton('a').click();
    await settle();

    byId('sync-now').click();
    await settle();

    expect(calls).toEqual([
      ['a', false],
      ['a', true],
    ]);
  });

  it('doesn’t ask about deletes for a project that’s no longer open', async () => {
    const pass = deferred<SyncSummary>();
    api.syncNow = async () => pass.promise;
    const confirm = stubConfirm(true);
    await projectsView();
    projectButton('a').click();
    await settle();
    byId('sync-now').click();
    projectButton('b').click();
    await settle();

    pass.resolve(summary({massDelete: {count: 30, total: 40}}));
    await settle();

    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('ProjectsView status and deletes', () => {
  it('doesn’t show a pass stopped before deleting files as up to date', async () => {
    const view = await projectsView();
    // An earlier pass synced; the latest one stopped before deleting files.
    view.onSyncStatus('a', {kind: 'idle', last: summary()});
    view.onSyncStatus('a', {kind: 'idle', last: summary({massDelete: {count: 30, total: 40}})});

    projectButton('a').click();
    await settle();

    expect(byId('status-title').textContent).not.toBe('Up to date');
  });

  it('shows a project’s last error again when it’s reopened', async () => {
    const view = await projectsView();
    view.onSyncStatus('a', {kind: 'idle', last: summary()});
    view.onSyncStatus('a', {kind: 'error', message: 'Dropbox is unavailable.'});

    projectButton('a').click();
    await settle();

    expect(byId('status-title').textContent).toBe('Couldn’t sync');
    expect(byId('status-detail').textContent).toBe('Dropbox is unavailable.');
    expect(dotState('a')).toBe('error');
  });

  it('doesn’t show one project’s issues under another project’s error', async () => {
    const view = await projectsView();
    view.onSyncStatus('a', {
      kind: 'idle',
      last: summary({
        issues: [{path: '/a/locked.txt', message: 'FolderSync can’t read this item.'}],
      }),
    });
    view.onSyncStatus('b', {kind: 'error', message: 'Dropbox is unavailable.'});
    projectButton('a').click();
    await settle();
    expect(byId('issues').textContent).toContain('locked.txt');

    projectButton('b').click();
    await settle();

    expect(byId('status-title').textContent).toBe('Couldn’t sync');
    expect(byId('issues').textContent).not.toContain('locked.txt');
  });

  it('doesn’t show one project’s issues while another one syncs', async () => {
    const view = await projectsView();
    view.onSyncStatus('a', {
      kind: 'idle',
      last: summary({
        issues: [{path: '/a/locked.txt', message: 'FolderSync can’t read this item.'}],
      }),
    });
    view.onSyncStatus('b', {kind: 'syncing', step: 'Listing Dropbox'});
    projectButton('a').click();
    await settle();

    projectButton('b').click();
    await settle();

    expect(byId('issues').textContent).not.toContain('locked.txt');
  });

  it('shows a sync still running when its project is reopened', async () => {
    const view = await projectsView();
    view.onSyncStatus('a', {kind: 'idle', last: summary()});
    view.onSyncStatus('a', {kind: 'syncing', step: 'Uploading shot.mov'});

    projectButton('a').click();
    await settle();

    expect(byId('status-title').textContent).toBe('Syncing…');
    expect(byId('status-detail').textContent).toBe('Uploading shot.mov');
  });

  it('doesn’t show the summary from before an undo as up to date', async () => {
    const view = await projectsView();
    view.onSyncStatus('a', {kind: 'idle', last: summary()});
    view.onSyncStatus('a', {kind: 'error', message: 'The undo is still running in Dropbox.'});
    view.onSyncStatus('a', {kind: 'idle', message: 'The undo finished in Dropbox.'});

    projectButton('a').click();
    await settle();

    expect(byId('status-title').textContent).not.toBe('Up to date');
  });

  it('clears the error dot when an undo finishes in the background', async () => {
    const view = await projectsView();
    view.onSyncStatus('a', {kind: 'error', message: 'The undo is still running in Dropbox.'});
    expect(dotState('a')).toBe('error');

    view.onSyncStatus('a', {kind: 'idle', message: 'The undo finished in Dropbox.'});

    expect(dotState('a')).toBe('none');
  });

  it('drops a file action’s result after another project is opened', async () => {
    const opening = deferred<undefined>();
    api.remoteList = async (project) => [
      {kind: 'file', name: 'x.txt', path: `/${project}/x.txt`, rev: 'r1', onComputer: false},
    ];
    api.fileMenu = async () => 'open';
    api.openFile = async () => opening.promise;
    await projectsView();
    projectButton('a').click();
    await settle();
    document
      .querySelector('#files-tree [role="treeitem"]')
      ?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();

    projectButton('b').click();
    await settle();
    opening.reject(new Error('Couldn’t download x.txt'));
    await settle();

    expect(byId('files-note').textContent).not.toContain('x.txt');
  });

  it('ignores a file menu answer that arrives after another project is opened', async () => {
    const menu = deferred<'open'>();
    api.remoteList = async (project) => [
      {kind: 'file', name: 'x.txt', path: `/${project}/x.txt`, rev: 'r1', onComputer: false},
    ];
    api.fileMenu = async () => menu.promise;
    const fileMenu = vi.spyOn(api, 'fileMenu');
    const open = vi.spyOn(api, 'openFile');
    await projectsView();
    projectButton('a').click();
    await settle();
    const row = document.querySelector('#files-tree [role="treeitem"]');
    if (!row) {
      throw new Error('no file row');
    }
    row.dispatchEvent(new MouseEvent('contextmenu'));
    expect(fileMenu).toHaveBeenCalledWith(expect.objectContaining({path: '/a/x.txt'}));

    projectButton('b').click();
    await settle();
    expect(byId('project-name').textContent).toBe('b');
    menu.resolve('open');
    await settle();

    expect(open).not.toHaveBeenCalled();
    expect(byId('files-note').textContent).toBe('');
  });

  it('keeps a folder error out of the next project’s status', async () => {
    const reveal = deferred<undefined>();
    api.revealFolder = async () => reveal.promise;
    await projectsView();
    projectButton('a').click();
    await settle();
    byId('reveal-folder').click();

    projectButton('b').click();
    await settle();
    reveal.reject(new Error('The folder is gone.'));
    await settle();

    expect(byId('status-title').textContent).not.toBe('Couldn’t open the folder');
  });

  it('clears the previous project’s activity while the next one loads', async () => {
    const b = deferred<Activity[]>();
    const seen: Activity = {kind: 'uploaded', path: '/a/x.txt', at: new Date().toISOString()};
    api.recentActivity = async (name) => (name === 'b' ? b.promise : [seen]);
    await projectsView();
    projectButton('a').click();
    await settle();
    expect(byId('activity').textContent).toContain('x.txt');

    projectButton('b').click();
    await settle();

    expect(byId('activity').textContent).not.toContain('x.txt');
    b.resolve([]);
  });

  it('keeps project Delete off after a failed delete if the typed name was cleared', async () => {
    const deleting = deferred<undefined>();
    api.projectMenu = async () => 'delete';
    api.deleteProject = async () => deleting.promise;
    await projectsView();
    projectButton('a').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();
    const confirm = byId('delete-project-confirm') as HTMLInputElement;
    confirm.value = 'a';
    confirm.dispatchEvent(new Event('input'));
    byId('delete-project-submit').click();

    confirm.value = '';
    deleting.reject(new Error('Dropbox is unavailable.'));
    await settle();

    expect((byId('delete-project-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('forgets the old folder’s status after the folder is changed', async () => {
    api.chooseFolder = async (name) => ({name, localDir: '/tmp/elsewhere'});
    const view = await projectsView();
    view.onSyncStatus('a', {kind: 'idle', last: summary()});
    projectButton('a').click();
    await settle();
    expect(byId('status-title').textContent).toBe('Up to date');

    byId('choose-folder').click();
    await settle();

    expect(byId('project-dir').textContent).toBe('/tmp/elsewhere');
    expect(byId('status-title').textContent).toBe('Not synced yet');
  });

  it('stops showing up to date after a file is deleted from Dropbox', async () => {
    api.remoteList = async (project) => [
      {kind: 'file', name: 'x.txt', path: `/${project}/x.txt`, rev: 'r1', onComputer: true},
    ];
    api.fileMenu = async () => 'delete';
    stubConfirm(true);
    const view = await projectsView();
    view.onSyncStatus('a', {kind: 'idle', last: summary()});
    projectButton('a').click();
    await settle();

    document
      .querySelector('#files-tree [role="treeitem"]')
      ?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();

    expect(byId('status-title').textContent).toBe('Changed in Dropbox');
    projectButton('b').click();
    await settle();
    projectButton('a').click();
    await settle();
    expect(byId('status-title').textContent).not.toBe('Up to date');
  });

  it('keeps the project delete dialog open until the delete finishes', async () => {
    const deleting = deferred<undefined>();
    api.projectMenu = async () => 'delete';
    api.deleteProject = async () => deleting.promise;
    await projectsView();
    projectButton('a').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();
    const confirm = byId('delete-project-confirm') as HTMLInputElement;
    confirm.value = 'a';
    confirm.dispatchEvent(new Event('input'));
    byId('delete-project-submit').click();

    const escape = new Event('cancel', {cancelable: true});
    byId('delete-project-dialog').dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect((byId('delete-project-cancel') as HTMLButtonElement).disabled).toBe(true);
    // Typing the name again doesn't allow a second delete.
    confirm.dispatchEvent(new Event('input'));
    expect((byId('delete-project-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('delete-project-dialog').querySelector('form')).toBeNull();
    deleting.reject(new Error('Dropbox is unavailable.'));
    await settle();
    expect((byId('delete-project-cancel') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a project delete failure in the list if the dialog was closed', async () => {
    const deleting = deferred<undefined>();
    api.projectMenu = async () => 'delete';
    api.deleteProject = async () => deleting.promise;
    await projectsView();
    projectButton('a').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();
    const confirm = byId('delete-project-confirm') as HTMLInputElement;
    confirm.value = 'a';
    confirm.dispatchEvent(new Event('input'));
    byId('delete-project-submit').click();
    (byId('delete-project-dialog') as HTMLDialogElement).close();

    deleting.reject(new Error('Dropbox is unavailable.'));
    await settle();

    expect(byId('projects-error').textContent).toBe('Dropbox is unavailable.');
  });

  it('treats project names that differ only in case as one project', async () => {
    let names = ['Foo'];
    api.listProjects = async () => names;
    const view = await projectsView();
    projectButton('Foo').click();
    await settle();

    names = ['foo'];
    await view.load();
    view.onSyncStatus('Foo', {kind: 'error', message: 'Dropbox is unavailable.'});

    expect(byId('project').hidden).toBe(false);
    expect(byId('status-title').textContent).toBe('Couldn’t sync');
    expect(dotState('foo')).toBe('error');
  });

  it('drops a deleted project even when the list can’t be refreshed', async () => {
    let refreshes = 0;
    api.listProjects = async () => {
      refreshes++;
      if (refreshes > 1) {
        throw new Error('Dropbox is unavailable.');
      }
      return ['a', 'b'];
    };
    api.projectMenu = async () => 'delete';
    await projectsView();
    projectButton('a').click();
    await settle();
    projectButton('a').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();
    const confirm = byId('delete-project-confirm') as HTMLInputElement;
    confirm.value = 'a';
    confirm.dispatchEvent(new Event('input'));

    byId('delete-project-submit').click();
    await settle();

    expect(byId('projects').textContent).not.toContain('a');
    expect(byId('project').hidden).toBe(true);
    expect(byId('projects-error').textContent).toBe('Dropbox is unavailable.');
  });

  it('leaves another project’s delete dialog alone when an earlier delete fails', async () => {
    const failing = deferred<undefined>();
    api.projectMenu = async () => 'delete';
    api.deleteProject = async () => failing.promise;
    await projectsView();
    const confirm = byId('delete-project-confirm') as HTMLInputElement;
    const submit = byId('delete-project-submit') as HTMLButtonElement;
    projectButton('a').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();
    confirm.value = 'a';
    confirm.dispatchEvent(new Event('input'));
    submit.click();
    (byId('delete-project-dialog') as HTMLDialogElement).close();
    projectButton('b').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();

    failing.reject(new Error('Dropbox is unavailable.'));
    await settle();

    expect(byId('delete-project-name').textContent).toBe('b');
    expect(submit.disabled).toBe(true);
    expect(byId('delete-project-error').textContent).toBe('');
    expect(byId('projects-error').textContent).toBe('Dropbox is unavailable.');
  });

  it('drops a project deleted from Dropbox even when cleanup here fails', async () => {
    let projects = ['a', 'b'];
    api.listProjects = async () => projects;
    api.projectMenu = async () => 'delete';
    api.deleteProject = async () => {
      projects = ['b'];
      throw new Error('The project was removed, but its sync state couldn’t be deleted');
    };
    await projectsView();
    projectButton('a').closest('li')?.dispatchEvent(new MouseEvent('contextmenu'));
    await settle();
    const confirm = byId('delete-project-confirm') as HTMLInputElement;
    confirm.value = 'a';
    confirm.dispatchEvent(new Event('input'));

    byId('delete-project-submit').click();
    await settle();

    expect((byId('delete-project-dialog') as HTMLDialogElement).open).toBe(false);
    expect(byId('projects').textContent).not.toContain('a');
    expect(byId('projects-error').textContent).toMatch(/sync state couldn’t be deleted/);
  });
});

describe('AccountView', () => {
  it('shows sign-in when the account was deleted but cleanup here failed', async () => {
    const {AccountView} = await import('../src/renderer/accountView');
    const view = new AccountView(
      () => {},
      () => {}
    );
    view.showApp({tokenServerUrl: 'http://127.0.0.1:8787', signedIn: true, userName: 'demo'});
    api.deleteAccount = async () => {
      throw new Error('The account was deleted, but cleaning up on this computer failed');
    };
    api.getSetup = async () => ({tokenServerUrl: 'http://127.0.0.1:8787', signedIn: false});
    byId('delete-account').click();
    const confirm = byId('delete-confirm') as HTMLInputElement;
    confirm.value = 'demo';
    confirm.dispatchEvent(new Event('input'));

    byId('delete-submit').click();
    await settle();

    expect(byId('onboarding').hidden).toBe(false);
    expect((byId('delete-dialog') as HTMLDialogElement).open).toBe(false);
    expect(byId('setup-error').textContent).toMatch(/account was deleted/);
  });
});

describe('AccountView errors', () => {
  it('keeps the account delete dialog open, and shows a failure if it closed anyway', async () => {
    const {AccountView} = await import('../src/renderer/accountView');
    const view = new AccountView(
      () => {},
      () => {}
    );
    view.showApp({tokenServerUrl: 'http://127.0.0.1:8787', signedIn: true, userName: 'demo'});
    const deleting = deferred<undefined>();
    api.deleteAccount = async () => deleting.promise;
    byId('delete-account').click();
    const confirm = byId('delete-confirm') as HTMLInputElement;
    confirm.value = 'demo';
    confirm.dispatchEvent(new Event('input'));
    byId('delete-submit').click();

    const escape = new Event('cancel', {cancelable: true});
    byId('delete-dialog').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    confirm.dispatchEvent(new Event('input'));
    expect((byId('delete-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('delete-dialog').querySelector('form')).toBeNull();
    (byId('delete-dialog') as HTMLDialogElement).close();
    deleting.reject(new Error('The token server didn’t answer'));
    await settle();

    expect(byId('token-text').textContent).toMatch(/didn’t answer/);
  });

  it('ignores an older token server check that answers last', async () => {
    const {AccountView} = await import('../src/renderer/accountView');
    new AccountView(
      () => {},
      () => {}
    );
    const first = deferred<{running: boolean; appKey: string}>();
    api.tokenServerStatus = async (url) =>
      url.endsWith(':8787') ? first.promise : {running: false, appKey: ''};
    const input = byId('server-url') as HTMLInputElement;
    input.value = 'http://127.0.0.1:8787';
    input.dispatchEvent(new Event('change'));
    input.value = 'http://127.0.0.1:8788';
    input.dispatchEvent(new Event('change'));
    await settle();

    first.resolve({running: true, appKey: 'abcd1234'});
    await settle();

    expect(byId('server-status').textContent).toMatch(/isn’t running/);
  });

  it('keeps the deletion error in the dialog when checking the account fails too', async () => {
    const {AccountView} = await import('../src/renderer/accountView');
    const view = new AccountView(
      () => {},
      () => {}
    );
    view.showApp({tokenServerUrl: 'http://127.0.0.1:8787', signedIn: true, userName: 'demo'});
    api.deleteAccount = async () => {
      throw new Error('The token server didn’t answer');
    };
    api.getSetup = async () => {
      throw new Error('IPC failed');
    };
    byId('delete-account').click();
    const confirm = byId('delete-confirm') as HTMLInputElement;
    confirm.value = 'demo';
    confirm.dispatchEvent(new Event('input'));

    byId('delete-submit').click();
    await settle();

    expect((byId('delete-dialog') as HTMLDialogElement).open).toBe(true);
    expect(byId('delete-error').textContent).toMatch(/didn’t answer/);
    expect((byId('delete-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps Delete off after a failed delete if the typed name was cleared', async () => {
    const {AccountView} = await import('../src/renderer/accountView');
    const view = new AccountView(
      () => {},
      () => {}
    );
    view.showApp({tokenServerUrl: 'http://127.0.0.1:8787', signedIn: true, userName: 'demo'});
    const deleting = deferred<undefined>();
    api.deleteAccount = async () => deleting.promise;
    byId('delete-account').click();
    const confirm = byId('delete-confirm') as HTMLInputElement;
    confirm.value = 'demo';
    confirm.dispatchEvent(new Event('input'));
    byId('delete-submit').click();

    confirm.value = '';
    deleting.reject(new Error('The token server didn’t answer'));
    await settle();

    expect((byId('delete-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('page styles', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'styles.module.css'), 'utf8');

  it('uses only classes that styles.module.css defines', async () => {
    const {classNames} = await import('../scripts/css-types.mjs');
    const used = [...page.matchAll(/data-css="([^"]+)"/g)].flatMap((m) => (m[1] ?? '').split(' '));

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !classNames(css).includes(name))).toEqual([]);
  });

  it('keeps the stylesheet’s class types up to date', async () => {
    const {cssTypes} = await import('../scripts/css-types.mjs');
    const types = readFileSync(
      join(__dirname, '..', 'src', 'renderer', 'styles.module.d.css.ts'),
      'utf8'
    );

    expect(types).toBe(cssTypes(css));
  });

  it('gives page elements their stylesheet classes', async () => {
    const {applyCss} = await import('../src/renderer/dom');
    const styles = (await import('../src/renderer/styles.module.css')).default;

    applyCss();

    expect(byId('sync-now').classList).toContain(styles.btn);
    expect(byId('sync-now').classList).toContain(styles.primary);
  });
});

describe('UndoDialog', () => {
  it('drops history from an earlier open of the same project', async () => {
    const first = deferred<ChangeGroup[]>();
    const group = (path: string): ChangeGroup[] => [
      {
        timestampUs: 1_792_614_782_000_000,
        changes: [{op: 'add', path, timestampUs: 1_792_614_782_000_000}],
      },
    ];
    let calls = 0;
    api.projectChanges = async () => (++calls === 1 ? first.promise : group('new.txt'));
    const {UndoDialog} = await import('../src/renderer/undoDialog');
    const dialog = new UndoDialog(() => {});
    const opening = dialog.open('a');
    await dialog.open('a');

    first.resolve(group('old.txt'));
    await opening;

    expect(byId('undo-list').textContent).toContain('new.txt');
    expect(byId('undo-list').textContent).not.toContain('old.txt');
  });

  it('ignores a late error for a project it no longer shows', async () => {
    const a = deferred<ChangeGroup[]>();
    const groups: ChangeGroup[] = [
      {
        timestampUs: 1_792_614_782_000_000,
        changes: [{op: 'add', path: 'b.txt', timestampUs: 1_792_614_782_000_000}],
      },
    ];
    api.projectChanges = async (name) => (name === 'a' ? a.promise : groups);
    const {UndoDialog} = await import('../src/renderer/undoDialog');
    const dialog = new UndoDialog(() => {});
    const opening = dialog.open('a');
    await dialog.open('b');

    a.reject(new Error('a failed'));
    await opening;

    expect(byId('undo-error').textContent).toBe('');
    expect(byId('undo-list').textContent).toContain('b.txt');
  });
});
