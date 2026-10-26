// Exposes a small, typed API to the renderer.
import {contextBridge, ipcRenderer} from 'electron';

import type {
  Activity,
  ChangeGroup,
  FileAction,
  FoldersyncApi,
  ProjectAction,
  ProjectInfo,
  RemoteEntry,
  SetupInfo,
  SignInResult,
  SyncStatus,
  SyncSummary,
  TokenServerStatus,
  TokenState,
} from '../shared/types';

const api: FoldersyncApi = {
  getSetup: (): Promise<SetupInfo> => ipcRenderer.invoke('get-setup'),
  signIn: (name, tokenServerUrl): Promise<SignInResult> =>
    ipcRenderer.invoke('sign-in', name, tokenServerUrl),
  signOut: (): Promise<void> => ipcRenderer.invoke('sign-out'),
  deleteAccount: (): Promise<void> => ipcRenderer.invoke('delete-account'),
  tokenServerStatus: (tokenServerUrl): Promise<TokenServerStatus> =>
    ipcRenderer.invoke('token-server-status', tokenServerUrl),
  getTokenState: (): Promise<TokenState> => ipcRenderer.invoke('get-token-state'),
  listProjects: (): Promise<string[]> => ipcRenderer.invoke('list-projects'),
  createProject: (name): Promise<void> => ipcRenderer.invoke('create-project', name),
  openProject: (name): Promise<ProjectInfo> => ipcRenderer.invoke('open-project', name),
  chooseFolder: (name): Promise<ProjectInfo | undefined> =>
    ipcRenderer.invoke('choose-folder', name),
  revealFolder: (name): Promise<void> => ipcRenderer.invoke('reveal-folder', name),
  projectMenu: (name): Promise<ProjectAction | undefined> =>
    ipcRenderer.invoke('project-menu', name),
  removeProject: (name): Promise<void> => ipcRenderer.invoke('remove-project', name),
  deleteProject: (name): Promise<void> => ipcRenderer.invoke('delete-project', name),
  recentActivity: (name): Promise<Activity[]> => ipcRenderer.invoke('recent-activity', name),
  remoteList: (project, folder): Promise<RemoteEntry[]> =>
    ipcRenderer.invoke('remote-list', project, folder),
  fileMenu: (entry): Promise<FileAction | undefined> => ipcRenderer.invoke('file-menu', entry),
  openFile: (project, entry): Promise<void> => ipcRenderer.invoke('open-file', project, entry),
  revealFile: (project, path): Promise<void> => ipcRenderer.invoke('reveal-file', project, path),
  deleteFile: (project, path, rev): Promise<void> =>
    ipcRenderer.invoke('delete-file', project, path, rev),
  projectChanges: (project): Promise<ChangeGroup[]> =>
    ipcRenderer.invoke('project-changes', project),
  undoChanges: (project, fromUs): Promise<void> =>
    ipcRenderer.invoke('undo-changes', project, fromUs),
  syncNow: (name, allowMassDelete): Promise<SyncSummary> =>
    ipcRenderer.invoke('sync-now', name, allowMassDelete),
  onTokenState: (listener) => {
    ipcRenderer.on('token-state', (_e, state: TokenState) => listener(state));
  },
  onSyncStatus: (listener) => {
    ipcRenderer.on('sync-status', (_e, project: string, status: SyncStatus) =>
      listener(project, status)
    );
  },
  onActivity: (listener) => {
    ipcRenderer.on('activity', (_e, project: string, activity: Activity) =>
      listener(project, activity)
    );
  },
};

contextBridge.exposeInMainWorld('foldersync', api);
