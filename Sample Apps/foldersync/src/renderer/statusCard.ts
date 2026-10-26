// The open project's status card, Issues panel, and Recent activity panel.
import type {Activity, Issue, SyncStatus, SyncSummary} from '../shared/types';
import {el, icon, make, relativeTime} from './dom.js';
import styles from './styles.module.css';

type CardState = 'never' | 'ok' | 'syncing' | 'error' | 'attention';

const ACTIVITY_LABELS: Record<Activity['kind'], [string, string]> = {
  uploaded: ['upload', 'Uploaded'],
  downloaded: ['download', 'Downloaded'],
  'deleted-remote': ['trash', 'Deleted from Dropbox'],
  'deleted-local': ['trash', 'Deleted from this computer'],
  conflict: ['copy', 'Saved as a conflicted copy'],
};

const MAX_ACTIVITY = 50;

function describe(summary: SyncSummary): string {
  const parts = [`Last synced ${relativeTime(summary.finishedAt)}`];
  const counts: [number, string][] = [
    [summary.uploaded, 'uploaded'],
    [summary.downloaded, 'downloaded'],
    [summary.deletedRemote + summary.deletedLocal, 'deleted'],
    [summary.conflicts, summary.conflicts === 1 ? 'conflict' : 'conflicts'],
  ];
  for (const [n, label] of counts) {
    if (n > 0) {
      parts.push(`${n} ${label}`);
    }
  }
  return parts.join(' · ');
}

export class StatusCard {
  private readonly card = el('status-card', HTMLDivElement);
  private readonly cardIcon = el('status-icon', HTMLDivElement);
  private readonly title = el('status-title', HTMLDivElement);
  private readonly detail = el('status-detail', HTMLDivElement);
  private readonly activityList = el('activity', HTMLUListElement);
  private readonly issuesList = el('issues', HTMLUListElement);
  private readonly issueCount = el('issue-count', HTMLSpanElement);
  private activity: Activity[] = [];

  set(state: CardState, title: string, detail: string): void {
    this.card.dataset.state = state;
    this.title.textContent = title;
    this.detail.textContent = detail;
    const name =
      state === 'ok'
        ? 'check'
        : state === 'syncing'
          ? 'sync'
          : state === 'never'
            ? 'folder'
            : 'alert';
    this.cardIcon.replaceChildren(icon(name));
  }

  // For a project that hasn't synced since the app started.
  showNotSynced(): void {
    this.set('never', 'Not synced yet', 'Press Sync now to sync this project with this computer.');
    this.showIssues([]);
  }

  showSummary(summary: SyncSummary): void {
    if (summary.issues.length > 0) {
      this.set('attention', 'Synced with issues', describe(summary));
    } else {
      this.set('ok', 'Up to date', describe(summary));
    }
    this.showIssues(summary.issues);
  }

  showStatus(status: SyncStatus): void {
    switch (status.kind) {
      case 'syncing':
        this.set('syncing', 'Syncing…', status.step);
        this.showIssues([]);
        break;
      case 'error':
        this.set('error', 'Couldn’t sync', status.message);
        this.showIssues([]);
        break;
      case 'idle':
        if (status.last) {
          this.showSummary(status.last);
        } else if (status.message) {
          this.set('ok', 'Done', status.message);
        }
        break;
    }
  }

  setActivity(activity: Activity[]): void {
    this.activity = activity;
    this.renderActivity();
  }

  addActivity(activity: Activity): void {
    this.activity = [activity, ...this.activity].slice(0, MAX_ACTIVITY);
    this.renderActivity();
  }

  // Redraws the activity list, so relative times stay current.
  renderActivity(): void {
    if (this.activity.length === 0) {
      this.activityList.replaceChildren(
        make('li', styles.placeholder, 'Nothing yet. Press Sync now.')
      );
      return;
    }
    this.activityList.replaceChildren(
      ...this.activity.map((a) => {
        const [iconName, label] = ACTIVITY_LABELS[a.kind];
        const li = make('li');
        li.dataset.kind = a.kind;
        const main = make('div', styles.itemMain);
        main.append(
          make('div', styles.itemTitle, a.path.slice(a.path.lastIndexOf('/') + 1)),
          make('div', styles.itemSub, label)
        );
        li.append(icon(iconName), main, make('div', styles.itemTime, relativeTime(a.at)));
        li.title = a.path;
        return li;
      })
    );
  }

  private showIssues(issues: Issue[]): void {
    this.issueCount.hidden = issues.length === 0;
    this.issueCount.textContent = String(issues.length);
    if (issues.length === 0) {
      this.issuesList.replaceChildren(make('li', styles.placeholder, 'No issues'));
      return;
    }
    this.issuesList.replaceChildren(
      ...issues.map((issue) => {
        const li = make('li');
        li.dataset.kind = 'issue';
        const main = make('div', styles.itemMain);
        main.append(
          make('div', styles.itemTitle, issue.path.slice(issue.path.lastIndexOf('/') + 1)),
          make('div', styles.itemSub, issue.message)
        );
        li.append(icon('alert'), main);
        li.title = `${issue.path}\n${issue.message}`;
        return li;
      })
    );
  }
}
