// A fake for Dropbox RPC routes: answers each route with the next queued
// response, or with a function of the argument, and records the calls.
import type {AgentDirectory, Rpc} from '../src/engine/agents';
import type {RpcOptions} from '../src/engine/dropboxApi';

export interface Call {
  route: string;
  arg: unknown;
  opts?: RpcOptions;
}

type Response = unknown[] | ((arg: unknown) => unknown);

export class FakeRpc implements Rpc {
  readonly calls: Call[] = [];
  constructor(private readonly responses: Record<string, Response>) {}

  async rpc(route: string, arg: unknown, opts?: RpcOptions): Promise<unknown> {
    this.calls.push({route, arg, opts});
    const response = this.responses[route];
    const next = typeof response === 'function' ? response(arg) : response?.shift();
    if (next === undefined) {
      throw new Error(`unexpected call to ${route}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  routes(): string[] {
    return this.calls.map((c) => c.route.replace('agent_filesystem/', ''));
  }
}

// An agents/list entry whose workspace has the given [path, role] rules.
export function agent(id: string, rules: [string, string][]): unknown {
  return {
    agent_id: id,
    workspace: {entries: rules.map(([path, role]) => ({path, role: {'.tag': role}}))},
  };
}

// An AgentDirectory in memory, starting with the given folder-to-agent records.
// claims lists every claim, in order.
export function memoryDirectory(records: Record<string, string> = {}): AgentDirectory & {
  claims: [string, string][];
} {
  const recorded = new Map(Object.entries(records));
  const claims: [string, string][] = [];
  return {
    claims,
    recorded: async (folder) => recorded.get(folder.toLowerCase()),
    claim: async (folder, agentId) => {
      claims.push([folder, agentId]);
      const key = folder.toLowerCase();
      if (!recorded.has(key)) {
        recorded.set(key, agentId);
      }
      return recorded.get(key) ?? agentId;
    },
  };
}
