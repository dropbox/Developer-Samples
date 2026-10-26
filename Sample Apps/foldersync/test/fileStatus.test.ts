import {describe, expect, it} from 'vitest';

import {fileStatus} from '../src/engine/fileStatus';
import type {LocalStat, Row} from '../src/engine/stateStore';

const stat: LocalStat = {inode: '7', size: 3, mtimeNs: '100', ctimeNs: '100'};

function row(overrides: Partial<Row> = {}): Row {
  return {
    pathLower: '/p/a.txt',
    pathDisplay: '/p/a.txt',
    kind: 'file',
    id: 'id:a',
    rev: 'r1',
    contentHash: 'h',
    stat,
    uploadFailed: false,
    ...overrides,
  };
}

describe('fileStatus', () => {
  it('is synced when neither side changed since the last sync', () => {
    expect(fileStatus('r1', row(), {...stat})).toBe('synced');
  });

  it('is dropbox-newer when only the rev changed', () => {
    expect(fileStatus('r2', row(), stat)).toBe('dropbox-newer');
  });

  it('is local-newer when only the local file changed', () => {
    expect(fileStatus('r1', row(), {...stat, mtimeNs: '200'})).toBe('local-newer');
  });

  it('is local-newer when the last upload failed', () => {
    expect(fileStatus('r1', row({uploadFailed: true}), stat)).toBe('local-newer');
  });

  it('is deleted-here when the local file is gone', () => {
    expect(fileStatus('r1', row(), undefined)).toBe('deleted-here');
  });

  it('is both-changed when the rev and the local file changed', () => {
    expect(fileStatus('r2', row(), {...stat, size: 4})).toBe('both-changed');
    expect(fileStatus('r2', row(), undefined)).toBe('both-changed');
  });

  it('is not-on-computer when it was never synced and isn’t here', () => {
    expect(fileStatus('r1', undefined, undefined)).toBe('not-on-computer');
  });

  it('is not-synced when a local file exists but there is no sync record', () => {
    expect(fileStatus('r1', undefined, stat)).toBe('not-synced');
  });
});
