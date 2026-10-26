import {chmod, mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {loadCredentials, saveCredentials, type Credentials} from '../src/engine/credentials';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-credentials-'));
  await mkdir(join(dir, 'home'));
  path = join(dir, 'home', 'credentials.json');
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('credentials file', () => {
  it('saves and loads every field', async () => {
    const creds: Credentials = {
      tokenServerUrl: 'http://127.0.0.1:8787',
      connectionKey: 'key-1',
      userName: 'demo',
      userPublicId: 'pid_user:demo',
      accessToken: 'tok',
      expiresAt: '2026-10-22T04:00:00.000Z',
    };

    await saveCredentials(path, creds);

    expect(await loadCredentials(path)).toEqual(creds);
  });

  it('writes the file 0600 in a 0700 folder, even if they were looser', async () => {
    await chmod(join(dir, 'home'), 0o755);
    await writeFile(path, '{}', {mode: 0o644});
    await writeFile(`${path}.tmp`, 'old', {mode: 0o644});

    await saveCredentials(path, {tokenServerUrl: 'http://127.0.0.1:8787', connectionKey: 'k'});

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'home'))).mode & 0o777).toBe(0o700);
    expect(await loadCredentials(path)).toMatchObject({connectionKey: 'k'});
  });

  it('treats a missing file as signed out', async () => {
    expect(await loadCredentials(path)).toBeUndefined();
  });

  it.each([
    ['without a connection key', JSON.stringify({tokenServerUrl: 'http://127.0.0.1:8787'})],
    ['that isn’t JSON', '{not json'],
  ])('reports a credentials file %s', async (_label, text) => {
    await writeFile(path, text);
    await expect(loadCredentials(path)).rejects.toThrow(/isn’t a valid credentials file/);
  });
});
