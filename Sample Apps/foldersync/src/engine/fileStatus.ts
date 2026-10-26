// How a file in Dropbox compares with this computer, for the Dropbox files panel.
import type {FileStatus} from '../shared/types';
import {sameStat} from './localScan';
import type {LocalStat, Row} from './stateStore';

// remoteRev is the file's current rev in Dropbox, row is the state saved at the
// last sync, and local is the local file's stat, if it exists.
export function fileStatus(
  remoteRev: string,
  row: Row | undefined,
  local: LocalStat | undefined
): FileStatus {
  if (!row) {
    // No sync record: never synced here, or removed from this computer.
    return local ? 'not-synced' : 'not-on-computer';
  }
  const remoteChanged = remoteRev !== row.rev;
  const localChanged = !local || row.uploadFailed || !sameStat(local, row.stat);
  if (remoteChanged && localChanged) {
    return 'both-changed';
  }
  if (remoteChanged) {
    return 'dropbox-newer';
  }
  if (localChanged) {
    return local ? 'local-newer' : 'deleted-here';
  }
  return 'synced';
}
