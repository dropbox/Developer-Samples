import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {Settings, tokenServerFromEnv} from '../src/main/config';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-config-'));
  process.env.FOLDERSYNC_PROJECTS = join(dir, 'projects');
});

afterEach(async () => {
  delete process.env.FOLDERSYNC_PROJECTS;
  await rm(dir, {recursive: true, force: true});
});

describe('Settings', () => {
  it('starts with defaults when settings.json is missing', async () => {
    const settings = await Settings.load(join(dir, 'settings.json'));
    expect(settings.lastUserName).toBeUndefined();
    expect(settings.project('storyboard').localDir).toBe(join(dir, 'projects', 'storyboard'));
  });

  it('refuses to start over when settings.json is broken', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, '{not json');
    await expect(Settings.load(path)).rejects.toThrow(/isn’t valid JSON/);
    expect(await readFile(path, 'utf8')).toBe('{not json');
  });

  it('finds a project’s folder whatever its name’s case, and keeps the saved name', async () => {
    const path = join(dir, 'settings.json');
    const settings = await Settings.load(path);
    settings.setLocalDir('Foo', join(dir, 'Foo'));
    await settings.save();

    const again = await Settings.load(path);
    expect(again.chosenLocalDir('foo')).toBe(join(dir, 'Foo'));
    expect(again.chosenProjects()).toEqual(['Foo']);
  });

  it('rejects two saved folders for one project', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({projectDirs: {Foo: '/a', foo: '/b'}}));
    await expect(Settings.load(path)).rejects.toThrow(/two folders for “foo”/);
  });

  it('rejects a saved project folder that isn’t a full path', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({projectDirs: {storyboard: ''}}));
    await expect(Settings.load(path)).rejects.toThrow(/invalid folder/);
  });

  it.each([['[]'], ['{"projectDirs": "broken"}'], ['{"projectDirs": []}']])(
    'rejects settings.json with %s',
    async (text) => {
      const path = join(dir, 'settings.json');
      await writeFile(path, text);
      await expect(Settings.load(path)).rejects.toThrow(/Fix or delete it/);
    }
  );

  it('saves and loads folders, the last name, and the token server URL', async () => {
    const path = join(dir, 'settings.json');
    const settings = await Settings.load(path);
    settings.setLocalDir('storyboard', '/Volumes/work/storyboard');
    settings.lastUserName = 'agentfs-demo';
    settings.tokenServerUrl = 'http://127.0.0.1:8787';
    await settings.save();

    const again = await Settings.load(path);
    expect(again.project('storyboard').localDir).toBe('/Volumes/work/storyboard');
    expect(again.lastUserName).toBe('agentfs-demo');
    expect(again.tokenServerUrl).toBe('http://127.0.0.1:8787');
  });

  it('treats a project named like an Object property as an ordinary name', async () => {
    const settings = await Settings.load(join(dir, 'settings.json'));
    expect(settings.project('constructor').localDir).toBe(join(dir, 'projects', 'constructor'));
  });

  it('saves twice at once without the saves colliding', async () => {
    const path = join(dir, 'settings.json');
    const settings = await Settings.load(path);
    settings.lastUserName = 'first';
    const first = settings.save();
    settings.lastUserName = 'second';
    await Promise.all([first, settings.save()]);
    expect((await Settings.load(path)).lastUserName).toBe('second');
  });

  it('forgets a project folder', async () => {
    const settings = await Settings.load(join(dir, 'settings.json'));
    settings.setLocalDir('storyboard', '/elsewhere');
    settings.forgetProject('storyboard');
    expect(settings.project('storyboard').localDir).toBe(join(dir, 'projects', 'storyboard'));
  });
});

describe('tokenServerFromEnv', () => {
  afterEach(() => {
    delete process.env.FOLDERSYNC_PORT;
  });

  it('gives the token server URL for FOLDERSYNC_PORT', () => {
    expect(tokenServerFromEnv()).toBeUndefined();
    process.env.FOLDERSYNC_PORT = '8788';
    expect(tokenServerFromEnv()).toBe('http://127.0.0.1:8788');
  });

  it.each(['0', '65536', 'abc', '87.5', ' 8788'])('rejects FOLDERSYNC_PORT=%j', (port) => {
    process.env.FOLDERSYNC_PORT = port;
    expect(() => tokenServerFromEnv()).toThrow(/port number from 1 to 65535/);
  });
});
