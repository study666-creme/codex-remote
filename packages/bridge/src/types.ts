export type AgentEventContext = {
  threadId?: string;
  turnId?: string;
};

export type AgentEmit = (type: string, payload: unknown, context?: AgentEventContext) => void;

export type AgentAttachment = {
  name?: string;
  type?: string;
  dataUrl?: string;
  kind?: "image" | "document";
  size?: number;
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
