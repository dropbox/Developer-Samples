// Types shared by the main process, the preload script, and the renderer.

export type TokenState =
  | {kind: 'missing'}
  | {kind: 'valid'; expiresAt: string}
  | {kind: 'renewing'}
  | {kind: 'error'; message: string};

export interface SetupInfo {
  tokenServerUrl: string;
  signedIn: boolean;
  // The signed-in user's name.
  userName?: string;
  // The name used last time, kept after signing out.
  lastUserName?: string;
  // Shown under the app name, from FOLDERSYNC_LABEL, to tell copies apart.
  label?: string;
}

export interface SignInResult {
  setup: SetupInfo;
  // True when this sign-in created a new managed user.
  created: boolean;
}

export type TokenServerStatus = {running: true; appKey: string} | {running: false};

export interface ProjectInfo {
  name: string;
  localDir: string;
}

export interface Issue {
  path: string;
  message: string;
}

export type ActivityKind =
  'uploaded' | 'downloaded' | 'deleted-remote' | 'deleted-local' | 'conflict';

export interface Activity {
  kind: ActivityKind;
  path: string;
  at: string;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  conflicts: number;
  issues: Issue[];
  // Set when the pass stopped before deleting many files.
  massDelete?: {count: number; total: number};
  finishedAt: string;
}

export type SyncStatus =
  // message is set when something finished without a sync, like an undo.
  | {kind: 'idle'; last?: SyncSummary; message?: string}
  | {kind: 'syncing'; step: string}
  | {kind: 'error'; message: string};

export type FileStatus =
  | 'synced'
  | 'dropbox-newer'
  | 'local-newer'
  | 'deleted-here'
  | 'both-changed'
  | 'not-on-computer'
  // On both sides, but this computer has no sync record for it yet.
  | 'not-synced';

// One item in the Dropbox files panel.
export interface RemoteEntry {
  kind: 'file' | 'folder';
  name: string;
  path: string;
  size?: number;
  modified?: string;
  rev?: string;
  status?: FileStatus;
  onComputer: boolean;
}

export type FileAction = 'open' | 'reveal' | 'delete';

export type ProjectAction = 'reveal' | 'remove' | 'delete';

// One write FolderSync made to a project in Dropbox, from agents/mutations/list.
export interface Change {
  // add, edit, delete, move, rename, rollback, and so on.
  op: string;
  // Path in the project; empty for an undo.
  path: string;
  toPath?: string;
  timestampUs: number;
  // For an undo: the time it undid changes after.
  undidAfterUs?: number;
}

// Changes in the same second, which can only be undone together.
export interface ChangeGroup {
  timestampUs: number;
  changes: Change[];
}

export interface FoldersyncApi {
  getSetup(): Promise<SetupInfo>;
  signIn(name: string, tokenServerUrl: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  tokenServerStatus(tokenServerUrl: string): Promise<TokenServerStatus>;
  getTokenState(): Promise<TokenState>;
  listProjects(): Promise<string[]>;
  createProject(name: string): Promise<void>;
  openProject(name: string): Promise<ProjectInfo>;
  chooseFolder(name: string): Promise<ProjectInfo | undefined>;
  revealFolder(name: string): Promise<void>;
  projectMenu(name: string): Promise<ProjectAction | undefined>;
  // Stops syncing the project on this computer. Files stay in Dropbox and here.
  removeProject(name: string): Promise<void>;
  // Deletes the project folder from Dropbox, then stops syncing it here.
  deleteProject(name: string): Promise<void>;
  recentActivity(name: string): Promise<Activity[]>;
  remoteList(project: string, folder: string): Promise<RemoteEntry[]>;
  fileMenu(entry: RemoteEntry): Promise<FileAction | undefined>;
  openFile(project: string, entry: RemoteEntry): Promise<void>;
  revealFile(project: string, path: string): Promise<void>;
  deleteFile(project: string, path: string, rev: string): Promise<void>;
  projectChanges(project: string): Promise<ChangeGroup[]>;
  // Undoes the changes at fromUs and after.
  undoChanges(project: string, fromUs: number): Promise<void>;
  syncNow(name: string, allowMassDelete: boolean): Promise<SyncSummary>;
  onTokenState(listener: (state: TokenState) => void): void;
  onSyncStatus(listener: (project: string, status: SyncStatus) => void): void;
  onActivity(listener: (project: string, activity: Activity) => void): void;
}
