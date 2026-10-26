// Starts FolderSync for development: starts the token server if it isn't
// running, then the app, and stops the token server when the app quits. The
// app secret goes to the token server over stdin and is never saved; the app
// itself never sees it. FOLDERSYNC_PORT sets the token server's port.
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.FOLDERSYNC_PORT || '8787';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error(`FOLDERSYNC_PORT must be a port number from 1 to 65535, not “${port}”.`);
}
const tokenServerUrl = `http://127.0.0.1:${port}`;
const home = process.env.FOLDERSYNC_HOME ?? join(homedir(), '.foldersync');
const appKeyPath = join(home, 'tokenserver', 'app_key');
const tokenServerBin = process.env.FOLDERSYNC_TOKENSERVER ?? join(root, 'out', 'tokenserver');

async function tokenServerRunning() {
  try {
    const res = await fetch(`${tokenServerUrl}/health`, {signal: AbortSignal.timeout(1000)});
    return res.ok;
  } catch {
    return false;
  }
}

function savedAppKey() {
  try {
    return readFileSync(appKeyPath, 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      return '';
    }
    throw new Error(`Can’t read the saved app key in ${appKeyPath}: ${err.message}`);
  }
}

async function askAppKey() {
  if (process.env.DBX_APP_KEY) {
    return process.env.DBX_APP_KEY;
  }
  const saved = savedAppKey();
  const rl = createInterface({input: process.stdin, output: process.stdout});
  // Shows only the start of the saved key, so it stays out of screen recordings.
  const prompt = saved ? `App key [${saved.slice(0, 4)}••••]: ` : 'App key: ';
  const answer = (await rl.question(prompt)).trim();
  rl.close();
  return answer || saved;
}

// Reads a line from the terminal without echoing it.
function askSecret(prompt) {
  if (process.env.DBX_APP_SECRET) {
    return Promise.resolve(process.env.DBX_APP_SECRET);
  }
  if (!process.stdin.isTTY) {
    throw new Error('Run npm start in a terminal, or set DBX_APP_SECRET.');
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let secret = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(secret);
          return;
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        secret = c === '\u007f' || c === '\b' ? secret.slice(0, -1) : secret + c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function startTokenServer() {
  const appKey = await askAppKey();
  const appSecret = await askSecret('App secret (hidden): ');
  if (!appKey || !appSecret) {
    throw new Error('The app key and app secret are required.');
  }
  mkdirSync(dirname(appKeyPath), {recursive: true, mode: 0o700});
  writeFileSync(appKeyPath, `${appKey}\n`, {mode: 0o600});

  console.log('Starting the token server…');
  const child = spawn(
    tokenServerBin,
    ['serve', '-app-key', appKey, '-app-secret-stdin', '-listen', `127.0.0.1:${port}`],
    {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {...process.env, DBX_APP_SECRET: ''},
    }
  );
  let failure;
  child.on('error', (err) => {
    failure = new Error(`Couldn’t start ${tokenServerBin}: ${err.message}`);
  });
  child.on('exit', () => {
    failure ??= new Error('The token server stopped. See its message above.');
  });
  child.stdin.on('error', () => {});
  // Stop the token server if this script is stopped before the app starts.
  const stopChild = () => child.kill('SIGTERM');
  process.once('SIGINT', stopChild);
  process.once('SIGTERM', stopChild);
  child.stdin.end(`${appSecret}\n`);
  // Longer than the token server's own 15-second check with Dropbox.
  for (let i = 0; i < 200; i++) {
    if (failure) {
      throw failure;
    }
    if (await tokenServerRunning()) {
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill('SIGTERM');
  throw new Error('The token server didn’t start within 30 seconds.');
}

async function main() {
  let tokenServer;
  if (await tokenServerRunning()) {
    console.log(`Using the token server that’s already running at ${tokenServerUrl}.`);
  } else {
    tokenServer = await startTokenServer();
  }

  let app;
  try {
    const electron = createRequire(import.meta.url)('electron');
    const env = {...process.env, FOLDERSYNC_PORT: port};
    delete env.DBX_APP_SECRET;
    app = spawn(electron, [root], {stdio: 'inherit', env});
  } catch (err) {
    tokenServer?.kill('SIGTERM');
    throw err;
  }

  // Same lifecycle as the app: stop the token server this script started,
  // however the app ends, including if it can't start at all.
  const finish = (code, err) => {
    tokenServer?.kill('SIGTERM');
    if (err) {
      console.error(`Couldn’t start FolderSync: ${err.message}`);
    }
    process.exit(code);
  };
  app.on('error', (err) => finish(1, err));
  // code is null when a signal ended the app, for example a crash.
  app.on('exit', (code) => finish(code ?? 1));
  const stop = () => app.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
