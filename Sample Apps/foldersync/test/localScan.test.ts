// The local scan against a folder swapped while it's being read.
import {mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {scanLocal} from '../src/engine/localScan';

// readdir is wrapped so a test can act right after a folder is read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {...real, readdir: vi.fn(real.readdir)};
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-scan-'));
});

afterEach(async () => {
  vi.mocked(readdir).mockReset();
  await rm(dir, {recursive: true, force: true});
});

describe('scanLocal', () => {
  it('skips a folder swapped for a link while its items are read', async () => {
    const root = join(dir, 'project');
    await mkdir(join(root, 'shots'), {recursive: true});
    await writeFile(join(root, 'shots', 'a.txt'), 'a');
    const outside = join(dir, 'outside');
    await mkdir(outside);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdir).mockImplementation((async (path: string, opts: never) => {
      const entries = await real.readdir(path, opts);
      if (path === join(root, 'shots')) {
        await rename(join(root, 'shots'), join(dir, 'moved'));
        await symlink(outside, join(root, 'shots'));
      }
      return entries;
    }) as never);

    const {items, skipped} = await scanLocal(root, '/project');

    expect(skipped.map((s) => s.dropboxPath)).toContain('/project/shots');
    expect([...items.keys()].filter((k) => k.startsWith('/project/shots/'))).toEqual([]);
  });
});
