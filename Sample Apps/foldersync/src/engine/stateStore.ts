// Last-synced state for one project, in SQLite (node:sqlite).
import {join} from 'node:path';
import {DatabaseSync, type SQLOutputValue} from 'node:sqlite';

import {refuseLinks} from './localScan';

export interface LocalStat {
  inode: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

export interface Row {
  pathLower: string;
  pathDisplay: string;
  kind: 'file' | 'folder';
  id: string;
  rev: string;
  contentHash: string;
  stat?: LocalStat;
  // The last upload of this file failed, so it counts as changed locally.
  uploadFailed: boolean;
  // A folder deleted on this computer but kept in Dropbox; see syncPass.ts.
  deletedHere?: boolean;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    path_lower TEXT PRIMARY KEY,
    path_display TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    rev TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    inode TEXT,
    size INTEGER,
    mtime_ns TEXT,
    ctime_ns TEXT,
    upload_failed INTEGER NOT NULL DEFAULT 0,
    deleted_here INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// The database's files in the state folder, with SQLite's WAL files.
export const STATE_DB_FILES = ['state.db', 'state.db-wal', 'state.db-shm'];

// Opens the state database in stateDir. Refuses a state folder or database
// files that are links, which could point outside the project.
export async function openStateStore(stateDir: string): Promise<StateStore> {
  await refuseLinks(stateDir, ...STATE_DB_FILES.map((f) => join(stateDir, f)));
  return new StateStore(join(stateDir, 'state.db'));
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      // No disk flush per commit. With WAL, a crash can't corrupt the database,
      // and a power cut loses only the latest commits, in order.
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec(SCHEMA);
      // Databases made before deleted_here existed get the column.
      const columns = this.db.prepare('PRAGMA table_info(entries)').all();
      if (!columns.some((c) => c.name === 'deleted_here')) {
        this.db.exec('ALTER TABLE entries ADD COLUMN deleted_here INTEGER NOT NULL DEFAULT 0');
      }
      // Fail early if the file isn't a usable database.
      this.db.prepare('SELECT count(*) FROM entries').get();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  getCursor(): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('cursor');
    return row ? text(row, 'value') : undefined;
  }

  setCursor(cursor: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('cursor', cursor);
  }

  // The account whose Dropbox this folder was synced with.
  getAccount(): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('account');
    return row ? text(row, 'value') : undefined;
  }

  setAccount(accountId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('account', accountId);
  }

  clearCursor(): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run('cursor');
  }

  row(pathLower: string): Row | undefined {
    const r = this.db.prepare('SELECT * FROM entries WHERE path_lower = ?').get(pathLower);
    return r ? parseRow(r) : undefined;
  }

  rows(): Map<string, Row> {
    const rows = new Map<string, Row>();
    for (const r of this.db.prepare('SELECT * FROM entries').all()) {
      const row = parseRow(r);
      rows.set(row.pathLower, row);
    }
    return rows;
  }

  put(row: Row): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO entries
           (path_lower, path_display, kind, id, rev, content_hash, inode, size, mtime_ns, ctime_ns, upload_failed, deleted_here)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.pathLower,
        row.pathDisplay,
        row.kind,
        row.id,
        row.rev,
        row.contentHash,
        row.stat?.inode ?? null,
        row.stat?.size ?? null,
        row.stat?.mtimeNs ?? null,
        row.stat?.ctimeNs ?? null,
        row.uploadFailed ? 1 : 0,
        row.deletedHere ? 1 : 0
      );
  }

  remove(pathLower: string): void {
    this.db.prepare('DELETE FROM entries WHERE path_lower = ?').run(pathLower);
  }
}

type DbRow = Record<string, SQLOutputValue>;

function text(row: DbRow, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new Error(`State column ${key} isn’t text.`);
  }
  return v;
}

// A 0 or 1 column, rejecting anything else as a damaged state row.
function parseFlag(r: DbRow, column: string): boolean {
  const value = r[column];
  if (value !== 0 && value !== 1) {
    throw new Error(`The state row for ${text(r, 'path_display')} has an invalid ${column}.`);
  }
  return value === 1;
}

function parseRow(r: DbRow): Row {
  const kind = text(r, 'kind');
  if (kind !== 'file' && kind !== 'folder') {
    throw new Error(`Unknown state row kind: ${kind}`);
  }
  const inode = r.inode;
  const size = r.size;
  const mtimeNs = r.mtime_ns;
  const ctimeNs = r.ctime_ns;
  // A row has all four stat columns or none.
  let stat: LocalStat | undefined;
  if (
    typeof inode === 'string' &&
    typeof size === 'number' &&
    typeof mtimeNs === 'string' &&
    typeof ctimeNs === 'string'
  ) {
    stat = {inode, size, mtimeNs, ctimeNs};
  } else if (inode !== null || size !== null || mtimeNs !== null || ctimeNs !== null) {
    throw new Error(`The state row for ${text(r, 'path_display')} has a partial stat.`);
  }
  return {
    pathLower: text(r, 'path_lower'),
    pathDisplay: text(r, 'path_display'),
    kind,
    id: text(r, 'id'),
    rev: text(r, 'rev'),
    contentHash: text(r, 'content_hash'),
    stat,
    uploadFailed: parseFlag(r, 'upload_failed'),
    deletedHere: parseFlag(r, 'deleted_here'),
  };
}
