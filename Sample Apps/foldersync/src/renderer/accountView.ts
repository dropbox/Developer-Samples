// The sign-in screen, the account card, and Delete account.
import type {SetupInfo, TokenState} from '../shared/types';
import {api, el, message} from './dom.js';

export class AccountView {
  private readonly onboarding = el('onboarding', HTMLDivElement);
  private readonly appView = el('app', HTMLDivElement);
  private readonly userName = el('user-name', HTMLInputElement);
  private readonly signInButton = el('sign-in-button', HTMLButtonElement);
  private readonly serverStatus = el('server-status', HTMLParagraphElement);
  private readonly serverUrl = el('server-url', HTMLInputElement);
  private readonly setupError = el('setup-error', HTMLParagraphElement);
  private readonly avatar = el('avatar', HTMLDivElement);
  private readonly accountName = el('account-name', HTMLDivElement);
  private readonly tokenBox = el('token-state', HTMLDivElement);
  private readonly tokenText = el('token-text', HTMLSpanElement);
  private readonly deleteDialog = el('delete-dialog', HTMLDialogElement);
  private readonly deleteName = el('delete-name', HTMLElement);
  private readonly deleteConfirm = el('delete-confirm', HTMLInputElement);
  private readonly deleteError = el('delete-error', HTMLParagraphElement);
  private readonly deleteSubmit = el('delete-submit', HTMLButtonElement);
  private tokenState: TokenState = {kind: 'missing'};
  // Counts token server checks, so an older check's answer can't replace a newer one.
  private serverChecks = 0;
  // True while the account is being deleted. It can't be canceled, so the dialog stays open.
  private deleting = false;

  // onSignedIn shows the app; onSignedOut clears what it showed.
  constructor(
    private readonly onSignedIn: () => void,
    private readonly onSignedOut: () => void
  ) {
    el('sign-in', HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      void this.signIn();
    });
    this.serverUrl.addEventListener('change', () => void this.checkServer());
    el('sign-out', HTMLButtonElement).addEventListener('click', () => {
      api
        .signOut()
        .then(() => api.getSetup())
        .then((info) => this.showSignIn(info))
        .catch((err: unknown) => {
          this.tokenText.textContent = message(err);
        });
    });
    el('delete-account', HTMLButtonElement).addEventListener('click', () =>
      this.openDeleteDialog()
    );
    this.deleteConfirm.addEventListener('input', () => {
      this.deleteSubmit.disabled =
        this.deleting || this.deleteConfirm.value.trim() !== this.accountName.textContent;
    });
    el('delete-cancel', HTMLButtonElement).addEventListener('click', () =>
      this.deleteDialog.close()
    );
    this.deleteDialog.addEventListener('cancel', (event) => {
      if (this.deleting) {
        event.preventDefault();
      }
    });
    this.deleteSubmit.addEventListener('click', () => void this.deleteAccount());
    // Keeps "Token renews in …" current.
    setInterval(() => this.showTokenState(this.tokenState), 30_000);
  }

  // Shows the label set with FOLDERSYNC_LABEL, to tell copies of the app apart.
  showLabel(label: string): void {
    el('brand-sub', HTMLDivElement).textContent = label;
    const pill = el('instance-label', HTMLParagraphElement);
    pill.textContent = label;
    pill.hidden = false;
  }

  showApp(info: SetupInfo): void {
    const name = info.userName ?? 'Managed user';
    this.accountName.textContent = name;
    this.avatar.textContent = name.slice(0, 1).toUpperCase();
    this.onboarding.hidden = true;
    this.appView.hidden = false;
    this.onSignedIn();
  }

  showSignIn(info: SetupInfo): void {
    this.onSignedOut();
    this.appView.hidden = true;
    this.onboarding.hidden = false;
    this.serverUrl.value = info.tokenServerUrl;
    this.userName.value = info.lastUserName ?? '';
    this.userName.focus();
    void this.checkServer();
  }

  showTokenState(state: TokenState): void {
    this.tokenState = state;
    this.tokenBox.dataset.state = state.kind;
    this.tokenBox.title = '';
    switch (state.kind) {
      case 'missing':
        this.tokenText.textContent = 'Not connected';
        break;
      case 'renewing':
        this.tokenText.textContent = 'Renewing token…';
        break;
      case 'valid': {
        const minutes = Math.max(0, Math.round((Date.parse(state.expiresAt) - Date.now()) / 60000));
        const left = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        this.tokenText.textContent = `Token renews in ${left}`;
        this.tokenBox.title = `Connected. The token renews automatically in ${left}.`;
        break;
      }
      case 'error':
        this.tokenText.textContent = 'Can’t get a token';
        this.tokenBox.title = state.message;
        break;
    }
  }

  showStartupError(err: unknown): void {
    this.onboarding.hidden = false;
    this.setupError.textContent = message(err);
  }

  private async signIn(): Promise<void> {
    this.setupError.textContent = '';
    this.signInButton.disabled = true;
    try {
      const {setup} = await api.signIn(this.userName.value, this.serverUrl.value);
      this.showApp(setup);
    } catch (err) {
      this.setupError.textContent = message(err);
      await this.checkServer();
    } finally {
      this.signInButton.disabled = false;
    }
  }

  private async checkServer(): Promise<void> {
    const check = ++this.serverChecks;
    const url = this.serverUrl.value;
    const current = (): boolean => check === this.serverChecks && url === this.serverUrl.value;
    try {
      const status = await api.tokenServerStatus(url);
      if (!current()) {
        return;
      }
      this.serverStatus.textContent = status.running
        ? `Token server is running (app ${status.appKey.slice(0, 4)}…).`
        : 'The token server isn’t running. Start FolderSync with “npm start” or start.sh.';
    } catch (err) {
      if (current()) {
        this.serverStatus.textContent = message(err);
      }
    }
  }

  private openDeleteDialog(): void {
    this.deleteName.textContent = this.accountName.textContent;
    this.deleteConfirm.value = '';
    this.deleteError.textContent = '';
    this.deleteSubmit.disabled = true;
    this.deleteDialog.showModal();
    this.deleteConfirm.focus();
  }

  private async deleteAccount(): Promise<void> {
    const cancel = el('delete-cancel', HTMLButtonElement);
    this.deleteSubmit.disabled = true;
    this.deleteError.textContent = '';
    this.deleting = true;
    cancel.disabled = true;
    try {
      await api.deleteAccount();
      this.deleteDialog.close();
      this.showSignIn(await api.getSetup());
    } catch (err) {
      // The account may be gone even if cleanup on this computer failed. If the
      // check fails too, the dialog shows the first error.
      const setup = await api.getSetup().catch(() => undefined);
      if (!setup || setup.signedIn) {
        if (!this.deleteDialog.open) {
          // Closed anyway, so show the failure on the account card.
          this.tokenText.textContent = message(err);
          return;
        }
        this.deleteError.textContent = message(err);
        // The name may have been changed while the delete ran.
        this.deleteSubmit.disabled =
          this.deleteConfirm.value.trim() !== this.accountName.textContent;
        return;
      }
      this.deleteDialog.close();
      this.showSignIn(setup);
      this.setupError.textContent = message(err);
    } finally {
      this.deleting = false;
      cancel.disabled = false;
    }
  }
}
