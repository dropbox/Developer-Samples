// The Dropbox clients for a project.
//
// Each project has an AgentFS agent whose workspace is read-write access to
// the project folder only. The token server records which agent belongs to
// each project, so every computer uses the same one. The app writes to the
// project with the agent's token, so Dropbox records those writes as the
// agent's and can list and undo them (see engine/agents.ts). The agent's token
// is minted from the managed user's token and renewed the same way.
//
// Reads use the managed user's token, and writes use the agent's.
import {AgentTokenProvider, projectAgent, type AgentDirectory, type Rpc} from '../engine/agents';
import {DropboxClient, type DropboxFiles, type TokenSource} from '../engine/dropboxApi';
import {projectKey} from '../engine/paths';
import {TokenManager} from '../engine/tokenManager';

// What the app needs from a client with the managed user's token.
export type UserApi = DropboxFiles & Rpc;

export interface AgentSession {
  agentId: string;
  tokens: TokenManager;
}

export class ProjectClients {
  // By projectKey of the project name.
  private readonly sessions = new Map<string, Promise<AgentSession>>();

  constructor(
    private readonly userApi: () => UserApi,
    // Where the signed-in user's project agents are recorded.
    private readonly directory: () => AgentDirectory,
    private readonly makeClient: (tokens: TokenSource) => DropboxFiles = (tokens) =>
      new DropboxClient({tokens})
  ) {}

  // Finds or creates the project's agent once, and renews its tokens with the
  // user's token. A failed lookup is forgotten, so the next call tries again.
  agent(project: string): Promise<AgentSession> {
    let session = this.sessions.get(projectKey(project));
    if (!session) {
      const api = this.userApi();
      session = projectAgent(api, `/${project}`, this.directory()).then((agentId) => ({
        agentId,
        tokens: new TokenManager(new AgentTokenProvider(api, agentId)),
      }));
      session.catch(() => {
        if (this.sessions.get(projectKey(project)) === session) {
          this.sessions.delete(projectKey(project));
        }
      });
      this.sessions.set(projectKey(project), session);
    }
    return session;
  }

  // A client with the project agent's token, for the project's writes.
  async agentClient(project: string): Promise<DropboxFiles> {
    return this.makeClient((await this.agent(project)).tokens);
  }

  // The client the sync pass uses: reads as the user, writes as the agent.
  async syncFiles(project: string): Promise<DropboxFiles> {
    const user = this.userApi();
    const agent = await this.agentClient(project);
    return {
      listFolder: (path, recursive) => user.listFolder(path, recursive),
      listFolderContinue: (cursor) => user.listFolderContinue(cursor),
      downloadToFile: (path, dest) => user.downloadToFile(path, dest),
      upload: (req) => agent.upload(req),
      deleteV2: (path, parentRev) => agent.deleteV2(path, parentRev),
      createFolder: (path) => agent.createFolder(path),
    };
  }

  // Stops renewing a project's agent token, for example after it's removed.
  forget(project: string): void {
    const session = this.sessions.get(projectKey(project));
    this.sessions.delete(projectKey(project));
    session?.then((s) => s.tokens.stop()).catch(() => {});
  }

  // Forgets every project, for example when the user signs out.
  forgetAll(): void {
    for (const project of [...this.sessions.keys()]) {
      this.forget(project);
    }
  }

  onWake(): void {
    for (const session of this.sessions.values()) {
      session.then((s) => s.tokens.onWake()).catch(() => {});
    }
  }
}
