import {describe, expect, it} from 'vitest';

import {
  requireDropboxPath,
  requireEntry,
  requireNewProjectName,
  requireProjectName,
  requireRev,
  requireTimestampUs,
} from '../src/main/validate';

describe('IPC input checks', () => {
  it('accepts a project name that is one folder name', () => {
    expect(requireProjectName('storyboard')).toBe('storyboard');
    expect(requireProjectName('client review 2026')).toBe('client review 2026');
  });

  it.each(['', '.', '..', '../other', 'a/b', 'a\\b', 'a\0b', 42])(
    'rejects %j as a project name',
    (name) => {
      expect(() => requireProjectName(name)).toThrow();
    }
  );

  it('trims a new project name and applies Dropbox name rules', () => {
    expect(requireNewProjectName('  storyboard ')).toBe('storyboard');
    expect(() => requireNewProjectName('desktop.ini')).toThrow();
    expect(() => requireNewProjectName('..')).toThrow();
  });

  it('accepts absolute Dropbox paths without . or .. parts', () => {
    expect(requireDropboxPath('/storyboard/shots/a.mov')).toBe('/storyboard/shots/a.mov');
    for (const path of ['storyboard/a', '/storyboard/../other', '/storyboard/./a', 7]) {
      expect(() => requireDropboxPath(path)).toThrow();
    }
  });

  it('checks a files panel entry, including its name', () => {
    const entry = {
      kind: 'file',
      name: 'a.txt',
      path: '/p/a.txt',
      rev: 'r1',
      status: 'synced',
      onComputer: true,
    };
    expect(requireEntry(entry)).toEqual(entry);
    expect(() => requireEntry({...entry, name: '../a.txt'})).toThrow();
    expect(() => requireEntry({...entry, kind: 'link'})).toThrow();
    expect(requireEntry({...entry, status: 'local-newer'}).status).toBeUndefined();
  });

  it('accepts only positive whole-number timestamps', () => {
    expect(requireTimestampUs(1_792_614_782_000_000)).toBe(1_792_614_782_000_000);
    for (const value of [0, 1, -5, 1.5, Number.NaN, '123']) {
      expect(() => requireTimestampUs(value)).toThrow();
    }
  });

  it('requires a revision to delete a file', () => {
    expect(requireRev('015e5fd4edc')).toBe('015e5fd4edc');
    for (const value of ['', undefined, 42]) {
      expect(() => requireRev(value)).toThrow();
    }
  });
});
