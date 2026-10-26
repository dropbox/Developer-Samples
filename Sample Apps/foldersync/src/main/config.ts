// Where FolderSync keeps its files, and its settings.json.
//
// ~/.foldersync holds credentials.json and settings.json (FOLDERSYNC_HOME moves
// it). Project folders go in ~/FolderSync (FOLDERSYNC_PROJECTS moves them).
// FOLDERSYNC_PORT is the port start.sh started the token server on.
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';

import {projectKey} from '../engine/paths';
import type {ProjectInfo} from '../shared/types';

const configDir = (): string => process.env.FOLDERSYNC_HOME ?? join(homedir(), '.foldersync');
export const credentialsPath = (): string => join(configDir(), 'credentials.json');
const settingsPath = (): string => join(configDir(), 'settings.json');
const projectsRoot = (): string => process.env.FOLDERSYNC_PROJECTS ?? join(homedir(), 'FolderSync');

// The token server's URL when FOLDERSYNC_PORT is set.
export function tokenServerFromEnv(): string | undefined {
  const raw = process.env.FOLDERSYNC_PORT;
  if (!raw) {
    return undefined;
  }
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`FOLDERSYNC_PORT must be a port number from 1 to 65535, not “${raw}”.`);
  }
  return `http://127.0.0.1:${port}`;
}

function stringField(v: unknown, key: string): string | undefined {
  const value: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, key) : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class Settings {
  // The local folder chosen with Change folder…, by projectKey of the
  // project name.
  private projectDirs = new Map<string, {name: string; dir: string}>();
  // Kept after signing out, so the sign-in screen is filled in next time.
  lastUserName: string | undefined;
  tokenServerUrl: string | undefined;
  // Saves run one at a time, so two never share the temporary file.
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  // Reads settings.json. A missing file means defaults; a file that can't be
  // read or parsed is an error, so the app never replaces it with defaults.
  static async load(path = settingsPath()): Promise<Settings> {
    const settings = new Settings(path);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return settings;
      }
      throw new Error(`Couldn’t read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} isn’t valid JSON. Fix or delete it, then start FolderSync again.`);
    }
    const invalid = (what: string): Error =>
      new Error(`${path} has ${what}. Fix or delete it, then start FolderSync again.`);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalid('no settings object');
    }
    const dirs: unknown = Reflect.get(parsed, 'projectDirs');
    if (dirs !== undefined) {
      if (typeof dirs !== 'object' || dirs === null || Array.isArray(dirs)) {
        throw invalid('an invalid projectDirs');
      }
      for (const [name, dir] of Object.entries(dirs)) {
        if (typeof dir !== 'string' || !isAbsolute(dir)) {
          throw invalid(`an invalid folder for “${name}”`);
        }
        if (settings.projectDirs.has(projectKey(name))) {
          throw invalid(`two folders for “${name}”`);
        }
        settings.projectDirs.set(projectKey(name), {name, dir});
      }
    }
    settings.lastUserName = stringField(parsed, 'lastUserName');
    settings.tokenServerUrl = stringField(parsed, 'tokenServerUrl');
    return settings;
  }

  // Writes settings.json atomically, after any save already in progress.
  save(): Promise<void> {
    const next = this.saving.then(() => this.write());
    this.saving = next.catch(() => {});
    return next;
  }

  private async write(): Promise<void> {
    await mkdir(join(this.path, '..'), {recursive: true, mode: 0o700});
    const tmp = `${this.path}.tmp`;
    const settings = {
      projectDirs: Object.fromEntries([...this.projectDirs.values()].map((p) => [p.name, p.dir])),
      lastUserName: this.lastUserName,
      tokenServerUrl: this.tokenServerUrl,
    };
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, {mode: 0o600});
    await rename(tmp, this.path);
  }

  project(name: string): ProjectInfo {
    return {name, localDir: this.chosenLocalDir(name) ?? join(projectsRoot(), name)};
  }

  // The folder chosen with Change folder…, if any.
  chosenLocalDir(name: string): string | undefined {
    return this.projectDirs.get(projectKey(name))?.dir;
  }

  // The projects with a chosen local folder.
  chosenProjects(): string[] {
    return [...this.projectDirs.values()].map((p) => p.name);
  }

  setLocalDir(name: string, dir: string): void {
    if (!isAbsolute(dir)) {
      throw new Error(`${dir} isn’t a full folder path.`);
    }
    this.projectDirs.set(projectKey(name), {name, dir});
  }

  forgetProject(name: string): void {
    this.projectDirs.delete(projectKey(name));
  }
}
