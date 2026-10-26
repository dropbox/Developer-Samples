// Each project has an AgentFS agent with read-write access to only the project
// folder. Sync writes with the agent's token, so Dropbox records the project's
// changes, which can be listed and undone.
import type {Change, ChangeGroup} from '../shared/types';
import type {RpcOptions} from './dropboxApi';
import {pathKey} from './paths';
import type {MintedToken, TokenProvider} from './tokenManager';

// The user-token calls agents need; DropboxClient implements it.
export interface Rpc {
  rpc(route: string, arg: unknown, opts?: RpcOptions): Promise<unknown>;
}

export type UndoStatus = 'running' | 'complete' | 'failed';

const PAGE_LIMIT = 100;
// The most changes the Undo list shows.
export const MAX_CHANGES = 300;

function field(v: unknown, key: string): unknown {
  return typeof v === 'object' && v !== null ? Reflect.get(v, key) : undefined;
}

function stringField(v: unknown, key: string): string | undefined {
  const value = field(v, key);
  return typeof value === 'string' ? value : undefined;
}

function tagOf(v: unknown): string | undefined {
  return stringField(v, '.tag');
}

function arrayField(v: unknown, key: string, route: string): unknown[] {
  const value = field(v, key);
  if (!Array.isArray(value)) {
    throw new Error(`Dropbox ${route} response has no ${key}.`);
  }
  return value;
}

// The cursor for the next page, or undefined after the last page.
function nextCursor(v: unknown, route: string): string | undefined {
  const value = field(v, 'next_cursor');
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Dropbox ${route} response has an invalid next_cursor.`);
  }
  return value;
}

function selector(agentId: string): {'.tag': 'agent_id'; agent_id: string} {
  return {'.tag': 'agent_id', agent_id: agentId};
}

// Where your backend records each project's agent, so every computer uses the
// same agent and its history. An agent's workspace doesn't identify it: another
// integration can create an agent with the same rule.
export interface AgentDirectory {
  // The project's recorded agent, if it has one.
  recorded(folder: string): Promise<string | undefined>;
  // Records agentId for the project unless it already has an agent, and
  // returns the recorded one.
  claim(folder: string, agentId: string): Promise<string>;
}

// Returns the ID of the folder's agent: the one the directory recorded, or a
// new one, read-write on the folder, that it records now.
export async function projectAgent(
  api: Rpc,
  folder: string,
  directory: AgentDirectory
): Promise<string> {
  const recorded = await directory.recorded(folder);
  if (recorded) {
    return recorded;
  }
  const res = await api.rpc(
    'agent_filesystem/agents/create',
    {entries: [{workspace: [{path: folder, role: {'.tag': 'read_write'}}]}]},
    {retry: false}
  );
  const id = stringField(arrayField(res, 'agents', 'agents/create')[0], 'agent_id');
  if (!id) {
    throw new Error('Dropbox agents/create response has no agent ID.');
  }
  // If another computer recorded its agent first, use that one; this one stays unused.
  return directory.claim(folder, id);
}

// Mints the agent's tokens with the user's token. Agent tokens can't be
// refreshed, so TokenManager mints a new one before each expires.
export class AgentTokenProvider implements TokenProvider {
  constructor(
    private readonly api: Rpc,
    private readonly agentId: string,
    private readonly now: () => number = Date.now
  ) {}

  async fetchToken(): Promise<MintedToken> {
    const res = await this.api.rpc(
      'agent_filesystem/agents/access_token/mint',
      {agent: selector(this.agentId)},
      {retry: false}
    );
    const accessToken = stringField(res, 'access_token');
    const expiresIn = field(res, 'expires_in');
    if (
      !accessToken ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new Error('Dropbox didn’t return a usable agent token.');
    }
    return {accessToken, expiresAt: new Date(this.now() + expiresIn * 1000)};
  }
}

function joinPath(folder: string | undefined, name: string | undefined): string {
  return [folder ?? '', name ?? ''].filter(Boolean).join('/').replace(/^\/*/, '/');
}

// Strips the project folder from a path, so "/storyboard/a.txt" shows as "a.txt".
// Compares whole names, since a name's NFC and NFD forms differ in length.
function inProject(path: string, folder: string): string {
  const parts = path.split('/').filter(Boolean);
  const folderParts = folder.split('/').filter(Boolean);
  const inside =
    folderParts.length < parts.length &&
    folderParts.every((part, i) => pathKey(part) === pathKey(parts[i] ?? ''));
  return inside ? parts.slice(folderParts.length).join('/') : path;
}

// A metadata field that must be a string. Containing paths may be empty, names may not.
function mdString(md: unknown, key: string, allowEmpty = false): string {
  const value = stringField(md, key);
  if (value === undefined || (!allowEmpty && value === '')) {
    throw new Error(`Dropbox mutation metadata has no ${key}.`);
  }
  return value;
}

// Turns one agents/mutations/list entry into a Change.
export function parseMutation(raw: unknown, folder: string): Change {
  const timestampUs = field(raw, 'timestamp_us');
  if (typeof timestampUs !== 'number' || !Number.isSafeInteger(timestampUs) || timestampUs < 0) {
    throw new Error('Dropbox mutation has no valid timestamp.');
  }
  const op = tagOf(field(raw, 'op_type')) ?? 'unknown';
  const md = field(raw, 'object_metadata');
  const change: Change = {op, path: '', timestampUs};
  switch (tagOf(md)) {
    case 'move_metadata':
      change.path = joinPath(mdString(md, 'from_containing_path', true), mdString(md, 'name'));
      change.toPath = joinPath(mdString(md, 'to_containing_path', true), mdString(md, 'name'));
      break;
    case 'rename_metadata':
      change.path = joinPath(mdString(md, 'containing_path', true), mdString(md, 'from_name'));
      change.toPath = joinPath(mdString(md, 'containing_path', true), mdString(md, 'to_name'));
      break;
    case 'move_in_metadata':
      change.path = joinPath(mdString(md, 'to_containing_path', true), mdString(md, 'name'));
      break;
    case 'move_out_metadata':
      change.path = joinPath(mdString(md, 'from_containing_path', true), mdString(md, 'name'));
      break;
    case 'rollback_metadata': {
      const to = field(md, 'to_timestamp');
      if (to !== undefined) {
        if (typeof to !== 'number' || !Number.isSafeInteger(to) || to < 0) {
          throw new Error('Dropbox rollback metadata has an invalid to_timestamp.');
        }
        change.undidAfterUs = to;
      }
      break;
    }
    default:
      change.path = joinPath(mdString(md, 'containing_path', true), mdString(md, 'name'));
  }
  change.path = inProject(change.path, folder);
  if (change.toPath) {
    change.toPath = inProject(change.toPath, folder);
  }
  return change;
}

// Groups changes that share a timestamp. Dropbox records whole seconds, so
// changes in the same second can only be undone together.
export function groupChanges(changes: Change[]): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  for (const change of changes) {
    const last = groups.at(-1);
    if (last && last.timestampUs === change.timestampUs) {
      last.changes.push(change);
    } else {
      groups.push({timestampUs: change.timestampUs, changes: [change]});
    }
  }
  return groups;
}

// Lists the agent's changes, newest first, up to MAX_CHANGES.
export async function listChanges(api: Rpc, agentId: string, folder: string): Promise<Change[]> {
  const changes: Change[] = [];
  let cursor: string | undefined;
  do {
    const arg = cursor
      ? {agent: selector(agentId), limit: PAGE_LIMIT, cursor}
      : {agent: selector(agentId), limit: PAGE_LIMIT};
    const res = await api.rpc('agent_filesystem/agents/mutations/list', arg);
    for (const raw of arrayField(res, 'mutations', 'agents/mutations/list')) {
      changes.push(parseMutation(raw, folder));
    }
    cursor = nextCursor(res, 'agents/mutations/list');
    // One past the limit, to know whether the last kept second continues.
  } while (cursor && changes.length <= MAX_CHANGES);
  if (changes.length <= MAX_CHANGES) {
    return changes;
  }
  // Newest first: drop the oldest second if the limit cuts it, so every
  // listed group is complete.
  const cut = changes[MAX_CHANGES]?.timestampUs;
  return changes.slice(0, MAX_CHANGES).filter((c) => c.timestampUs !== cut);
}

// Starts undoing the agent's writes after restoreToUs and returns the status cursor.
export async function startUndo(api: Rpc, agentId: string, restoreToUs: number): Promise<string> {
  const res = await api.rpc(
    'agent_filesystem/agents/restore_writes',
    {agent: selector(agentId), restore_to_timestamp_us: restoreToUs},
    {retry: false}
  );
  const cursor = stringField(res, 'cursor');
  if (!cursor) {
    throw new Error('Dropbox restore_writes response has no cursor.');
  }
  return cursor;
}

export async function undoStatus(api: Rpc, cursor: string): Promise<UndoStatus> {
  const res = await api.rpc('agent_filesystem/agents/restore_writes/status', {cursor});
  const tag = tagOf(field(res, 'status'));
  switch (tag) {
    case 'restore_agent_writes_status_in_progress':
      return 'running';
    case 'restore_agent_writes_status_complete':
      return 'complete';
    case 'restore_agent_writes_status_failed':
      return 'failed';
    default:
      throw new Error(`Dropbox returned an unknown undo status: ${tag ?? 'none'}.`);
  }
}
