// Walks a project folder and records each file's stat.
import type {BigIntStats} from 'node:fs';
import {lstat, mkdir, readdir} from 'node:fs/promises';
import {join} from 'node:path';

import {STATE_DIR, invalidNameReason, isIgnoredName, isUnder, joinDropbox, pathKey} from './paths';
import type {LocalStat} from './stateStore';

export interface LocalItem {
  dropboxPath: string;
  localPath: string;
  kind: 'file' | 'folder';
  stat: LocalStat;
}

export interface Skipped {
  dropboxPath: string;
  reason: string;
}

const SAME_NAME = 'Another item here has the same name except for case. Rename one of them.';
const CHANGED_DURING_SCAN = 'It changed while it was being scanned.';

function toLocalStat(st: BigIntStats): LocalStat {
  return {
    inode: st.ino.toString(),
    size: Number(st.size),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
  };
}

export function sameStat(a: LocalStat | undefined, b: LocalStat | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.inode === b.inode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

// Returns the current stat of a path, or undefined if it doesn't exist.
export async function statOrUndefined(path: string): Promise<LocalStat | undefined> {
  try {
    return toLocalStat(await lstat(path, {bigint: true}));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

// Makes sure a folder exists and is a real folder, not a link that could
// point outside the project.
// Throws if any of the paths is a symlink. Missing paths are fine.
export async function refuseLinks(...paths: string[]): Promise<void> {
  for (const path of paths) {
    const st = await lstat(path).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    });
    if (st?.isSymbolicLink()) {
      throw new Error(`${path} is a link, so FolderSync won’t use it.`);
    }
  }
}

export async function ensureRealFolder(path: string): Promise<void> {
  const st = await lstat(path).catch((err: unknown) => {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  });
  if (!st) {
    await mkdir(path);
  } else if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${path} is a link or a file, so FolderSync won’t use it.`);
  }
}

// Scans localRoot, which maps to dropboxRoot. Keys are path keys. Items that
// can't sync, like links and names Dropbox rejects, are returned as skipped;
// so are items whose names differ only in case or Unicode form, which would
// be the same item in Dropbox.
export async function scanLocal(
  localRoot: string,
  dropboxRoot: string
): Promise<{items: Map<string, LocalItem>; skipped: Skipped[]}> {
  const items = new Map<string, LocalItem>();
  const skipped: Skipped[] = [];
  const collided = new Set<string>();

  async function walk(localDir: string, dropboxDir: string, isRoot: boolean): Promise<void> {
    // Check again right before reading: the folder could have been swapped
    // for a symlink since it was listed.
    const before = isRoot
      ? undefined
      : await lstat(localDir, {bigint: true}).catch((err: unknown) => {
          if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return null;
          }
          throw err;
        });
    if (before === null || (before && (before.isSymbolicLink() || !before.isDirectory()))) {
      skipped.push({dropboxPath: dropboxDir, reason: CHANGED_DURING_SCAN});
      return;
    }
    let entries;
    try {
      entries = await readdir(localDir, {withFileTypes: true});
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (isRoot || (code !== 'EACCES' && code !== 'EPERM')) {
        throw err;
      }
      // Only this folder waits; the rest of the project still syncs.
      skipped.push({dropboxPath: dropboxDir, reason: 'FolderSync can’t read this folder.'});
      return;
    }
    // A folder swapped during readdir lists another folder's items, so its own
    // would look deleted.
    if (before) {
      const after = await lstat(localDir, {bigint: true}).catch(() => undefined);
      if (!after || after.ino !== before.ino || after.isSymbolicLink() || !after.isDirectory()) {
        skipped.push({dropboxPath: dropboxDir, reason: CHANGED_DURING_SCAN});
        return;
      }
    }
    for (const entry of entries) {
      // macOS folder names ignore case, so .FolderSync is the state folder too.
      if ((isRoot && pathKey(entry.name) === STATE_DIR) || isIgnoredName(entry.name)) {
        continue;
      }
      // macOS may store names in NFD; Dropbox paths are NFC.
      const name = entry.name.normalize('NFC');
      const dropboxPath = joinDropbox(dropboxDir, name);
      const localPath = join(localDir, entry.name);
      // The type comes from lstat, not the directory entry, in case the item
      // was swapped for a link after readdir.
      let st;
      try {
        st = await lstat(localPath, {bigint: true});
      } catch (err) {
        const code = err instanceof Error && 'code' in err ? err.code : undefined;
        if (code === 'ENOENT') {
          // Deleted while scanning.
          continue;
        }
        if (code === 'EACCES' || code === 'EPERM') {
          skipped.push({dropboxPath, reason: 'FolderSync can’t read this item.'});
          continue;
        }
        throw err;
      }
      if (st.isSymbolicLink()) {
        skipped.push({dropboxPath, reason: 'Symbolic links aren’t synced.'});
        continue;
      }
      const reason = invalidNameReason(name);
      if (reason) {
        skipped.push({dropboxPath, reason});
        continue;
      }
      if (!st.isFile() && !st.isDirectory()) {
        skipped.push({dropboxPath, reason: 'Only files and folders are synced.'});
        continue;
      }
      const stat = toLocalStat(st);
      const kind = st.isDirectory() ? 'folder' : 'file';
      const key = pathKey(dropboxPath);
      const other = items.get(key);
      if (other || collided.has(key)) {
        collided.add(key);
        skipped.push({dropboxPath, reason: SAME_NAME});
        if (other) {
          skipped.push({dropboxPath: other.dropboxPath, reason: SAME_NAME});
        }
        continue;
      }
      items.set(key, {dropboxPath, localPath, kind, stat});
      if (kind === 'folder') {
        await walk(localPath, dropboxPath, false);
      }
    }
  }

  await walk(localRoot, dropboxRoot, true);
  for (const key of items.keys()) {
    if (isUnder(key, collided)) {
      items.delete(key);
    }
  }
  return {items, skipped};
}
