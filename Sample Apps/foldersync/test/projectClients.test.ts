import {describe, expect, it} from 'vitest';

import type {DropboxFiles, TokenSource} from '../src/engine/dropboxApi';
import {ProjectClients, type UserApi} from '../src/main/projectClients';
import {FakeRpc, memoryDirectory} from './fakeRpc';

// Records which client each call went to.
function recordingFiles(name: string, log: string[]): DropboxFiles {
  const record = async (method: string): Promise<never> => {
    log.push(`${name}.${method}`);
    throw new Error('not used');
  };
  return {
    listFolder: () => record('listFolder'),
    listFolderContinue: () => record('listFolderContinue'),
    downloadToFile: () => record('downloadToFile'),
    upload: () => record('upload'),
    deleteV2: () => record('deleteV2'),
    createFolder: () => record('createFolder'),
  };
}

function userApi(rpc: FakeRpc, log: string[]): UserApi {
  return {...recordingFiles('user', log), rpc: (route, arg, opts) => rpc.rpc(route, arg, opts)};
}

describe('ProjectClients', () => {
  it('reads with the user token and writes with the agent token', async () => {
    const rpc = new FakeRpc({});
    const log: string[] = [];
    const tokens: TokenSource[] = [];
    const clients = new ProjectClients(
      () => userApi(rpc, log),
      () => memoryDirectory({'/storyboard': 'a1'}),
      (t) => {
        tokens.push(t);
        return recordingFiles('agent', log);
      }
    );

    const files = await clients.syncFiles('storyboard');
    for (const call of [
      () => files.listFolder('/storyboard', true),
      () => files.listFolderContinue('c'),
      () => files.downloadToFile('/storyboard/a', '/tmp/a'),
      () =>
        files.upload({
          localPath: '',
          dropboxPath: '',
          mode: {kind: 'add'},
          clientModified: new Date(),
          contentHash: '',
          checkUnchanged: async () => {},
        }),
      () => files.deleteV2('/storyboard/a'),
      () => files.createFolder('/storyboard/b'),
    ]) {
      await call().catch(() => {});
    }

    expect(log).toEqual([
      'user.listFolder',
      'user.listFolderContinue',
      'user.downloadToFile',
      'agent.upload',
      'agent.deleteV2',
      'agent.createFolder',
    ]);
    expect(tokens).toHaveLength(1);
  });

  it('looks up a project agent once', async () => {
    const directory = memoryDirectory({'/storyboard': 'a1'});
    let lookups = 0;
    const recorded = directory.recorded;
    directory.recorded = (folder) => {
      lookups++;
      return recorded(folder);
    };
    const clients = new ProjectClients(
      () => userApi(new FakeRpc({}), []),
      () => directory
    );

    const first = await clients.agent('storyboard');
    const second = await clients.agent('storyboard');
    // Dropbox names ignore case, so this is the same project.
    const renamed = await clients.agent('Storyboard');

    expect(first.agentId).toBe('a1');
    expect(second).toBe(first);
    expect(renamed).toBe(first);
    expect(lookups).toBe(1);
  });

  it('tries again after a failed lookup', async () => {
    const directory = memoryDirectory({'/storyboard': 'a1'});
    const recorded = directory.recorded;
    let calls = 0;
    directory.recorded = async (folder) => {
      if (++calls === 1) {
        throw new Error('offline');
      }
      return recorded(folder);
    };
    const clients = new ProjectClients(
      () => userApi(new FakeRpc({}), []),
      () => directory
    );

    await expect(clients.agent('storyboard')).rejects.toThrow('offline');
    expect((await clients.agent('storyboard')).agentId).toBe('a1');
  });

  it('looks up the agent again after the project is forgotten', async () => {
    const directory = memoryDirectory({'/storyboard': 'a1'});
    let lookups = 0;
    const recorded = directory.recorded;
    directory.recorded = (folder) => {
      lookups++;
      return recorded(folder);
    };
    const clients = new ProjectClients(
      () => userApi(new FakeRpc({}), []),
      () => directory
    );

    await clients.agent('storyboard');
    clients.forget('storyboard');
    await clients.agent('storyboard');

    expect(lookups).toBe(2);
  });
});
