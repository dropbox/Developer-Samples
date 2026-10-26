import {mkdir, mkdtemp, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {StateStore, openStateStore} from '../src/engine/stateStore';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-state-'));
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('StateStore', () => {
  it('won’t open a state folder that is a link', async () => {
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(dir, '.foldersync'));

    await expect(openStateStore(join(dir, '.foldersync'))).rejects.toThrow(/is a link/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('adds the deleted_here column to a database made before it existed', async () => {
    const path = join(dir, 'state.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE entries (
      path_lower TEXT PRIMARY KEY, path_display TEXT NOT NULL, kind TEXT NOT NULL,
      id TEXT NOT NULL, rev TEXT NOT NULL, content_hash TEXT NOT NULL,
      inode TEXT, size INTEGER, mtime_ns TEXT, ctime_ns TEXT,
      upload_failed INTEGER NOT NULL DEFAULT 0)`);
    old.exec(
      `INSERT INTO entries VALUES ('/p/old', '/p/old', 'folder', '', '', '', NULL, NULL, NULL, NULL, 0)`
    );
    old.close();

    const store = new StateStore(path);

    const row = store.row('/p/old');
    if (!row) {
      throw new Error('the old row is missing');
    }
    expect(row.deletedHere).toBe(false);
    store.put({...row, deletedHere: true});
    expect(store.row('/p/old')?.deletedHere).toBe(true);
    store.close();
  });

  it('rejects a row with only part of a stat', () => {
    const path = join(dir, 'state.db');
    const store = new StateStore(path);
    store.put({
      pathLower: '/p/a.txt',
      pathDisplay: '/p/a.txt',
      kind: 'file',
      id: 'id:a',
      rev: 'r1',
      contentHash: 'h',
      stat: {inode: '1', size: 1, mtimeNs: '1', ctimeNs: '1'},
      uploadFailed: false,
    });
    const db = new DatabaseSync(path);
    db.exec('UPDATE entries SET size = NULL');
    db.close();

    expect(() => store.rows()).toThrow(/partial stat/);
    store.close();
  });

  it('rejects a row whose upload_failed isn’t 0 or 1', () => {
    const path = join(dir, 'state.db');
    const store = new StateStore(path);
    store.put({
      pathLower: '/p/a.txt',
      pathDisplay: '/p/a.txt',
      kind: 'file',
      id: 'id:a',
      rev: 'r1',
      contentHash: 'h',
      stat: undefined,
      uploadFailed: false,
    });
    const db = new DatabaseSync(path);
    db.exec('UPDATE entries SET upload_failed = 2');
    db.close();

    expect(() => store.rows()).toThrow(/invalid upload_failed/);
    store.close();
  });

  it('closes the database when the file isn’t a usable database', async () => {
    const path = join(dir, 'state.db');
    await writeFile(path, 'not a database');

    expect(() => new StateStore(path)).toThrow();
    // Closed, so the damaged file can be replaced.
    await rm(path);
    expect(() => new StateStore(path).close()).not.toThrow();
  });
});
