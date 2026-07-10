export type ReceiveMode = "full" | "text" | "final";

export type CodexRemoteSettings = {
  agentUrl: string;
  token: string;
  workspaceId: string;
  workspacePath: string;
  threadId: string;
  gitRepoPath: string;
  model: string;
  effort: string;
  receiveMode: ReceiveMode;
};

export type AgentAttachment = {
  name?: string;
  type?: string;
  dataUrl?: string;
  kind?: "image" | "document";
  size?: number;
};

export type CodexRemoteMessageRole = "user" | "assistant" | "tool" | "error" | "status";

export type CodexRemoteMessage = {
  id: string;
  role: CodexRemoteMessageRole;
  title?: string;
  text: string;
  streamId?: string;
  detail?: unknown;
};

export type CodexWorkspace = {
  workspaceId: string;
  workspacePath: string;
  activeThreadId?: string;
  model?: string;
  effort?: string;
};

export type CodexThreadSummary = {
  id: string;
  sessionId?: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  status?: string;
  source?: unknown;
  threadSource?: unknown;
  createdAt?: number;
  updatedAt?: number;
};

export type CodexWorkspaceProject = {
  id: string;
  label: string;
  workspaceId: string;
  workspacePath: string;
  threadId: string;
  threadCount: number;
  updatedAt: number;
  source: "saved" | "discovered";
};

export type GitRemoteInfo = {
  name: string;
  url: string;
};

export type GitRepoInfo = {
  repoPath: string;
  branch: string;
  defaultRemote: string;
  defaultBranch: string;
  remotes: GitRemoteInfo[];
  dirty: boolean;
  statusShort: string[];
  warnings: string[];
  pushBlocked: boolean;
};

export type BridgeConfigResponse = {
  ok: boolean;
  url: string;
  listenHost: string;
  lanUrls: string[];
  hasToken: boolean;
  fixedPublicUrl: boolean;
  version: string;
};

export type BridgeHealthResponse = {
  ok: boolean;
  clients: number;
  version: string;
};

export type CodexAgentEvent = {
  agent?: "codex";
  type?: string;
  item?: Record<string, unknown>;
  usage?: unknown;
  message?: string;
  thread_id?: string;
  turn_id?: string;
  [key: string]: unknown;
};
