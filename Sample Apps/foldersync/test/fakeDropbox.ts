// An in-memory Dropbox that applies the write modes, autorename, and
// parent_rev rules the way the server does.
import {readFile, writeFile} from 'node:fs/promises';

import {hashBuffer} from '../src/engine/contentHash';
import {
  ApiError,
  type DropboxFiles,
  type FileMeta,
  type ListResult,
  type Metadata,
  type UploadRequest,
} from '../src/engine/dropboxApi';
import {baseName, parentDropbox, pathKey} from '../src/engine/paths';

interface StoredFile {
  meta: FileMeta;
  data: Buffer;
}

export class FakeDropbox implements DropboxFiles {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Map<string, {pathDisplay: string; id: string}>();
  private readonly log: Metadata[] = [];
  private nextRev = 1;
  uploads = 0;
  downloads = 0;
  // Runs after an upload is saved and before it returns, like a slow response.
  afterUpload?: () => Promise<void>;
  // Runs after a download is written and before it returns.
  afterDownload?: () => Promise<void>;
  // Runs at the start of each listing call, before it reads anything.
  beforeList?: () => Promise<void>;
  // Runs inside deleteV2 before the revision check, like a write that lands
  // just before the delete.
  beforeDelete?: () => void;

  // Writes a file as another client (for example the agent) would.
  put(path: string, content: string): FileMeta {
    return this.write(path, Buffer.from(content), new Date());
  }

  remove(path: string): void {
    const key = pathKey(path);
    for (const k of [...this.files.keys(), ...this.folders.keys()]) {
      if (k === key || k.startsWith(`${key}/`)) {
        this.files.delete(k);
        this.folders.delete(k);
      }
    }
    this.log.push({tag: 'deleted', pathLower: key, pathDisplay: path});
  }

  content(path: string): string | undefined {
    return this.files.get(pathKey(path))?.data.toString();
  }

  async listFolder(path: string, recursive: boolean): Promise<ListResult> {
    await this.beforeList?.();
    const key = pathKey(path);
    if (key !== '' && !this.folders.has(key)) {
      throw new ApiError(409, 'path/not_found/');
    }
    const under = (k: string): boolean =>
      key === ''
        ? recursive || !k.slice(1).includes('/')
        : k.startsWith(`${key}/`) && (recursive || !k.slice(key.length + 1).includes('/'));
    const entries: Metadata[] = [];
    for (const [k, f] of this.folders) {
      if (under(k)) {
        entries.push({tag: 'folder', id: f.id, pathLower: k, pathDisplay: f.pathDisplay});
      }
    }
    for (const [k, f] of this.files) {
      if (under(k)) {
        entries.push(f.meta);
      }
    }
    return {entries, cursor: String(this.log.length), hasMore: false};
  }

  // Like Dropbox, returns each path's latest change since the cursor, and
  // leaves out paths that were created and deleted after it.
  async listFolderContinue(cursor: string): Promise<ListResult> {
    await this.beforeList?.();
    const start = Number(cursor);
    const existed = new Set<string>();
    for (const e of this.log.slice(0, start)) {
      if (e.tag === 'deleted') {
        for (const k of existed) {
          if (k === e.pathLower || k.startsWith(`${e.pathLower}/`)) {
            existed.delete(k);
          }
        }
      } else {
        existed.add(e.pathLower);
      }
    }
    const latest = new Map<string, Metadata>();
    for (const e of this.log.slice(start)) {
      latest.delete(e.pathLower);
      latest.set(e.pathLower, e);
    }
    return {
      entries: [...latest.values()].filter((e) => e.tag !== 'deleted' || existed.has(e.pathLower)),
      cursor: String(this.log.length),
      hasMore: false,
    };
  }

  async downloadToFile(dropboxPath: string, destPath: string): Promise<FileMeta> {
    const f = this.files.get(pathKey(dropboxPath));
    if (!f) {
      throw new ApiError(409, 'path/not_found/');
    }
    this.downloads++;
    await writeFile(destPath, f.data);
    await this.afterDownload?.();
    return f.meta;
  }

  async upload(req: UploadRequest): Promise<FileMeta> {
    const data = await readFile(req.localPath);
    await req.checkUnchanged();
    const existing = this.files.get(pathKey(req.dropboxPath));
    if (existing && existing.meta.contentHash === hashBuffer(data) && req.mode.kind === 'add') {
      return existing.meta;
    }
    const conflict =
      req.mode.kind === 'add' ? existing !== undefined : existing?.meta.rev !== req.mode.rev;
    this.uploads++;
    let path = req.dropboxPath;
    if (conflict) {
      const name = baseName(req.dropboxPath);
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      // Like the server, never reuse a name: (1), (2), and so on.
      const suffix = req.mode.kind === 'add' ? ' (#)' : " (user's conflicted copy#)";
      for (let n = 1; ; n++) {
        const label = req.mode.kind === 'add' ? String(n) : n === 1 ? '' : ` ${n}`;
        path = `${parentDropbox(req.dropboxPath)}/${stem}${suffix.replace('#', label)}${ext}`;
        if (!this.files.has(pathKey(path)) && !this.folders.has(pathKey(path))) {
          break;
        }
      }
    }
    const meta = this.write(path, data, req.clientModified);
    await this.afterUpload?.();
    return meta;
  }

  async deleteV2(dropboxPath: string, parentRev?: string): Promise<void> {
    this.beforeDelete?.();
    const key = pathKey(dropboxPath);
    const file = this.files.get(key);
    if (!file && !this.folders.has(key)) {
      throw new ApiError(409, 'path_lookup/not_found/');
    }
    if (file && parentRev !== undefined && file.meta.rev !== parentRev) {
      throw new ApiError(409, 'path_write/conflict/file/');
    }
    this.remove(dropboxPath);
  }

  async createFolder(dropboxPath: string): Promise<void> {
    this.ensureFolder(dropboxPath);
  }

  private write(path: string, data: Buffer, clientModified: Date): FileMeta {
    this.ensureFolder(parentDropbox(path));
    const meta: FileMeta = {
      tag: 'file',
      id: `id:${pathKey(path)}`,
      pathLower: pathKey(path),
      pathDisplay: path,
      rev: `rev${this.nextRev++}`,
      contentHash: hashBuffer(data),
      size: data.length,
      clientModified,
      serverModified: new Date(),
    };
    this.files.set(meta.pathLower, {meta, data});
    this.log.push(meta);
    return meta;
  }

  // Renames a file or folder in case only, keeping revisions, as a rename in
  // Dropbox does. Everything inside a folder takes the new spelling.
  renameCase(path: string, newPath: string): void {
    const key = pathKey(path);
    if (pathKey(newPath) !== key) {
      throw new Error('renameCase changes only the case');
    }
    const respell = (display: string): string => newPath + display.slice(path.length);
    const under = (k: string): boolean => k === key || k.startsWith(`${key}/`);
    for (const [k, folder] of this.folders) {
      if (under(k)) {
        folder.pathDisplay = respell(folder.pathDisplay);
        this.log.push({
          tag: 'folder',
          id: folder.id,
          pathLower: k,
          pathDisplay: folder.pathDisplay,
        });
      }
    }
    for (const [k, file] of this.files) {
      if (under(k)) {
        file.meta = {...file.meta, pathDisplay: respell(file.meta.pathDisplay)};
        this.log.push(file.meta);
      }
    }
  }

  private ensureFolder(path: string): void {
    if (path === '' || this.folders.has(pathKey(path))) {
      return;
    }
    this.ensureFolder(parentDropbox(path));
    const folder = {pathDisplay: path, id: `id:${pathKey(path)}`};
    this.folders.set(pathKey(path), folder);
    this.log.push({tag: 'folder', id: folder.id, pathLower: pathKey(path), pathDisplay: path});
  }
}
