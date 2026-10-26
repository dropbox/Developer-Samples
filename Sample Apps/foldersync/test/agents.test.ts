import {describe, expect, it} from 'vitest';

import {
  AgentTokenProvider,
  MAX_CHANGES,
  groupChanges,
  listChanges,
  parseMutation,
  projectAgent,
  startUndo,
  undoStatus,
} from '../src/engine/agents';
import {FakeRpc, memoryDirectory} from './fakeRpc';

function mutation(op: string, timestampUs: number, metadata: unknown): unknown {
  return {op_type: {'.tag': op}, timestamp_us: timestampUs, object_metadata: metadata};
}

const file = (containing: string, name: string): unknown => ({
  '.tag': 'single_object_metadata',
  containing_path: containing,
  name,
});

describe('projectAgent', () => {
  it('uses the agent the directory recorded, without listing or creating agents', async () => {
    const api = new FakeRpc({});
    const directory = memoryDirectory({'/storyboard': 'recorded'});

    expect(await projectAgent(api, '/Storyboard', directory)).toBe('recorded');
    expect(api.calls).toEqual([]);
    expect(directory.claims).toEqual([]);
  });

  it('creates an agent without retrying and records it when none is recorded', async () => {
    const api = new FakeRpc({
      'agent_filesystem/agents/create': [{agents: [{agent_id: 'new'}]}],
    });
    const directory = memoryDirectory();

    expect(await projectAgent(api, '/storyboard', directory)).toBe('new');
    expect(api.calls).toEqual([
      {
        route: 'agent_filesystem/agents/create',
        arg: {entries: [{workspace: [{path: '/storyboard', role: {'.tag': 'read_write'}}]}]},
        opts: {retry: false},
      },
    ]);
    expect(directory.claims).toEqual([['/storyboard', 'new']]);
  });

  it('uses the agent another computer recorded first', async () => {
    const api = new FakeRpc({
      'agent_filesystem/agents/create': [{agents: [{agent_id: 'mine'}]}],
    });
    const directory = memoryDirectory();
    // The other computer claims the project while this one creates its agent.
    const claim = directory.claim.bind(directory);
    directory.claim = async (folder, agentId) => {
      await claim(folder, 'theirs');
      return claim(folder, agentId);
    };
    directory.recorded = async () => undefined;

    expect(await projectAgent(api, '/storyboard', directory)).toBe('theirs');
  });
});

describe('AgentTokenProvider', () => {
  it('mints an agent token and computes its expiry', async () => {
    const api = new FakeRpc({
      'agent_filesystem/agents/access_token/mint': [{access_token: 'agent-tok', expires_in: 14400}],
    });

    const token = await new AgentTokenProvider(api, 'a1', () => 1_000_000).fetchToken();

    expect(token).toEqual({accessToken: 'agent-tok', expiresAt: new Date(1_000_000 + 14_400_000)});
    expect(api.calls[0]?.arg).toEqual({agent: {'.tag': 'agent_id', agent_id: 'a1'}});
    expect(api.calls[0]?.opts).toEqual({retry: false});
  });

  it('throws when Dropbox returns no token', async () => {
    const api = new FakeRpc({'agent_filesystem/agents/access_token/mint': [{}]});
    await expect(new AgentTokenProvider(api, 'a1').fetchToken()).rejects.toThrow(/agent token/);
  });
});

describe('parseMutation', () => {
  const at = 1_792_614_782_000_000;

  it('shows paths relative to the project', () => {
    expect(
      parseMutation(mutation('add', at, file('/Storyboard/shots', 'a.mov')), '/storyboard')
    ).toEqual({
      op: 'add',
      path: 'shots/a.mov',
      timestampUs: at,
    });
    expect(
      parseMutation(
        mutation('edit', at, {
          '.tag': 'edit_metadata',
          containing_path: '/storyboard',
          name: 'a.txt',
        }),
        '/storyboard'
      ).path
    ).toBe('a.txt');
  });

  it('shows both paths for moves and renames', () => {
    const move = parseMutation(
      mutation('move', at, {
        '.tag': 'move_metadata',
        from_containing_path: '/storyboard/old',
        to_containing_path: '/storyboard/new',
        name: 'a.txt',
      }),
      '/storyboard'
    );
    expect([move.path, move.toPath]).toEqual(['old/a.txt', 'new/a.txt']);

    const rename = parseMutation(
      mutation('rename', at, {
        '.tag': 'rename_metadata',
        containing_path: '/storyboard',
        from_name: 'a.txt',
        to_name: 'b.txt',
      }),
      '/storyboard'
    );
    expect([rename.path, rename.toPath]).toEqual(['a.txt', 'b.txt']);
  });

  it('reads the time an undo went back to', () => {
    const change = parseMutation(
      mutation('rollback', at, {
        '.tag': 'rollback_metadata',
        containing_path: '',
        name: '',
        to_timestamp: 42,
      }),
      '/storyboard'
    );
    expect(change).toEqual({op: 'rollback', path: '', timestampUs: at, undidAfterUs: 42});
  });

  it('strips an NFD project folder by name, not by length', () => {
    const nfd = '/Cafe\u0301';
    expect(parseMutation(mutation('add', at, file(`${nfd}/shots`, 'a.txt')), '/Café').path).toBe(
      'shots/a.txt'
    );
  });

  it.each([
    ['a fractional timestamp', mutation('add', 1.5, file('/p', 'a.txt'))],
    ['a negative timestamp', mutation('add', -1, file('/p', 'a.txt'))],
    ['an unsafe timestamp', mutation('add', Number.MAX_VALUE, file('/p', 'a.txt'))],
    ['no name', mutation('add', at, {'.tag': 'single_object_metadata', containing_path: '/p'})],
    [
      'no destination for a move',
      mutation('move', at, {'.tag': 'move_metadata', from_containing_path: '/p', name: 'a.txt'}),
    ],
  ])('rejects a mutation with %s', (_label, raw) => {
    expect(() => parseMutation(raw, '/p')).toThrow();
  });

  it('throws without a timestamp', () => {
    expect(() => parseMutation({op_type: {'.tag': 'add'}}, '/p')).toThrow(/timestamp/);
  });
});

describe('groupChanges', () => {
  it('groups changes from the same second', () => {
    const change = (path: string, timestampUs: number) => ({op: 'add', path, timestampUs});
    const groups = groupChanges([change('c', 3), change('b', 2), change('a', 2), change('z', 1)]);
    expect(groups.map((g) => [g.timestampUs, g.changes.map((c) => c.path)])).toEqual([
      [3, ['c']],
      [2, ['b', 'a']],
      [1, ['z']],
    ]);
  });
});

describe('listChanges', () => {
  it('follows next_cursor', async () => {
    const api = new FakeRpc({
      'agent_filesystem/agents/mutations/list': [
        {mutations: [mutation('add', 2, file('/p', 'b'))], next_cursor: 'm1'},
        {mutations: [mutation('add', 1, file('/p', 'a'))]},
      ],
    });

    const changes = await listChanges(api, 'a1', '/p');

    expect(changes.map((c) => c.path)).toEqual(['b', 'a']);
    expect(api.calls[1]?.arg).toEqual({
      agent: {'.tag': 'agent_id', agent_id: 'a1'},
      limit: 100,
      cursor: 'm1',
    });
  });

  // A page of changes at these timestamps, with more pages after it.
  function page(timestamps: number[]): unknown {
    return {
      mutations: timestamps.map((ts) => mutation('add', ts, file('/p', `f${ts}`))),
      next_cursor: 'more',
    };
  }

  // Timestamps for page p of 100 changes, newest first, one second apart.
  const seconds = (p: number): number[] =>
    Array.from({length: 100}, (_, i) => 10_000 - (p * 100 + i));

  it(`stops at ${MAX_CHANGES} changes`, async () => {
    const api = new FakeRpc({
      'agent_filesystem/agents/mutations/list': [0, 1, 2, 3].map((p) => page(seconds(p))),
    });

    expect(await listChanges(api, 'a1', '/p')).toHaveLength(MAX_CHANGES);
    // The fourth page shows whether the oldest second continues.
    expect(api.calls).toHaveLength(4);
  });

  it('drops the oldest second when the limit cuts it', async () => {
    const third = seconds(2);
    const lastKept = third[99] ?? 0;
    // The 300th and 301st changes happened in the same second.
    const fourth = [lastKept, ...seconds(3).slice(1)];
    const api = new FakeRpc({
      'agent_filesystem/agents/mutations/list': [
        page(seconds(0)),
        page(seconds(1)),
        page(third),
        page(fourth),
      ],
    });

    const changes = await listChanges(api, 'a1', '/p');

    expect(changes).toHaveLength(MAX_CHANGES - 1);
    expect(changes.some((c) => c.timestampUs === lastKept)).toBe(false);
  });
});

describe('undo', () => {
  it('starts an undo without retrying and returns its cursor', async () => {
    const api = new FakeRpc({'agent_filesystem/agents/restore_writes': [{cursor: 'r1'}]});

    expect(await startUndo(api, 'a1', 99)).toBe('r1');
    expect(api.calls[0]).toEqual({
      route: 'agent_filesystem/agents/restore_writes',
      arg: {agent: {'.tag': 'agent_id', agent_id: 'a1'}, restore_to_timestamp_us: 99},
      opts: {retry: false},
    });
  });

  it('maps the undo status tags', async () => {
    const tags = ['in_progress', 'complete', 'failed'].map((t) => ({
      status: {'.tag': `restore_agent_writes_status_${t}`},
    }));
    const api = new FakeRpc({'agent_filesystem/agents/restore_writes/status': tags});

    expect([
      await undoStatus(api, 'r1'),
      await undoStatus(api, 'r1'),
      await undoStatus(api, 'r1'),
    ]).toEqual(['running', 'complete', 'failed']);
  });

  it('throws on an unknown status', async () => {
    const api = new FakeRpc({
      'agent_filesystem/agents/restore_writes/status': [{status: {'.tag': 'in_progress'}}],
    });
    await expect(undoStatus(api, 'r1')).rejects.toThrow(/unknown undo status/);
  });
});
