// Electron main process: the window, native menus and dialogs, and the IPC
// handlers that connect the window to the account, projects, and files panel.
// The logic lives in the modules next to this one, which don't use Electron.
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';

import type {DropboxClient} from '../engine/dropboxApi';
import type {FileAction, ProjectAction} from '../shared/types';
import {Account} from './account';
import {Settings, credentialsPath, tokenServerFromEnv} from './config';
import {FilesPanel} from './filesPanel';
import {ProjectClients} from './projectClients';
import {Projects} from './projects';
import {
  requireDropboxPath,
  requireEntry,
  requireNewProjectName,
  requireProjectName,
  requireRev,
  requireTimestampUs,
} from './validate';

let window: BrowserWindow | undefined;

function send(channel: string, ...args: unknown[]): void {
  window?.webContents.send(channel, ...args);
}

// A native menu item; choosing it resolves popupMenu with its action.
type MenuItem<T> = MenuItemConstructorOptions & {action?: T};

// Shows a native menu and resolves with the chosen action, or undefined if the
// menu closes without a choice.
function popupMenu<T>(items: MenuItem<T>[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    const template = items.map(({action, ...item}) =>
      action === undefined ? item : {...item, click: () => resolve(action)}
    );
    Menu.buildFromTemplate(template).popup({
      window,
      // Runs when the menu closes; a click above resolves first.
      callback: () => setTimeout(() => resolve(undefined), 0),
    });
  });
}

async function openPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) {
    throw new Error(error);
  }
}

function registerIpc(account: Account, projects: Projects, files: FilesPanel): void {
  ipcMain.handle('get-setup', () => account.setupInfo());
  // Account changes hold the project lock, so no project action overlaps them.
  ipcMain.handle('sign-in', (_e, name: unknown, url: unknown) =>
    projects.duringAccountChange(() => account.signIn(name, url))
  );
  ipcMain.handle('sign-out', () => projects.duringAccountChange(() => account.signOut()));
  ipcMain.handle('delete-account', () =>
    projects.duringAccountChange(() => account.deleteAccount())
  );
  ipcMain.handle('token-server-status', (_e, url: unknown) => account.tokenServerStatus(url));
  ipcMain.handle('get-token-state', () => account.tokenState);

  ipcMain.handle('list-projects', () => projects.list());
  ipcMain.handle('create-project', (_e, name: unknown) =>
    projects.create(requireNewProjectName(name))
  );
  ipcMain.handle('open-project', (_e, name: unknown) => projects.info(requireProjectName(name)));
  ipcMain.handle('recent-activity', (_e, name: unknown) =>
    projects.activity(requireProjectName(name))
  );
  ipcMain.handle('sync-now', (_e, name: unknown, allowMassDelete: unknown) =>
    projects.sync(requireProjectName(name), allowMassDelete === true)
  );
  ipcMain.handle('choose-folder', async (_e, raw: unknown) => {
    const name = requireProjectName(raw);
    if (!window) {
      return undefined;
    }
    const result = await dialog.showOpenDialog(window, {
      title: `Choose a local folder for ${name}`,
      defaultPath: projects.info(name).localDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    const dir = result.filePaths[0];
    return result.canceled || !dir ? undefined : projects.setLocalDir(name, dir);
  });
  ipcMain.handle('reveal-folder', async (_e, name: unknown) => {
    const {localDir} = projects.info(requireProjectName(name));
    await mkdir(localDir, {recursive: true});
    await openPath(localDir);
  });
  ipcMain.handle('project-menu', (_e, name: unknown) => {
    requireProjectName(name);
    return popupMenu<ProjectAction>([
      {label: 'Show in Finder', action: 'reveal'},
      {label: 'Remove from This Mac', action: 'remove'},
      {type: 'separator'},
      {label: 'Delete from Dropbox…', action: 'delete'},
    ]);
  });
  ipcMain.handle('remove-project', (_e, name: unknown) =>
    projects.remove(requireProjectName(name))
  );
  ipcMain.handle('delete-project', (_e, name: unknown) =>
    projects.delete(requireProjectName(name))
  );
  ipcMain.handle('project-changes', (_e, name: unknown) =>
    projects.changes(requireProjectName(name))
  );
  ipcMain.handle('undo-changes', (_e, name: unknown, fromUs: unknown) =>
    projects.undo(requireProjectName(name), requireTimestampUs(fromUs))
  );

  ipcMain.handle('remote-list', (_e, project: unknown, folder: unknown) =>
    files.list(
      requireProjectName(project),
      folder === undefined ? undefined : requireDropboxPath(folder)
    )
  );
  ipcMain.handle('file-menu', (_e, raw: unknown) => {
    const entry = requireEntry(raw);
    const items: MenuItem<FileAction>[] = [];
    if (entry.kind === 'file') {
      items.push({label: 'Open', action: 'open'});
    }
    items.push({label: 'Show in Finder', enabled: entry.onComputer, action: 'reveal'});
    if (entry.kind === 'file') {
      items.push({type: 'separator'}, {label: 'Delete from Dropbox…', action: 'delete'});
    }
    return popupMenu(items);
  });
  ipcMain.handle('open-file', async (_e, project: unknown, entry: unknown) =>
    openPath(await files.fileToOpen(requireProjectName(project), requireEntry(entry)))
  );
  ipcMain.handle('reveal-file', async (_e, project: unknown, path: unknown) =>
    shell.showItemInFolder(
      await files.fileToReveal(requireProjectName(project), requireDropboxPath(path))
    )
  );
  ipcMain.handle('delete-file', (_e, project: unknown, path: unknown, rev: unknown) => {
    const name = requireProjectName(project);
    return projects.exclusive(name, 'file delete', () =>
      files.delete(name, requireDropboxPath(path), requireRev(rev))
    );
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 760,
    minHeight: 480,
    title: 'FolderSync',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F7F5F2',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The window only ever shows the app's own page.
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    window = undefined;
  });
  window.loadFile(join(__dirname, '..', 'renderer', 'index.html')).catch((err: unknown) => {
    dialog.showErrorBox(
      'FolderSync can’t open its window',
      err instanceof Error ? err.message : String(err)
    );
    app.quit();
  });
}

async function start(): Promise<void> {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(join(__dirname, '..', '..', 'build', 'icon.png')));
  }
  const settings = await Settings.load();
  const account = new Account({
    credentialsPath: credentialsPath(),
    settings,
    onTokenState: (state) => send('token-state', state),
    // Agents belong to the user, so a new user starts with no agent sessions.
    onUserChanged: () => {
      clients.forgetAll();
      projects.clearActivity();
    },
    tokenServerUrl: tokenServerFromEnv(),
  });
  const userApi = (): DropboxClient => account.userClient();
  const clients = new ProjectClients(userApi, () => account.agentDirectory());
  const projects = new Projects({
    settings,
    clients,
    userApi,
    accountId: () => account.userPublicId(),
    onStatus: (project, status) => send('sync-status', project, status),
    onActivity: (project, activity) => send('activity', project, activity),
  });
  await account.load();
  const files = new FilesPanel(settings, clients, userApi, () => account.userPublicId());
  registerIpc(account, projects, files);
  app.on('will-quit', () => files.removeOpenCopies());
  powerMonitor.on('resume', () => {
    account.onWake();
    clients.onWake();
  });
  createWindow();
  app.on('activate', () => {
    if (!window) {
      createWindow();
    }
  });
}

// With FOLDERSYNC_HOME set, Chromium's caches go there too, so tests start clean.
// It also scopes the single-instance lock below, so set it first.
if (process.env.FOLDERSYNC_HOME) {
  app.setPath('userData', join(process.env.FOLDERSYNC_HOME, 'electron'));
}

// Only one copy of the app runs, so two sync passes never work on the same
// project. A second launch brings the first window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  }
});

void app.whenReady().then(() =>
  start().catch((err: unknown) => {
    dialog.showErrorBox('FolderSync can’t start', err instanceof Error ? err.message : String(err));
    app.quit();
  })
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
