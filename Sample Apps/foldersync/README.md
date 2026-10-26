# FolderSync

FolderSync is a sample desktop app that keeps a project folder on your Mac in
sync with a managed user's Dropbox over API v2. It shows how an app can use
Dropbox managed users and AgentFS agents to upload, download, sync, and undo
changes.

> [!IMPORTANT]
> FolderSync is sample code for learning Dropbox managed users and AgentFS, not
> a supported product. Its token server signs users in by name only, so don't
> deploy it: build its endpoints into your own backend, behind your own sign-in.

It runs on macOS on Apple silicon. Syncing happens when you click **Sync now**.

Contents:

- [Part 1: Try FolderSync](#part-1-try-foldersync): set it up, run it, and use it
- [Part 2: Build it into your app](#part-2-build-it-into-your-app): the code to copy, and how tokens and agents work
- [Part 3: Reference](#part-3-reference): how it fits together, the token server, and building and testing the sample

## Part 1: Try FolderSync

### Before you start

You need a Dropbox app that's set up for managed users, with the
`private:agent_filesystem.agents.manage` and
`private:agent_filesystem.agents.restore` scopes. You'll use its **app key**
and **app secret**. Ask your Dropbox contact if you aren't sure your app is set up.

### Run FolderSync

#### From the zip file

The zip has a `FolderSync` folder with:

| File | What it is |
|---|---|
| `start.sh` | Starts the token server and FolderSync, and stops the token server when FolderSync quits |
| `FolderSync.app` | The desktop app |
| `tokenserver` | The token server. It holds your Dropbox app secret while it runs |
| `README.md` | This file |

Unzip it by double-clicking it in Finder, or in Terminal, then start it:

```sh
cd ~/Downloads
unzip FolderSync-mac-arm64.zip
cd FolderSync
./start.sh
```

`start.sh` asks for your **app key** (remembered for next time) and your **app
secret** (hidden as you type, never saved). Then it starts the token server and
opens FolderSync. **Leave the Terminal window open** while you use FolderSync.
When you quit FolderSync, the token server stops too.

`start.sh` also removes the flag macOS puts on downloaded files. The files
aren't notarized, so macOS won't run them while the flag is set.

#### From source

You need Node.js 24 or later and Go 1.25 or later. In the `foldersync` folder:

```sh
npm install                  # first time only
npm run build:tokenserver    # builds the token server into out/tokenserver
npm start
```

`out/` is gitignored.

`npm start` builds the app and runs `scripts/start.mjs`, which:

1. Reuses the token server if one is already running.
2. Otherwise asks for the app key and secret, like `start.sh`, and starts
   `out/tokenserver serve`. The app secret goes over stdin, so it doesn't show
   up in `ps` or the environment. The token server checks the key and secret
   with Dropbox before it starts.
3. Opens the FolderSync window. The app never sees the app secret.
4. Stops the token server when you quit the app, or press Ctrl-C.

For a non-interactive run, set `DBX_APP_KEY` and `DBX_APP_SECRET` instead.
`npm run app` starts only the app, for when a token server is already running.

Only one FolderSync window runs at a time; starting it again brings the open
window forward.

#### Use another port

The token server listens on `127.0.0.1:8787`. To use another port, set
`FOLDERSYNC_PORT`. `start.sh` and `npm start` start the token server on it and
tell FolderSync where to find it:

```sh
FOLDERSYNC_PORT=8788 ./start.sh     # or: FOLDERSYNC_PORT=8788 npm start
```

### Use FolderSync

#### Sign in

Type a name and click **Sign in**.

- A new name creates a new managed user for you.
- A name you used before signs you back in to the same managed user, with the
  same files.

Sign-in is by name only, so use FolderSync on a computer only you use: anyone
who can reach the token server and knows a name can get that user's tokens. In
your own product, use your real sign-in.

#### Sync a project

A project is a top-level folder in the managed user's Dropbox.

1. Type a name under **Projects**, for example `storyboard`, and click **+**.
2. Click the project, then click **Sync now**.
3. Files sync to `~/FolderSync/storyboard`. Click **Show in Finder** to open
   it, or **Change folder…** to use another folder.

Each Sync now uploads new and changed files, downloads changes from Dropbox,
and copies deletes in both directions. If a file changed on both sides, you get
both versions: Dropbox keeps yours as a "conflicted copy". If a sync would
delete more than half of a project's files (at least 20), FolderSync asks
before it deletes anything.

Deleting a folder on this computer deletes its files in Dropbox but keeps the
folder there, empty, so nothing added to it meanwhile is lost. FolderSync
doesn't bring it back on this computer or list it under **Dropbox files**.

**Dropbox files** shows what's in the project in Dropbox and whether each file
matches your Mac, for example "Changed in Dropbox" before you sync. Click a
folder to open it. Right-click a file to open it, show it in Finder, or delete
it from Dropbox; the next Sync now deletes it from your Mac too.

#### Undo changes

Click **Undo** next to **Sync now**. FolderSync syncs first, then lists the
changes it made to the project in Dropbox, newest first: what changed and
when. Choose the oldest change you want to undo, then click **Undo**. Dropbox
undoes that change and every change after it, and FolderSync syncs the result
to your Mac. Changes made outside FolderSync are kept.

#### Try a second computer

You can run a second FolderSync on the same Mac, as if on another computer,
with its own sign-in and project folders in `~/FolderSync Computer 2`. Start
FolderSync first and leave it running; the second one uses the same token
server. In the `FolderSync` folder from the zip (after `npm run package`, unzip
`out/FolderSync-mac-arm64.zip` to get it):

```sh
open -n --env FOLDERSYNC_HOME="$HOME/FolderSync Computer 2/.foldersync" \
  --env FOLDERSYNC_PROJECTS="$HOME/FolderSync Computer 2" \
  --env FOLDERSYNC_LABEL="Computer 2" FolderSync.app
```

If you set `FOLDERSYNC_PORT`, add `--env FOLDERSYNC_PORT=<port>`. "Computer 2"
shows under the app name.

1. Sign in with the same name. The projects show up.
2. Open a project. **Dropbox files** shows its files as **Not on this computer
   yet**.
3. Click **Sync now**. FolderSync downloads them to
   `~/FolderSync Computer 2/<project>`.

Changes either one makes reach the other on its next Sync now. To start over,
quit the second FolderSync and delete `~/FolderSync Computer 2`.

#### Remove or delete a project

Right-click a project in the sidebar, or click its **⋯**:

- **Remove from This Mac** stops syncing the project on this Mac and forgets
  its local folder. Its files stay in Dropbox and on your Mac.
- **Delete from Dropbox…** deletes the project folder and everything in it
  from Dropbox, after you type the project name. Files on your Mac stay where
  they are. The delete uses the project's agent token, so **Undo** can bring
  the folder back.

#### Sign out and delete your account

In the account card at the top left:

- **Sign out** keeps your name, so you can sign in again to the same managed
  user.
- **Delete account…** permanently deletes the managed user and all its files
  from Dropbox. Type the name to confirm. **This can't be undone.** Files on
  your Mac stay where they are.

### Troubleshooting

| What you see | What to do |
|---|---|
| "The token server isn't running" | Quit FolderSync and start it with `./start.sh` or `npm start` |
| "Dropbox didn't accept the app key and secret" in Terminal | Check the app key and secret, then start FolderSync again |
| "address already in use" in Terminal | Another program uses port 8787. Start FolderSync on another port; see [Use another port](#use-another-port) |
| "no_permission" | Your Dropbox app isn't set up for managed users yet |
| Items under **Issues** | Problems with single files. They're tried again on the next sync |
| macOS says FolderSync or `tokenserver` can't be opened, or "Apple could not verify" it | Click **Done**, then start FolderSync with `./start.sh`, not by double-clicking the app. `start.sh` removes the flag macOS puts on downloaded files. If you still see it, run `xattr -dr com.apple.quarantine FolderSync.app tokenserver start.sh` in the `FolderSync` folder |

### Uninstall

Quit FolderSync. To delete the managed users from Dropbox, use **Delete
account…** for each one first. Then delete the `FolderSync` folder,
`FolderSync.app`, and `~/.foldersync/`. Your project folders stay where they
are.

## Part 2: Build it into your app

For the flow these pieces fit into, see [How it fits together](#how-it-fits-together).

### Using this code in your app

These are the parts to copy:

| You want to | Look at |
|---|---|
| Create and delete managed users, and mint their tokens, on your backend | `tokenserver/tokenmint/minter.go`: `CreateUser` (`users/create`), `Mint` (`users/access_token/mint`), `DeleteUser` (`users/delete`) |
| Give your app its user's token without the app secret | `tokenmint/handler.go`: `POST /login`, `POST /token`, `POST /delete-account` |
| Record which agent belongs to each project, so every computer uses the same one | `tokenmint/handler.go`: `POST /project-agent`; `src/engine/agents.ts`: `projectAgent`, `AgentDirectory` |
| Keep a short-lived, non-refreshable token fresh | `src/engine/tokenManager.ts`: `TokenManager` works with any token source |
| Get the user's token in the app | `src/main/account.ts` |
| Create an agent with a one-folder workspace and mint its token | `src/engine/agents.ts`: `projectAgent`, `AgentTokenProvider` |
| Read as the user and write as the agent | `src/main/projectClients.ts` |
| List an agent's changes and undo them | `src/engine/agents.ts`: `listChanges`, `startUndo`, `undoStatus`; `src/main/projects.ts`: `undo` |
| Call API v2 files routes: list, download, upload, delete | `src/engine/dropboxApi.ts` |
| Two-way sync of a folder | `src/engine/syncPass.ts` |

### Tokens and agents

The token server mints the managed user's token. The app uses it to create each
project's agent, which the token server then records, and to mint the agent's
tokens. Both kinds last about 4 hours and can't be refreshed, so the app mints
new ones 10 minutes before they expire (halfway through, for a token that lives
less than 20 minutes), after the computer wakes, and on a 401. A failed mint is
retried after 30 seconds, then less often, up to every 5 minutes.

The sync pass uploads, deletes, and creates folders with the agent's token, so
those writes are the agent's. It lists and downloads with the user's token.

### Where files live

| Path | What |
|---|---|
| `~/.foldersync/credentials.json` | The signed-in user's connection key and current access token (mode 0600). Deleted when you sign out |
| `~/.foldersync/settings.json` | Project folders, the last name, and the token server URL |
| `~/.foldersync/tokenserver/users.json` | The token server's users: `name`, `user_public_id`, `connection_key`, `created_at`, and each project's agent in `agents` (mode 0600). Treat it like a password |
| `~/.foldersync/tokenserver/app_key` | The last app key, to fill in the prompt |
| `<project folder>/.foldersync/` | Sync state for that project. Never uploaded |

The app secret is only in the token server's memory while it runs. It isn't
saved to any file.

Delete `~/.foldersync/` to start over. Users still exist in Dropbox until you
delete them with **Delete account…** or `remove-user -delete-account`.

## Part 3: Reference

### How it fits together

#### Apps, managed users, and agents

```text
Dropbox API app ── app key and secret, held only by the token server
│                  scopes: files.*, agent_filesystem.agents.manage, .agents.restore
│
├── Managed user "alice" ── its own Dropbox and Basic quota
│   │   managed-user token: minted by the token server
│   │
│   ├── /storyboard  ◄── Agent A ── workspace: /storyboard read_write
│   │   (project)          agent token: minted by the app with alice's token
│   │
│   └── /trailer     ◄── Agent B ── workspace: /trailer read_write
│       (project)          agent token
│
└── Managed user "bob" ── a separate account with separate files
    └── /storyboard  ◄── Agent C ── same project name, different user, different agent
```

| Dropbox | In FolderSync | Created | Token |
|---|---|---|---|
| API app | The app key and secret you give `start.sh` or `npm start` | Once, in the App Console | None; the token server uses the secret to mint user tokens |
| Managed user | A sign-in name | On the first **Sign in** with a new name (`users/create`) | Managed-user token from the token server, one per computer |
| Project | A top-level folder in the user's Dropbox | **Create project**, with the user's token | None |
| Agent | The project's change history and **Undo** | On the project's first **Sync now**, **Undo**, or **Delete from Dropbox** (`agents/create`) | Agent token, minted by the app with the user's token (`agents/access_token/mint`) |

- Each project has one agent. The token server records which agent belongs to
  each project (`POST /project-agent`), so a restart, a second computer, or a
  project re-created with the same name reuses it. Only the tokens are new. An
  agent's workspace doesn't identify it: another integration can create an agent
  with the same rule.
- The managed-user token is saved with the connection key in
  `credentials.json` and reused after a restart while it's valid. Agent tokens
  stay in memory, so each launch and each computer mints its own.
- **Remove from This Mac** and **Delete from Dropbox** keep the agent, so
  **Undo** can bring a deleted project back.

#### How it works

```text
┌──────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────────────┐
│ FolderSync app           │        │ Token server             │        │ Dropbox API v2               │
│ (no app secret)          │        │ Stands in for your       │        │                              │
│                          │  (1)   │ backend. Holds the       │  (2)   │                              │
│ account.ts               │───────►│ app key and secret       │───────►│ users/create                 │
│   managed-user token     │◄───────│                          │◄───────│ users/access_token/mint      │
│                          │  (3)   └──────────────────────────┘        │                              │
│                          │                                            │                              │
│ projectClients.ts        │  (4) user token                            │ agents/create,               │
│   one agent per project  │───────────────────────────────────────────►│ agents/access_token/mint     │
│                          │◄────────────────────────────── agent token │                              │
│ syncPass.ts              │  (5) reads, user token                     │ files/list_folder, download  │
│                          │───────────────────────────────────────────►│                              │
│                          │  (6) writes, agent token                   │ files/upload, delete_v2,     │
│                          │───────────────────────────────────────────►│ create_folder_v2             │
│ projects.ts (Undo)       │  (7) user token                            │ agents/mutations/list,       │
│                          │───────────────────────────────────────────►│ agents/restore_writes        │
└──────────────────────────┘                                            └──────────────────────────────┘
```

1. At sign-in, the app calls the token server's `POST /login` and gets a
   connection key. It then calls `POST /token` with that key for each token.
2. The token server creates the managed user the first time a name signs in,
   and mints the user's tokens with the app key and secret.
3. The app gets the managed-user token. It lasts about 4 hours, and
   `TokenManager` renews it before it expires.
4. For each project, the app asks the token server for the project's agent
   (`POST /project-agent`). If there's none yet, it creates one with read-write
   access to `/<project>` and records it. It mints the agent's token with the
   managed-user token. Agent tokens also last about 4 hours and are minted again.
5. The sync pass reads with the managed-user token.
6. It writes with the agent token, so Dropbox records each write as the agent's.
7. Undo lists the agent's changes and restores them with the managed-user token.

### The token server

The token server, in `tokenserver/`, holds
the app key and secret. It listens only on `127.0.0.1`, refuses requests from
web pages, and keeps the app secret in memory only. Its endpoints:

| Endpoint | What it does |
|---|---|
| `POST /login` | Creates the managed user the first time a name signs in, and returns a connection key |
| `POST /token` | Mints the access token of the connection key's user |
| `POST /delete-account` | Deletes the connection key's managed user and all its files |
| `POST /project-agent` | Returns the agent recorded for one of the user's projects, and records one if the project has none |

#### Manage users from Terminal

Users can sign in from the app, so these are optional. Run them in the folder
with `tokenserver`: the `FolderSync` folder from the zip, or `out/`.

```sh
./tokenserver list-users                  # names and user public IDs, never keys
./tokenserver remove-user -name demo      # the managed user stays in Dropbox
```

`remove-user` takes the user out of `users.json`, so its connection key stops
working and nothing can sign in to that managed user again; signing in with the
same name creates a new one. To also delete the managed user and all its files
from Dropbox, which can't be undone, add `-delete-account`. It reads the app key
and secret from the environment and asks you to type the user's name to
confirm:

```sh
export DBX_APP_KEY=<your_app_key>
read -rs DBX_APP_SECRET && export DBX_APP_SECRET
./tokenserver remove-user -name demo -delete-account
```

### Build the zip

With `out/tokenserver` built (`npm run build:tokenserver`):

```sh
npm run package
```

This writes `out/FolderSync-mac-arm64.zip` with `FolderSync.app`,
`tokenserver`, `start.sh`, and this README. The app isn't signed, so on another
Mac the files need the quarantine flag removed, which `start.sh` does.

### Develop

```sh
npm run typecheck
npm test
cd tokenserver && go test ./...
```

The tests run the sync pass against an in-memory Dropbox (`test/fakeDropbox.ts`)
and a temporary folder, and the agent, undo, and token code against a fake
API (`test/fakeRpc.ts`).

| Variable | Use |
|---|---|
| `FOLDERSYNC_PORT` | The token server's port (default 8787). `start.sh` and `npm start` start the token server on it, and the app connects to it |
| `FOLDERSYNC_HOME` | Use another folder instead of `~/.foldersync`, for example in tests. It also moves Electron's data folder, so each one has its own single-instance lock |
| `FOLDERSYNC_PROJECTS` | Where new project folders go (default `~/FolderSync`) |
| `FOLDERSYNC_LABEL` | Shown under the app name, to tell copies apart. Set all three, with `open -n --env`, to run a second copy on the same Mac; see [Try a second computer](#try-a-second-computer) |
| `FOLDERSYNC_TOKENSERVER` | Path of the `tokenserver` binary `npm start` runs (default `out/tokenserver`) |

## License

Unless otherwise noted:

    Copyright (c) 2026 Dropbox, Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
