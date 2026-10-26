// Checks the values the window sends over IPC before they reach the file
// system or Dropbox. The window is treated like any other untrusted input.
import {invalidNameReason, isIgnoredName} from '../engine/paths';
import type {RemoteEntry} from '../shared/types';

// One file or folder name: not empty, ".", or "..", and no path separators.
function isSingleName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

function field(raw: unknown, key: string): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, key) : undefined;
}

// A project is a top-level folder, so its name is a single folder name.
export function requireProjectName(raw: unknown): string {
  if (typeof raw !== 'string' || !isSingleName(raw)) {
    throw new Error('That isn’t a project name.');
  }
  return raw;
}

// A name typed for a new project, trimmed and checked against Dropbox's rules.
export function requireNewProjectName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!isSingleName(name)) {
    throw new Error('Enter a project name without slashes.');
  }
  const reason =
    invalidNameReason(name) ??
    (isIgnoredName(name) ? 'Dropbox doesn’t accept that name.' : undefined);
  if (reason) {
    throw new Error(reason);
  }
  return name;
}

// An absolute Dropbox path with no "." or ".." parts.
export function requireDropboxPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\0')) {
    throw new Error('That isn’t a Dropbox path.');
  }
  if (raw.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('That isn’t a Dropbox path.');
  }
  return raw;
}

// A Dropbox files panel entry sent back from the window.
export function requireEntry(raw: unknown): RemoteEntry {
  const kind = field(raw, 'kind');
  const name = field(raw, 'name');
  if ((kind !== 'file' && kind !== 'folder') || typeof name !== 'string' || !isSingleName(name)) {
    throw new Error('That isn’t a Dropbox files entry.');
  }
  const rev = field(raw, 'rev');
  return {
    kind,
    name,
    path: requireDropboxPath(field(raw, 'path')),
    rev: typeof rev === 'string' ? rev : undefined,
    status: field(raw, 'status') === 'synced' ? 'synced' : undefined,
    onComputer: field(raw, 'onComputer') === true,
  };
}

// A file revision from the files panel. Deletes require one, so Dropbox can
// refuse when the file changed since it was listed.
export function requireRev(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error('Refresh the list and try again.');
  }
  return raw;
}

// A mutation timestamp from the Undo list, in Unix microseconds. A number holds
// it exactly: microsecond times stay below 2^53 until about the year 2255.
export function requireTimestampUs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 1) {
    throw new Error('Choose a change to undo.');
  }
  return raw;
}
