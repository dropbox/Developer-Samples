// The app's credentials file: JSON, mode 0600, in a 0700 folder, replaced
// atomically.
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export interface Credentials {
  tokenServerUrl: string;
  // The secret the app sends to the token server to get this user's tokens.
  connectionKey: string;
  // From the token server's sign-in response, for display.
  userName?: string;
  userPublicId?: string;
  accessToken?: string;
  expiresAt?: string;
}

export async function loadCredentials(path: string): Promise<Credentials | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
  const invalid = new Error(
    `${path} isn’t a valid credentials file. Delete it, then start FolderSync again to sign in.`
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid;
  }
  const field = (key: string): string | undefined => {
    if (typeof parsed === 'object' && parsed !== null && key in parsed) {
      const value: unknown = Reflect.get(parsed, key);
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  };
  const tokenServerUrl = field('tokenServerUrl');
  const connectionKey = field('connectionKey');
  if (!tokenServerUrl || !connectionKey) {
    throw invalid;
  }
  return {
    tokenServerUrl,
    connectionKey,
    userName: field('userName'),
    userPublicId: field('userPublicId'),
    accessToken: field('accessToken'),
    expiresAt: field('expiresAt'),
  };
}

export async function saveCredentials(path: string, creds: Credentials): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, {recursive: true, mode: 0o700});
  // mkdir's mode applies only to a new folder.
  await chmod(dir, 0o700);
  // A new file of our own, so its mode is 0600 whatever was there before.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, {force: true});
    throw err;
  }
}
