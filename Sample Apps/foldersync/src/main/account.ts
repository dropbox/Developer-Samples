// The signed-in managed user: signing in through the token server, and keeping
// the user's access token fresh.
//
// In this sample, the token server stands in for your backend. It holds the app
// key and secret, creates managed users, and mints their tokens with
// /2/agent_filesystem/users/access_token/mint. The app only ever has the
// short-lived user token and a connection key that identifies it to the server.
import {rm} from 'node:fs/promises';

import {loadCredentials, saveCredentials, type Credentials} from '../engine/credentials';
import {DropboxClient} from '../engine/dropboxApi';
import {
  HttpAgentDirectory,
  HttpTokenProvider,
  TokenManager,
  checkTokenServerUrl,
} from '../engine/tokenManager';
import type {SetupInfo, SignInResult, TokenServerStatus, TokenState} from '../shared/types';
import type {Settings} from './config';

const DEFAULT_TOKEN_SERVER = 'http://127.0.0.1:8787';

export interface AccountOptions {
  credentialsPath: string;
  settings: Settings;
  onTokenState: (state: TokenState) => void;
  // Called when the signed-in user changes or signs out.
  onUserChanged: () => void;
  // The token server start.sh started. It replaces the saved URL.
  tokenServerUrl?: string;
  fetchImpl?: typeof fetch;
}

function stringField(body: unknown, key: string): string | undefined {
  const value: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, key) : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// The token server URL, checked before the connection key is sent to it.
export function serverUrl(raw: unknown, fallback = DEFAULT_TOKEN_SERVER): string {
  return checkTokenServerUrl(typeof raw === 'string' && raw.trim() ? raw.trim() : fallback);
}

export class Account {
  private credentials: Credentials | undefined;
  private tokens: TokenManager | undefined;
  // Bumped when the token manager stops. A renewal that finishes after sign-out
  // or another sign-in belongs to an old generation and is ignored.
  private generation = 0;
  // The credentials save in progress, so sign-out can wait for it.
  private saving: Promise<void> = Promise.resolve();
  // Sign-in, sign-out, and account deletion run one at a time, so one can't
  // finish its writes after a later one.
  private changes: Promise<unknown> = Promise.resolve();
  private state: TokenState = {kind: 'missing'};
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AccountOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // Signs back in with the saved credentials, if any.
  async load(): Promise<void> {
    const creds = await loadCredentials(this.opts.credentialsPath);
    if (creds) {
      this.start({
        ...creds,
        tokenServerUrl: serverUrl(this.opts.tokenServerUrl ?? creds.tokenServerUrl),
      });
    }
  }

  get tokenState(): TokenState {
    return this.state;
  }

  setupInfo(): SetupInfo {
    return {
      tokenServerUrl:
        this.opts.tokenServerUrl ??
        this.credentials?.tokenServerUrl ??
        this.opts.settings.tokenServerUrl ??
        DEFAULT_TOKEN_SERVER,
      signedIn: this.credentials !== undefined,
      userName: this.credentials?.userName,
      lastUserName: this.opts.settings.lastUserName,
      label: process.env.FOLDERSYNC_LABEL || undefined,
    };
  }

  // The signed-in managed user's ID, which sync state is recorded under.
  userPublicId(): string {
    const id = this.credentials?.userPublicId;
    if (!id) {
      throw new Error(this.credentials ? 'Sign out, then sign in again.' : 'Sign in first.');
    }
    return id;
  }

  // Where the token server records the signed-in user's project agents.
  agentDirectory(): HttpAgentDirectory {
    if (!this.credentials) {
      throw new Error('Sign in first.');
    }
    const {tokenServerUrl, connectionKey} = this.credentials;
    return new HttpAgentDirectory(tokenServerUrl, connectionKey, this.fetchImpl);
  }

  // A client that calls Dropbox as the managed user.
  userClient(): DropboxClient {
    if (!this.tokens) {
      throw new Error('Sign in first.');
    }
    return new DropboxClient({tokens: this.tokens});
  }

  // Runs an account change after any earlier one finishes.
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const run = this.changes.then(change, change);
    this.changes = run.catch(() => {});
    return run;
  }

  // Signs in by name. The token server creates the managed user the first time.
  signIn(rawName: unknown, rawUrl: unknown): Promise<SignInResult> {
    return this.serial(() => this.signInNow(rawName, rawUrl));
  }

  private async signInNow(rawName: unknown, rawUrl: unknown): Promise<SignInResult> {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      throw new Error('Enter a name.');
    }
    const tokenServerUrl = serverUrl(rawUrl, this.opts.tokenServerUrl);
    const body = await this.callTokenServer(tokenServerUrl, '/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    const connectionKey = stringField(body, 'connection_key');
    if (!connectionKey) {
      throw new Error('The token server’s sign-in response has no connection key.');
    }
    // Sync state is recorded under this ID, so a sign-in without it can't sync.
    const userPublicId = stringField(body, 'user_public_id');
    if (!userPublicId) {
      throw new Error('The token server’s sign-in response has no user public ID.');
    }
    const creds: Credentials = {
      tokenServerUrl,
      connectionKey,
      userName: stringField(body, 'name') ?? name,
      userPublicId,
    };
    // Stop the current account's renewals first, so a late one can't save its
    // credentials over these.
    const previous = this.credentials;
    const {lastUserName, tokenServerUrl: previousUrl} = this.opts.settings;
    this.stopTokens();
    await this.saving;
    try {
      // Settings first: a failure here leaves credentials.json untouched.
      this.opts.settings.lastUserName = creds.userName;
      this.opts.settings.tokenServerUrl = tokenServerUrl;
      await this.opts.settings.save();
      await saveCredentials(this.opts.credentialsPath, creds);
    } catch (err) {
      this.opts.settings.lastUserName = lastUserName;
      this.opts.settings.tokenServerUrl = previousUrl;
      if (previous) {
        this.start(previous);
      }
      throw err;
    }
    this.start(creds);
    const created =
      typeof body === 'object' && body !== null && Reflect.get(body, 'created') === true;
    return {setup: this.setupInfo(), created};
  }

  // Signs out. The name and token server URL are kept for next time.
  signOut(): Promise<void> {
    return this.serial(() => this.signOutNow());
  }

  private async signOutNow(): Promise<void> {
    const creds = this.credentials;
    this.stopTokens();
    await this.saving;
    try {
      await rm(this.opts.credentialsPath, {force: true});
    } catch (err) {
      // Still signed in: the saved credentials are still there.
      if (creds) {
        this.start(creds);
      }
      throw err;
    }
    this.credentials = undefined;
    this.setState({kind: 'missing'});
  }

  // Deletes the managed user and all its files from Dropbox, then signs out.
  deleteAccount(): Promise<void> {
    return this.serial(() => this.deleteAccountNow());
  }

  private async deleteAccountNow(): Promise<void> {
    if (!this.credentials) {
      throw new Error('Sign in first.');
    }
    await this.callTokenServer(this.credentials.tokenServerUrl, '/delete-account', {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.credentials.connectionKey}`},
    });
    // The account is gone, so sign out even if the files below can't change.
    this.stopTokens();
    await this.saving;
    this.credentials = undefined;
    this.setState({kind: 'missing'});
    this.opts.settings.lastUserName = undefined;
    const results = await Promise.allSettled([
      rm(this.opts.credentialsPath, {force: true}),
      this.opts.settings.save(),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      const reason: unknown = failed.reason;
      throw new Error(
        `The account was deleted, but cleaning up on this computer failed: ${reason instanceof Error ? reason.message : String(reason)}`
      );
    }
  }

  async tokenServerStatus(rawUrl: unknown): Promise<TokenServerStatus> {
    try {
      const res = await this.fetchImpl(`${serverUrl(rawUrl, this.opts.tokenServerUrl)}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      const appKey = stringField(await res.json(), 'app_key');
      return res.ok && appKey ? {running: true, appKey} : {running: false};
    } catch {
      return {running: false};
    }
  }

  onWake(): void {
    this.tokens?.onWake();
  }

  // Starts renewing the user's token, beginning with the saved one if it's
  // still valid.
  private start(creds: Credentials): void {
    this.stopTokens();
    this.credentials = creds;
    const initial =
      creds.accessToken && creds.expiresAt
        ? {accessToken: creds.accessToken, expiresAt: new Date(creds.expiresAt)}
        : undefined;
    const generation = this.generation;
    this.tokens = new TokenManager(
      new HttpTokenProvider(creds.tokenServerUrl, creds.connectionKey, this.fetchImpl),
      {
        onState: (state) => {
          if (this.generation === generation) {
            this.setState(state);
          }
        },
        onToken: async (token) => {
          if (this.generation !== generation) {
            return;
          }
          this.credentials = {
            ...creds,
            accessToken: token.accessToken,
            expiresAt: token.expiresAt.toISOString(),
          };
          const save = saveCredentials(this.opts.credentialsPath, this.credentials);
          this.saving = save.catch(() => {});
          await save;
        },
      },
      initial
    );
    // Without a saved token that's still valid, get one now, so the token state
    // is this account's, not the previous one's.
    if (!initial || initial.expiresAt.getTime() <= Date.now()) {
      this.tokens.renewToken().catch(() => {});
    }
  }

  private stopTokens(): void {
    this.generation++;
    this.tokens?.stop();
    this.tokens = undefined;
    this.opts.onUserChanged();
  }

  private setState(state: TokenState): void {
    this.state = state;
    this.opts.onTokenState(state);
  }

  // Calls the token server, turning network errors into a plain message.
  private async callTokenServer(
    baseUrl: string,
    path: string,
    init: RequestInit
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}${path}`, {
        ...init,
        // A redirect could lead to a host serverUrl never checked.
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new Error(
        `Can’t reach the token server at ${baseUrl}. Start FolderSync with “npm start” or start.sh, which starts it.`
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const message = stringField(body, 'error');
      throw new Error(message ?? `The token server returned HTTP ${res.status}.`);
    }
    return body;
  }
}
