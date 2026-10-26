// Gets managed-user tokens from the token server and renews them before they
// expire. The app never mints tokens itself.
import type {TokenState} from '../shared/types';
import type {AgentDirectory} from './agents';
import type {TokenSource} from './dropboxApi';

export interface MintedToken {
  accessToken: string;
  expiresAt: Date;
}

export interface TokenProvider {
  fetchToken(): Promise<MintedToken>;
}

// Calls the token server's POST /token with the connection key.
// Checks a token server URL before the connection key is sent to it. Plain
// HTTP is allowed only to this computer, because the key and tokens would
// cross the network unencrypted. Returns the URL without a trailing slash.
export function checkTokenServerUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`“${text}” isn’t a valid token server URL.`);
  }
  // An IPv4 address in 127.0.0.0/8, not a hostname like 127.example.com.
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use an https:// token server URL, or http:// to localhost or 127.0.0.1.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The token server URL can’t include a user name, password, query, or fragment.'
    );
  }
  return url.href.replace(/\/+$/, '');
}

export class HttpTokenProvider implements TokenProvider {
  private readonly serverUrl: string;

  constructor(
    serverUrl: string,
    private readonly connectionKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.serverUrl = checkTokenServerUrl(serverUrl);
  }

  async fetchToken(): Promise<MintedToken> {
    const field = await callTokenServer(
      this.serverUrl,
      this.connectionKey,
      '/token',
      this.fetchImpl
    );
    const accessToken = field('access_token');
    const expiresAt = new Date(field('expires_at') ?? '');
    if (!accessToken || Number.isNaN(expiresAt.getTime())) {
      throw new Error('The token server’s response has no token or expiry.');
    }
    return {accessToken, expiresAt};
  }
}

// The token server also records each project's agent; see AgentDirectory.
export class HttpAgentDirectory implements AgentDirectory {
  private readonly serverUrl: string;

  constructor(
    serverUrl: string,
    private readonly connectionKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.serverUrl = checkTokenServerUrl(serverUrl);
  }

  async recorded(folder: string): Promise<string | undefined> {
    return (await this.call({project: folder})) || undefined;
  }

  async claim(folder: string, agentId: string): Promise<string> {
    const recorded = await this.call({project: folder, agent_id: agentId});
    if (!recorded) {
      throw new Error('The token server didn’t record the project’s agent.');
    }
    return recorded;
  }

  private async call(arg: {project: string; agent_id?: string}): Promise<string> {
    const field = await callTokenServer(
      this.serverUrl,
      this.connectionKey,
      '/project-agent',
      this.fetchImpl,
      arg
    );
    const agentId = field('agent_id');
    if (agentId === undefined) {
      throw new Error('The token server’s response has no agent_id.');
    }
    return agentId;
  }
}

// POSTs to a token server route with the connection key, and returns a reader
// for the response's string fields. Throws for an HTTP error.
async function callTokenServer(
  serverUrl: string,
  connectionKey: string,
  route: string,
  fetchImpl: typeof fetch,
  arg?: unknown
): Promise<(key: string) => string | undefined> {
  let res: Response;
  try {
    res = await fetchImpl(`${serverUrl}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connectionKey}`,
        ...(arg === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      ...(arg === undefined ? {} : {body: JSON.stringify(arg)}),
      // A redirect could lead to a host checkTokenServerUrl never saw.
      redirect: 'error',
      // Covers reading the response too, so a stalled server can't hold a call forever.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`Can’t reach the token server at ${serverUrl}. Is it running?`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`The token server at ${serverUrl} didn’t answer in time.`);
    }
    body = undefined;
  }
  const field = (key: string): string | undefined => {
    if (typeof body === 'object' && body !== null && key in body) {
      const value: unknown = Reflect.get(body, key);
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  };
  if (!res.ok) {
    throw new Error(
      `The token server returned HTTP ${res.status}: ${field('error') ?? 'no details'}`
    );
  }
  return field;
}

// Renew this long before the token expires. A token that lives less than
// twice this long is renewed halfway through its life instead.
export const RENEW_BEFORE_MS = 10 * 60 * 1000;
const FIRST_RETRY_MS = 30 * 1000;
const MAX_RETRY_MS = 5 * 60 * 1000;

export interface TokenManagerOptions {
  now?: () => number;
  // Saves a new token, for example to the credentials file.
  onToken?: (token: MintedToken) => Promise<void>;
  onState?: (state: TokenState) => void;
}

// Keeps a short-lived, non-refreshable token fresh: it mints a new one from the
// provider before the current one expires, when the computer wakes, and when a
// request reports the token expired. Failed mints are retried with backoff.
export class TokenManager implements TokenSource {
  private current: MintedToken | undefined;
  // When to mint the next token, in ms since the epoch.
  private renewAt = 0;
  private inflight: Promise<string> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = FIRST_RETRY_MS;
  // After a failed mint, no new mint before this time; callers get lastError.
  private retryNotBefore = 0;
  private lastError: unknown;
  private stopped = false;
  private readonly now: () => number;

  constructor(
    private readonly provider: TokenProvider,
    private readonly opts: TokenManagerOptions = {},
    initial?: MintedToken
  ) {
    this.now = opts.now ?? Date.now;
    if (initial && initial.expiresAt.getTime() > this.now()) {
      this.use(initial);
    }
  }

  async getToken(): Promise<string> {
    if (this.current && !this.needsRenewal()) {
      return this.current.accessToken;
    }
    try {
      return await this.renewToken();
    } catch (err) {
      // Keep using the current token until it expires, for example while the
      // token server is down.
      if (this.current && this.current.expiresAt.getTime() > this.now()) {
        return this.current.accessToken;
      }
      throw err;
    }
  }

  // Mints a new token. Callers that ask at the same time share one mint.
  // During the backoff after a failed mint, it fails fast with that error.
  renewToken(): Promise<string> {
    if (!this.inflight && this.now() < this.retryNotBefore) {
      return Promise.reject(this.lastError);
    }
    this.inflight ??= this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  // Called when the computer wakes or the network comes back.
  onWake(): void {
    if (this.needsRenewal()) {
      this.renewToken().catch(() => {});
    }
  }

  // Stops scheduled renewals, including one that a mint in flight would set.
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private needsRenewal(): boolean {
    return !this.current || this.now() >= this.renewAt;
  }

  // Starts using a token and schedules its renewal.
  private use(token: MintedToken): void {
    const lifetime = token.expiresAt.getTime() - this.now();
    this.current = token;
    this.renewAt = this.now() + Math.max(lifetime - RENEW_BEFORE_MS, lifetime / 2);
    this.opts.onState?.({kind: 'valid', expiresAt: token.expiresAt.toISOString()});
    this.schedule(this.renewAt - this.now());
  }

  private async mint(): Promise<string> {
    this.opts.onState?.({kind: 'renewing'});
    try {
      const token = await this.provider.fetchToken();
      if (!(token.expiresAt.getTime() > this.now())) {
        throw new Error('The new token has already expired.');
      }
      await this.opts.onToken?.(token);
      this.retryMs = FIRST_RETRY_MS;
      this.retryNotBefore = 0;
      this.use(token);
      return token.accessToken;
    } catch (err) {
      this.opts.onState?.({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      this.lastError = err;
      this.retryNotBefore = this.now() + this.retryMs;
      this.schedule(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
      throw err;
    }
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.renewToken().catch(() => {});
      },
      Math.max(delayMs, 0)
    );
    this.timer.unref?.();
  }
}
