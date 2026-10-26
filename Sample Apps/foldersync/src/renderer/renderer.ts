// The FolderSync window. The page is split into views; this file starts them
// and connects them to the main process's events.
import {AccountView} from './accountView.js';
import {api, applyCss, fillIcons} from './dom.js';
import {ProjectsView} from './projectsView.js';

applyCss();
fillIcons();
const projects = new ProjectsView();
const account = new AccountView(
  () => void projects.load(),
  () => projects.reset()
);

async function start(): Promise<void> {
  api.onTokenState((state) => account.showTokenState(state));
  api.onSyncStatus((project, status) => projects.onSyncStatus(project, status));
  api.onActivity((project, activity) => projects.onActivity(project, activity));
  account.showTokenState(await api.getTokenState());
  const info = await api.getSetup();
  if (info.label) {
    account.showLabel(info.label);
  }
  if (info.signedIn) {
    account.showApp(info);
  } else {
    account.showSignIn(info);
  }
}

start().catch((err: unknown) => account.showStartupError(err));
