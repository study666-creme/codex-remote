export type AgentEmit = (type: string, payload: unknown) => void;

export type AgentAttachment = {
  name?: string;
  type?: string;
  dataUrl?: string;
};

export type WorkspaceConfig = {
  workspacePath: string;
  activeThreadId?: string;
  pinnedThreadIds?: string[];
  model?: string;
  effort?: string;
};

export type BridgeConfig = {
  url: string;
  publicUrl?: string;
  token: string;
  listenHost?: string;
  port?: number;
  origins?: string[];
  workspaces?: Record<string, WorkspaceConfig>;
};
