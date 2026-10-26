import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {BLOCK_SIZE, hashBuffer, hashFile} from '../src/engine/contentHash';
import {DropboxClient} from '../src/engine/dropboxApi';
import {
  HttpAgentDirectory,
  HttpTokenProvider,
  RENEW_BEFORE_MS,
  checkTokenServerUrl,
  TokenManager,
  type MintedToken,
  type TokenProvider,
} from '../src/engine/tokenManager';

class CountingProvider implements TokenProvider {
  calls = 0;
  constructor(
    private readonly expiresInMs: number,
    private readonly now: () => number
  ) {}
  async fetchToken(): Promise<MintedToken> {
    this.calls++;
    return {accessToken: `tok${this.calls}`, expiresAt: new Date(this.now() + this.expiresInMs)};
  }
}

describe('content hash', () => {
  it('hashes an empty file as SHA-256 of nothing', () => {
    expect(hashBuffer(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hashes each 4 MiB block, then the block hashes', () => {
    const data = Buffer.alloc(BLOCK_SIZE + 10, 7);
    const block = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
    const expected = createHash('sha256')
      .update(
        Buffer.concat([block(data.subarray(0, BLOCK_SIZE)), block(data.subarray(BLOCK_SIZE))])
      )
      .digest('hex');
    expect(hashBuffer(data)).toBe(expected);
  });
});

describe('token manager', () => {
  it('shares one mint between callers and reuses a valid token', async () => {
    const now = 0;
    const provider = new CountingProvider(4 * 60 * 60 * 1000, () => now);
    const tokens = new TokenManager(provider, {now: () => now});

    expect(await Promise.all([tokens.getToken(), tokens.getToken()])).toEqual(['tok1', 'tok1']);
    expect(await tokens.getToken()).toBe('tok1');
    expect(provider.calls).toBe(1);
    tokens.stop();
  });

  it('mints a new token when the current one is about to expire', async () => {
    let now = 0;
    const provider = new CountingProvider(4 * 60 * 60 * 1000, () => now);
    const tokens = new TokenManager(provider, {now: () => now});
    await tokens.getToken();

    now = 4 * 60 * 60 * 1000 - RENEW_BEFORE_MS + 1;
    expect(await tokens.getToken()).toBe('tok2');
    tokens.stop();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews a short-lived token halfway through its life, not right away', async () => {
    vi.useFakeTimers();
    const provider = new CountingProvider(5 * 60 * 1000, () => Date.now());
    const tokens = new TokenManager(provider);
    await tokens.getToken();

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(provider.calls).toBe(1);
    expect(await tokens.getToken()).toBe('tok1');

    await vi.advanceTimersByTimeAsync(31 * 1000);
    expect(provider.calls).toBe(2);
    tokens.stop();
  });

  it('refuses an already-expired token and retries with backoff', async () => {
    vi.useFakeTimers();
    const provider = new CountingProvider(-1000, () => Date.now());
    const states: string[] = [];
    const tokens = new TokenManager(provider, {onState: (s) => states.push(s.kind)});

    await expect(tokens.getToken()).rejects.toThrow(/already expired/);
    await vi.advanceTimersByTimeAsync(29 * 1000);
    expect(provider.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 1000);
    expect(provider.calls).toBe(2);
    expect(states).toContain('error');
    tokens.stop();
  });

  it('keeps using an unexpired token while renewal fails', async () => {
    let now = 0;
    let fail = false;
    let calls = 0;
    const tokens = new TokenManager(
      {
        fetchToken: async () => {
          calls++;
          if (fail) {
            throw new Error('token server is down');
          }
          return {accessToken: `tok${calls}`, expiresAt: new Date(now + 60 * 60 * 1000)};
        },
      },
      {now: () => now}
    );
    expect(await tokens.getToken()).toBe('tok1');

    fail = true;
    now = 55 * 60 * 1000;
    expect(await tokens.getToken()).toBe('tok1');
    now = 61 * 60 * 1000;
    await expect(tokens.getToken()).rejects.toThrow('token server is down');
    tokens.stop();
  });

  it('fails fast instead of minting again during the backoff', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const tokens = new TokenManager({
      fetchToken: async () => {
        calls++;
        throw new Error('token server is down');
      },
    });

    await expect(tokens.getToken()).rejects.toThrow('token server is down');
    await expect(tokens.getToken()).rejects.toThrow('token server is down');
    await expect(tokens.renewToken()).rejects.toThrow('token server is down');
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(31 * 1000);
    expect(calls).toBe(2);
    tokens.stop();
  });

  it('schedules nothing after stop, even for a mint already in flight', async () => {
    vi.useFakeTimers();
    let release = (): void => {};
    const provider: TokenProvider = {
      fetchToken: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({accessToken: 'tok', expiresAt: new Date(Date.now() + 60 * 60 * 1000)});
        }),
    };
    const fetchToken = vi.spyOn(provider, 'fetchToken');
    const tokens = new TokenManager(provider);
    const pending = tokens.getToken();
    tokens.stop();
    release();
    await pending;

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});

describe('Dropbox client', () => {
  it.each(['expired_access_token', 'missing_scope'])(
    'renews the token once after %s and retries',
    async (error) => {
      const seen: string[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        const auth = new Headers(init?.headers).get('Authorization') ?? '';
        seen.push(auth);
        if (auth === 'Bearer old') {
          return new Response(JSON.stringify({error_summary: `${error}/`}), {status: 401});
        }
        return Response.json({entries: [], cursor: 'c1', has_more: false});
      };
      let renewed = 0;
      const client = new DropboxClient({
        fetchImpl,
        tokens: {
          getToken: async () => 'old',
          renewToken: async () => {
            renewed++;
            return 'new';
          },
        },
      });

      expect(await client.listFolder('/p', true)).toEqual({
        entries: [],
        cursor: 'c1',
        hasMore: false,
      });
      expect(seen).toEqual(['Bearer old', 'Bearer new']);
      expect(renewed).toBe(1);
    }
  );

  it('downloads a file whose metadata has no .tag', async () => {
    const body = new TextEncoder().encode('hello');
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        headers: {
          'Dropbox-API-Result': JSON.stringify({
            id: 'id:a',
            path_lower: '/p/a.txt',
            path_display: '/p/a.txt',
            rev: 'r1',
            content_hash: hashBuffer(body),
            size: body.length,
            client_modified: '2026-10-21T00:00:00Z',
            server_modified: '2026-10-21T00:00:00Z',
          }),
        },
      });
    const client = new DropboxClient({
      fetchImpl,
      tokens: {getToken: async () => 'tok', renewToken: async () => 'tok'},
    });
    const dest = join(await mkdtemp(join(tmpdir(), 'foldersync-test-')), 'a.txt');

    const meta = await client.downloadToFile('/p/a.txt', dest);

    expect(meta.rev).toBe('r1');
    expect(await readFile(dest, 'utf8')).toBe('hello');
  });

  it('lists only files that can be downloaded', async () => {
    let body: unknown;
    const api = client(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({entries: [], cursor: 'c1', has_more: false});
    });

    await api.listFolder('/p', true);

    expect(body).toMatchObject({path: '/p', include_non_downloadable_files: false});
  });

  function client(fetchImpl: typeof fetch): DropboxClient {
    return new DropboxClient({
      fetchImpl,
      tokens: {getToken: async () => 'tok', renewToken: async () => 'tok'},
      sleep: async () => {},
    });
  }

  // A fetch that never answers, and fails once its signal aborts.
  function hangingFetch(): typeof fetch {
    return async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
  }

  it('gives up on a call Dropbox doesn’t answer', async () => {
    vi.useFakeTimers();
    const listing = client(hangingFetch()).listFolder('/p', true);
    const failed = expect(listing).rejects.toThrow(/didn’t answer in time/);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    await failed;
  });

  it('gives up on a download that stops sending data', async () => {
    vi.useFakeTimers();
    const body = new TextEncoder().encode('hello');
    const api = client(async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.slice(0, 2));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, {
        headers: {
          'Dropbox-API-Result': JSON.stringify({
            id: 'id:a',
            path_lower: '/p/a.txt',
            path_display: '/p/a.txt',
            rev: 'r1',
            content_hash: hashBuffer(body),
            size: body.length,
            client_modified: '2026-10-21T00:00:00Z',
            server_modified: '2026-10-21T00:00:00Z',
          }),
        },
      });
    });
    const dest = join(await mkdtemp(join(tmpdir(), 'foldersync-test-')), 'a.txt');
    const download = api.downloadToFile('/p/a.txt', dest);
    const failed = expect(download).rejects.toThrow(/stopped sending the file/);

    await vi.advanceTimersByTimeAsync(60 * 1000);

    await failed;
  });

  // File metadata as files/download returns it in Dropbox-API-Result.
  function fileMetaJson(body: Uint8Array, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: 'id:a',
      path_lower: '/p/a.txt',
      path_display: '/p/a.txt',
      rev: 'r1',
      content_hash: hashBuffer(body),
      size: body.length,
      client_modified: '2026-10-21T00:00:00Z',
      server_modified: '2026-10-21T00:00:00Z',
      ...overrides,
    });
  }

  it('rejects a download whose bytes don’t match its content hash', async () => {
    const meta = fileMetaJson(new TextEncoder().encode('hello'));
    const api = client(async () => new Response('hellX', {headers: {'Dropbox-API-Result': meta}}));
    const dest = join(await mkdtemp(join(tmpdir(), 'foldersync-test-')), 'a.txt');

    await expect(api.downloadToFile('/p/a.txt', dest)).rejects.toThrow(/content hash/);
    // The damaged bytes don't stay behind.
    expect(existsSync(dest)).toBe(false);
  });

  it('waits out a long Retry-After on a download without the idle timer giving up', async () => {
    vi.useFakeTimers();
    const body = new TextEncoder().encode('hello');
    let calls = 0;
    const api = new DropboxClient({
      fetchImpl: async () =>
        ++calls === 1
          ? new Response('{}', {status: 429, headers: {'Retry-After': '60'}})
          : new Response(body, {headers: {'Dropbox-API-Result': fileMetaJson(body)}}),
      tokens: {getToken: async () => 'tok', renewToken: async () => 'tok'},
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const dest = join(await mkdtemp(join(tmpdir(), 'foldersync-test-')), 'a.txt');
    const download = api.downloadToFile('/p/a.txt', dest);

    await vi.advanceTimersByTimeAsync(61_000);

    await expect(download).resolves.toMatchObject({rev: 'r1'});
  });

  it.each([
    ['a negative size', {size: -1}],
    ['a fractional size', {size: 1.5}],
    ['an invalid date', {server_modified: 'yesterday'}],
  ])('rejects file metadata with %s', async (_label, overrides) => {
    const body = new TextEncoder().encode('hello');
    const api = client(
      async () =>
        new Response(body, {headers: {'Dropbox-API-Result': fileMetaJson(body, overrides)}})
    );
    const dest = join(await mkdtemp(join(tmpdir(), 'foldersync-test-')), 'a.txt');

    await expect(api.downloadToFile('/p/a.txt', dest)).rejects.toThrow(/no valid/);
  });

  it('fails a call instead of retrying early when Retry-After is over a minute', async () => {
    const waits: number[] = [];
    let calls = 0;
    const api = new DropboxClient({
      fetchImpl: async () => {
        calls++;
        return new Response('{"error_summary": "too_many_requests/"}', {
          status: 429,
          headers: {'Retry-After': '3600'},
        });
      },
      tokens: {getToken: async () => 'tok', renewToken: async () => 'tok'},
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(api.listFolder('/p', true)).rejects.toThrow(/HTTP 429: too_many_requests/);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('leaves no timer running after a call finishes', async () => {
    vi.useFakeTimers();
    const api = client(async () => Response.json({entries: [], cursor: 'c1', has_more: false}));

    await api.listFolder('/p', true);

    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'http://tokens.example.com',
    'http://127.attacker.example',
    'https://user:password@tokens.example.com',
    'https://tokens.example.com/?key=1',
    'not a url',
  ])('refuses to send the connection key to %s', (url) => {
    expect(() => new HttpTokenProvider(url, 'key')).toThrow();
  });

  it('returns the token server URL normalized', () => {
    expect(checkTokenServerUrl(' https://tokens.example.com/ ')).toBe('https://tokens.example.com');
    expect(checkTokenServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  it('asks the token server for a token with the connection key', async () => {
    const seen: {url: string; method?: string; auth: string | null; redirect?: string}[] = [];
    const expiresAt = '2026-10-22T04:00:00.000Z';
    const provider = new HttpTokenProvider('http://127.0.0.1:8787', 'key-1', async (url, init) => {
      seen.push({
        url: String(url),
        method: init?.method,
        auth: new Headers(init?.headers).get('Authorization'),
        redirect: init?.redirect,
      });
      return Response.json({access_token: 'tok', expires_at: expiresAt});
    });

    expect(await provider.fetchToken()).toEqual({
      accessToken: 'tok',
      expiresAt: new Date(expiresAt),
    });
    // No redirects: one could lead to a host the URL check never saw.
    expect(seen).toEqual([
      {url: 'http://127.0.0.1:8787/token', method: 'POST', auth: 'Bearer key-1', redirect: 'error'},
    ]);
  });

  it.each([
    [
      'an HTTP error',
      () => Response.json({error: 'unknown connection key'}, {status: 401}),
      /HTTP 401: unknown connection key/,
    ],
    [
      'a response without a token',
      () => Response.json({expires_at: '2026-10-22T04:00:00Z'}),
      /no token or expiry/,
    ],
  ])('reports %s from the token server', async (_label, response, message) => {
    const provider = new HttpTokenProvider('http://127.0.0.1:8787', 'key-1', async () =>
      response()
    );
    await expect(provider.fetchToken()).rejects.toThrow(message);
  });

  // A fake content host for upload sessions. Records each route, its argument,
  // and the bytes sent; append can be made to fail once with a server error.
  function sessionFake(opts: {failFirstAppend?: boolean} = {}) {
    const calls: {route: string; arg: unknown; bytes: number}[] = [];
    let appends = 0;
    let stored = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const route = new URL(String(url)).pathname.replace('/2/', '');
      const arg: unknown = JSON.parse(new Headers(init?.headers).get('Dropbox-API-Arg') ?? '{}');
      const body = init?.body;
      const bytes = body instanceof Uint8Array ? body.length : 0;
      calls.push({route, arg, bytes});
      if (route === 'files/upload_session/start') {
        stored += bytes;
        return Response.json({session_id: 's1'});
      }
      if (route === 'files/upload_session/append_v2') {
        appends++;
        if (appends === 1 && opts.failFirstAppend) {
          // The chunk lands, but the response is lost.
          stored += bytes;
          return new Response('{"error_summary": "internal/"}', {status: 500});
        }
        if (appends === 2 && opts.failFirstAppend) {
          return Response.json(
            {
              error_summary: 'incorrect_offset/',
              error: {'.tag': 'incorrect_offset', correct_offset: stored},
            },
            {status: 409}
          );
        }
        stored += bytes;
        return Response.json(null);
      }
      return Response.json({
        id: 'id:big',
        path_lower: '/p/big.bin',
        path_display: '/p/big.bin',
        rev: 'r1',
        content_hash: 'h',
        size: stored + bytes,
        client_modified: '2026-10-21T00:00:00Z',
        server_modified: '2026-10-21T00:00:00Z',
      });
    };
    return {calls, fetchImpl};
  }

  async function bigFile(bytes: number): Promise<string> {
    const path = join(await mkdtemp(join(tmpdir(), 'foldersync-test-')), 'big.bin');
    await writeFile(path, Buffer.alloc(bytes, 1));
    return path;
  }

  const CHUNK = 16 * 1024 * 1024;

  it('uploads a file one byte over a chunk as a session start and finish', async () => {
    const fake = sessionFake();
    let checks = 0;
    const meta = await client(fake.fetchImpl).upload({
      localPath: await bigFile(CHUNK + 1),
      dropboxPath: '/p/big.bin',
      mode: {kind: 'add'},
      clientModified: new Date(),
      contentHash: 'h',
      checkUnchanged: async () => {
        checks++;
      },
    });

    expect(fake.calls.map((c) => [c.route, c.bytes])).toEqual([
      ['files/upload_session/start', CHUNK],
      ['files/upload_session/finish', 1],
    ]);
    expect(fake.calls[1]?.arg).toMatchObject({cursor: {session_id: 's1', offset: CHUNK}});
    expect(checks).toBeGreaterThan(0);
    expect(meta.size).toBe(CHUNK + 1);
  });

  it('sends each upload session call the hash of its own bytes', async () => {
    const fake = sessionFake();

    await client(fake.fetchImpl).upload({
      localPath: await bigFile(2 * CHUNK + 1),
      dropboxPath: '/p/big.bin',
      mode: {kind: 'add'},
      clientModified: new Date(),
      contentHash: 'h',
      checkUnchanged: async () => {},
    });

    const chunk = hashBuffer(Buffer.alloc(CHUNK, 1));
    expect(fake.calls.map((c) => [c.route, Reflect.get(Object(c.arg), 'content_hash')])).toEqual([
      ['files/upload_session/start', chunk],
      ['files/upload_session/append_v2', chunk],
      ['files/upload_session/finish', hashBuffer(Buffer.alloc(1, 1))],
    ]);
  });

  it('carries on when a retried append finds its chunk already there', async () => {
    const fake = sessionFake({failFirstAppend: true});

    const meta = await client(fake.fetchImpl).upload({
      localPath: await bigFile(2 * CHUNK + 1),
      dropboxPath: '/p/big.bin',
      mode: {kind: 'add'},
      clientModified: new Date(),
      contentHash: 'h',
      checkUnchanged: async () => {},
    });

    const finish = fake.calls.at(-1);
    expect(finish?.route).toBe('files/upload_session/finish');
    expect(finish?.arg).toMatchObject({cursor: {offset: 2 * CHUNK}});
    expect(meta.size).toBe(2 * CHUNK + 1);
  });

  it('gives up waiting to retry when the call’s deadline passes', async () => {
    vi.useFakeTimers();
    const api = new DropboxClient({
      fetchImpl: async () => new Response('{}', {status: 429, headers: {'Retry-After': '30'}}),
      tokens: {getToken: async () => 'tok', renewToken: async () => 'tok'},
      // A wait that never ends, unless the deadline cuts it short.
      sleep: () => new Promise(() => {}),
    });
    const listing = api.listFolder('/p', true);
    const failed = expect(listing).rejects.toThrow(/didn’t answer in time/);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    await failed;
  });

  it('reuses a token another request already renewed when a late 401 arrives', async () => {
    let current = 'old';
    let mints = 0;
    let releaseLate = (): void => {};
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const api = new DropboxClient({
      fetchImpl: async (_url, init) => {
        if (new Headers(init?.headers).get('Authorization') === 'Bearer old') {
          // The listing of /q answers only after /p has renewed the token.
          if (String(init?.body).includes('"/q"')) {
            await late;
          }
          return new Response('{"error_summary": "expired_access_token/"}', {status: 401});
        }
        return Response.json({entries: [], cursor: 'c1', has_more: false});
      },
      tokens: {
        getToken: async () => current,
        renewToken: async () => {
          mints++;
          current = `new-${mints}`;
          return current;
        },
      },
    });
    const first = api.listFolder('/p', true);
    const second = api.listFolder('/q', true);

    await first;
    releaseLate();
    await second;

    expect(mints).toBe(1);
  });

  it('gives up when a token renewal outlasts the call’s deadline', async () => {
    vi.useFakeTimers();
    const api = new DropboxClient({
      fetchImpl: async () => new Response('expired_access_token', {status: 401}),
      // A renewal that never answers.
      tokens: {getToken: async () => 'tok', renewToken: () => new Promise(() => {})},
    });
    const listing = api.listFolder('/p', true);
    const failed = expect(listing).rejects.toThrow(/didn’t answer in time/);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    await failed;
  });

  it('rejects a listing without has_more instead of treating it as complete', async () => {
    const api = client(async () => Response.json({entries: [], cursor: 'c1'}));
    await expect(api.listFolder('/p', true)).rejects.toThrow(/incomplete list_folder/);
  });

  it('does not replay an upload after a server error', async () => {
    let calls = 0;
    const api = client(async () => {
      calls++;
      return new Response('{"error_summary": "internal/"}', {status: 500});
    });
    const dir = await mkdtemp(join(tmpdir(), 'foldersync-test-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'a');
    await expect(
      api.upload({
        localPath: path,
        dropboxPath: '/p/a.txt',
        mode: {kind: 'add'},
        clientModified: new Date(),
        contentHash: hashBuffer(new TextEncoder().encode('a')),
        checkUnchanged: async () => {},
      })
    ).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(1);
  });

  it('treats only an existing folder as success when creating a folder', async () => {
    const conflict =
      (summary: string): typeof fetch =>
      async () =>
        new Response(JSON.stringify({error_summary: summary}), {status: 409});
    await expect(
      client(conflict('path/conflict/folder/..')).createFolder('/p/a')
    ).resolves.toBeUndefined();
    await expect(client(conflict('path/conflict/file/..')).createFolder('/p/a')).rejects.toThrow(
      /conflict\/file/
    );
  });

  it('retries a file delete with parent_rev but not a folder delete', async () => {
    const calls: string[] = [];
    const api = client(async (_url, init) => {
      calls.push(String(init?.body));
      return new Response('{"error_summary": "internal/"}', {status: 500});
    });
    await expect(api.deleteV2('/p/folder')).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    await expect(api.deleteV2('/p/a.txt', 'r1')).rejects.toThrow(/HTTP 500/);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('refuses to hash through a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foldersync-test-'));
    await writeFile(join(dir, 'real.txt'), 'secret');
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'));
    await expect(hashFile(join(dir, 'link.txt'))).rejects.toThrow(/ELOOP|symbolic link/i);
  });
});

describe('HttpAgentDirectory', () => {
  // A token server that answers /project-agent from a map, like the real one.
  function server(records: Record<string, string> = {}) {
    const calls: {url: string; auth: string | null; body: unknown; redirect?: string}[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get('Authorization'),
        body,
        redirect: init?.redirect,
      });
      const project = String(Reflect.get(Object(body), 'project')).toLowerCase();
      const agentId: unknown = Reflect.get(Object(body), 'agent_id');
      if (typeof agentId === 'string' && !(project in records)) {
        records[project] = agentId;
      }
      return Response.json({agent_id: records[project] ?? ''});
    };
    return {calls, fetchImpl};
  }

  it('looks up and claims a project’s agent with the connection key', async () => {
    const s = server();
    const directory = new HttpAgentDirectory('http://127.0.0.1:8787', 'key-1', s.fetchImpl);

    expect(await directory.recorded('/storyboard')).toBeUndefined();
    expect(await directory.claim('/storyboard', 'agent-1')).toBe('agent-1');
    expect(await directory.claim('/storyboard', 'agent-2')).toBe('agent-1');
    expect(await directory.recorded('/storyboard')).toBe('agent-1');

    expect(s.calls[1]).toEqual({
      url: 'http://127.0.0.1:8787/project-agent',
      auth: 'Bearer key-1',
      body: {project: '/storyboard', agent_id: 'agent-1'},
      redirect: 'error',
    });
  });

  it('reports token server errors and a missing agent_id', async () => {
    const failing = new HttpAgentDirectory('http://127.0.0.1:8787', 'key-1', async () =>
      Response.json({error: 'unknown connection key'}, {status: 401})
    );
    const empty = new HttpAgentDirectory('http://127.0.0.1:8787', 'key-1', async () =>
      Response.json({})
    );

    await expect(failing.recorded('/storyboard')).rejects.toThrow(
      /HTTP 401: unknown connection key/
    );
    await expect(empty.recorded('/storyboard')).rejects.toThrow(/no agent_id/);
  });

  it('refuses to send the connection key to a token server URL it can’t trust', () => {
    expect(() => new HttpAgentDirectory('http://tokens.example.com', 'key-1')).toThrow();
  });
});
