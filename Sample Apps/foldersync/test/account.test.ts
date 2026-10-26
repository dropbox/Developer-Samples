import {existsSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {Account, serverUrl} from '../src/main/account';
import {Settings} from '../src/main/config';
import type {TokenState} from '../src/shared/types';

let dir: string;
let credentialsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foldersync-account-'));
  await mkdir(join(dir, 'home'));
  credentialsPath = join(dir, 'home', 'credentials.json');
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await chmod(join(dir, 'home'), 0o700);
  await rm(dir, {recursive: true, force: true});
});

// A token server whose /token answers only when release() is called.
function tokenServer(): {fetchImpl: typeof fetch; release: () => void} {
  let release = (): void => {};
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/login') {
      return Response.json({connection_key: 'key-1', name: 'demo', user_public_id: 'pid_user:1'});
    }
    await answered;
    return Response.json({
      access_token: 'token-1',
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    });
  };
  return {fetchImpl, release};
}

async function account(fetchImpl: typeof fetch, states: TokenState[] = []): Promise<Account> {
  return new Account({
    credentialsPath,
    settings: await Settings.load(join(dir, 'settings.json')),
    onTokenState: (state) => states.push(state),
    onUserChanged: () => {},
    fetchImpl,
  });
}

// A token server where each name has its own key, and the first /token call
// for key-a waits until releaseA() is called.
function twoUserServer(): {fetchImpl: typeof fetch; releaseA: () => void} {
  let releaseA = (): void => {};
  const aWaits = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/login') {
      const name = String(Reflect.get(JSON.parse(String(init?.body)), 'name'));
      return Response.json({
        connection_key: `key-${name}`,
        name,
        user_public_id: `pid_user:${name}`,
      });
    }
    const key = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '');
    if (key === 'key-a') {
      await aWaits;
    }
    return Response.json({
      access_token: `token-${key}`,
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    });
  };
  return {fetchImpl, releaseA};
}

describe('Account', () => {
  it('doesn’t let the previous account’s renewal overwrite a new sign-in', async () => {
    const server = twoUserServer();
    const settings = await Settings.load(join(dir, 'settings.json'));
    const a = new Account({
      credentialsPath,
      settings,
      onTokenState: () => {},
      onUserChanged: () => {},
      fetchImpl: server.fetchImpl,
    });
    await a.signIn('a', 'http://127.0.0.1:8787');
    // A's renewal finishes in the middle of B's sign-in.
    const save = settings.save.bind(settings);
    vi.spyOn(settings, 'save').mockImplementation(async () => {
      server.releaseA();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return save();
    });

    await a.signIn('b', 'http://127.0.0.1:8787');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readFile(credentialsPath, 'utf8')).toContain('key-b');
    expect(a.setupInfo().userName).toBe('b');
  });

  it('signs out after a sign-in that was still saving', async () => {
    const server = twoUserServer();
    server.releaseA();
    const settings = await Settings.load(join(dir, 'settings.json'));
    const a = new Account({
      credentialsPath,
      settings,
      onTokenState: () => {},
      onUserChanged: () => {},
      fetchImpl: server.fetchImpl,
    });
    const save = settings.save.bind(settings);
    vi.spyOn(settings, 'save').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return save();
    });

    await Promise.all([a.signIn('a', 'http://127.0.0.1:8787'), a.signOut()]);

    expect(a.setupInfo().signedIn).toBe(false);
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('refuses redirects on every token server call', async () => {
    const redirects: (string | undefined)[] = [];
    const server = twoUserServer();
    server.releaseA();
    const a = await account(async (url, init) => {
      redirects.push(init?.redirect);
      return server.fetchImpl(url, init);
    });

    await a.tokenServerStatus('http://127.0.0.1:8787');
    await a.signIn('a', 'http://127.0.0.1:8787');
    // The token is saved after the last call, so cleanup doesn't race the save.
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-key-a');
    });

    expect(redirects.length).toBeGreaterThanOrEqual(3);
    expect(redirects.every((r) => r === 'error')).toBe(true);
  });

  it('keeps the previous account when settings can’t be saved', async () => {
    const server = twoUserServer();
    server.releaseA();
    const a = await account(server.fetchImpl);
    await a.signIn('a', 'http://127.0.0.1:8787');
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-key-a');
    });
    // settings.json is in dir, credentials.json in dir/home.
    await chmod(dir, 0o500);

    await expect(a.signIn('b', 'http://127.0.0.1:8787')).rejects.toThrow();

    expect(await readFile(credentialsPath, 'utf8')).toContain('key-a');
    expect(a.setupInfo().userName).toBe('a');
    expect(() => a.userClient()).not.toThrow();
  });

  it('stays signed out of a deleted account when its credentials can’t be removed', async () => {
    const server = twoUserServer();
    server.releaseA();
    const a = await account(server.fetchImpl);
    await a.signIn('a', 'http://127.0.0.1:8787');
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-key-a');
    });
    await chmod(join(dir, 'home'), 0o500);

    await expect(a.deleteAccount()).rejects.toThrow(/account was deleted, but cleaning up/);

    expect(a.setupInfo()).toMatchObject({signedIn: false, lastUserName: undefined});
    expect(() => a.userClient()).toThrow();
  });

  it('gets the new account’s token right after switching from a signed-in one', async () => {
    const server = twoUserServer();
    server.releaseA();
    const keys: string[] = [];
    const a = await account(async (url, init) => {
      if (new URL(String(url)).pathname === '/token') {
        keys.push(new Headers(init?.headers).get('Authorization') ?? '');
      }
      return server.fetchImpl(url, init);
    });
    await a.signIn('a', 'http://127.0.0.1:8787');
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-key-a');
    });

    await a.signIn('b', 'http://127.0.0.1:8787');

    await vi.waitFor(() => expect(keys).toContain('Bearer key-b'));
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-key-b');
    });
  });

  it('gives the signed-in user’s ID for recording sync state', async () => {
    const server = twoUserServer();
    server.releaseA();
    const a = await account(server.fetchImpl);
    expect(() => a.userPublicId()).toThrow(/Sign in first/);

    await a.signIn('a', 'http://127.0.0.1:8787');

    expect(a.userPublicId()).toBe('pid_user:a');
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-key-a');
    });
  });

  it('refuses a sign-in response without a user public ID', async () => {
    const a = await account(async (url) =>
      new URL(String(url)).pathname === '/login'
        ? Response.json({connection_key: 'key-1', name: 'demo'})
        : Response.json({})
    );

    await expect(a.signIn('demo', 'http://127.0.0.1:8787')).rejects.toThrow(/no user public ID/);
    expect(a.setupInfo().signedIn).toBe(false);
  });

  it('ignores a token that arrives after sign-out', async () => {
    const server = tokenServer();
    const states: TokenState[] = [];
    const a = await account(server.fetchImpl, states);
    await a.signIn('demo', 'http://127.0.0.1:8787');

    await a.signOut();
    server.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(existsSync(credentialsPath)).toBe(false);
    expect(a.tokenState).toEqual({kind: 'missing'});
    expect(a.setupInfo().signedIn).toBe(false);
  });

  it('stays signed in when the credentials file can’t be deleted', async () => {
    const server = tokenServer();
    server.release();
    const a = await account(server.fetchImpl);
    await a.signIn('demo', 'http://127.0.0.1:8787');
    // Wait for the first token to be saved, since saving resets the folder's mode.
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-1');
    });
    await chmod(join(dir, 'home'), 0o500);

    await expect(a.signOut()).rejects.toThrow();

    expect(a.setupInfo().signedIn).toBe(true);
    expect(() => a.userClient()).not.toThrow();
  });

  it('uses the token server start.sh started over the saved one', async () => {
    const server = tokenServer();
    server.release();
    const first = await account(server.fetchImpl);
    await first.signIn('demo', 'http://127.0.0.1:8787');
    await vi.waitFor(async () => {
      expect(await readFile(credentialsPath, 'utf8')).toContain('token-1');
    });

    const urls: string[] = [];
    const a = new Account({
      credentialsPath,
      settings: await Settings.load(join(dir, 'settings.json')),
      onTokenState: () => {},
      onUserChanged: () => {},
      tokenServerUrl: 'http://127.0.0.1:8788',
      fetchImpl: async (url) => {
        urls.push(String(url));
        return Response.json({agent_id: 'agent-1'});
      },
    });
    await a.load();

    expect(a.setupInfo().tokenServerUrl).toBe('http://127.0.0.1:8788');
    expect(await a.agentDirectory().recorded('/storyboard')).toBe('agent-1');
    expect(urls).toEqual(['http://127.0.0.1:8788/project-agent']);
  });

  it('allows plain HTTP only to this computer', () => {
    expect(serverUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(serverUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(serverUrl('https://tokens.example.com')).toBe('https://tokens.example.com');
    expect(serverUrl('')).toBe('http://127.0.0.1:8787');
    expect(() => serverUrl('http://tokens.example.com')).toThrow(/https/);
    expect(() => serverUrl('ftp://127.0.0.1')).toThrow(/https/);
    expect(() => serverUrl('not a url')).toThrow(/isn’t a valid/);
  });
});
