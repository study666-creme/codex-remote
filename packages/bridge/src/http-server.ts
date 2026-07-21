import express, { type NextFunction, type Request, type Response } from "express";
import os, { type NetworkInterfaceInfo } from "node:os";
import path from "node:path";

import type { CodexThreadSummary, CodexWorkspaceProject } from "@codex-remote/shared";

import {
  DEFAULT_PORT,
  ensureWorkspace,
  envAllowedOrigins,
  fixedPublicUrl,
  loadConfig,
  saveConfig,
  updateWorkspace,
  VERSION,
} from "./config.js";
import {
  archiveCodexThread,
  getCodexThreadStatus,
  listCodexThreads,
  readCodexThreadFast,
  beginCodexTurn,
  interruptCodexTurn,
  startCodexThread,
  steerCodexTurn,
  summarizeCodexThread,
  verifyCodexThreadWorkspace,
} from "./agents.js";
import { EventHub } from "./events.js";
import { discoverGitRepos, findRepoByPath, resolveGitWorkspace, runGitPush, safeGitRef } from "./git.js";
import type { AgentAttachment, BridgeConfig } from "./types.js";

export function startHttpServer() {
  const config = loadConfig(true);
  const port = Number(process.env.PORT) || config.port || DEFAULT_PORT;
  const listenHost = process.env.CODEX_REMOTE_HOST || process.env.CANVAS_AGENT_HOST || process.env.HOST || config.listenHost || "127.0.0.1";
  if (!fixedPublicUrl(config)) {
    const publicHost = process.env.CODEX_REMOTE_PUBLIC_HOST || (listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost);
    config.url = `http://${publicHost}:${port}`;
  }
  saveConfig(config);

  const events = new EventHub();
  const emit = (type: string, payload: unknown, context?: { threadId?: string; turnId?: string }) => events.emitAll(type, payload, context);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "30mb" }));
  app.use((req, res, next) => {
    const url = requestUrl(req, config);
    if (!setCors(req, res, url, config)) {
      res.status(403).json({ ok: false, error: "origin not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => res.json(events.health()));
  app.get("/config", (_req, res) => res.json({
    ok: true,
    url: config.url,
    listenHost,
    lanUrls: lanUrls(port),
    hasToken: Boolean(config.token),
    fixedPublicUrl: fixedPublicUrl(config),
    version: VERSION,
  }));

  app.use((req, res, next) => {
    if (validToken(req, requestUrl(req, config), config.token)) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: "invalid token" });
  });

  app.get("/events", (req, res) => events.openEvents(requestUrl(req, config), res, req.get("last-event-id")));
  app.get("/agent/codex/workspace", (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    res.json({ ok: true, workspace });
  });
  app.post("/agent/codex/workspace", (req, res) => {
    const workspace = updateWorkspace(config, requestWorkspaceId(req), {
      ...(req.body?.workspacePath ? { workspacePath: String(req.body.workspacePath) } : {}),
      ...requestCodexModelPatch(req),
    });
    res.json({ ok: true, workspace });
  });
  app.get("/agent/codex/threads", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const result = await listCodexThreads(emit, { cwd: workspace.workspacePath, searchTerm: String(req.query.searchTerm || "") });
    res.json({ ok: true, workspace, ...result });
  }));
  app.get("/agent/codex/workspaces", route(async (req, res) => {
    const result = await listCodexThreads(emit, {
      searchTerm: String(req.query.searchTerm || ""),
      limit: Number(req.query.limit || 160) || 160,
    });
    res.json({ ok: true, projects: codexWorkspaceProjects(config, result.data), ...result });
  }));
  app.get("/agent/codex/status", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const threadId = String(req.query.threadId || workspace.activeThreadId || "");
    const status = threadId
      ? await getCodexThreadStatus(emit, threadId, workspace.workspacePath)
      : { thread: null, busy: false, activeTurnId: "", canSteer: false };
    res.json({ ok: true, workspace, threadId, ...status });
  }));
  app.post("/agent/codex/threads/new", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const modelOptions = requestCodexModelOptions(req, workspace);
    const saved = rememberCodexModelOptions(config, workspace, modelOptions);
    const thread = await startCodexThread(emit, saved.workspacePath, modelOptions);
    const activeThreadId = String((thread as Record<string, unknown>).id || "");
    const nextWorkspace = updateWorkspace(config, saved.workspaceId, { activeThreadId });
    res.json({ ok: true, workspace: nextWorkspace, thread: summarizeCodexThread(thread), messages: [] });
  }));
  app.get("/agent/codex/threads/:threadId", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const threadId = routeParam(req.params.threadId);
    res.json({ ok: true, workspace, ...(await readCodexThreadFast(emit, threadId, workspace.workspacePath)) });
  }));
  app.post("/agent/codex/threads/:threadId/resume", route(async (req, res) => {
    const initialWorkspace = ensureWorkspace(config, requestWorkspaceId(req));
    const workspacePath = String(req.body?.workspacePath || "").trim();
    const workspace = workspacePath
      ? updateWorkspace(config, initialWorkspace.workspaceId, { workspacePath })
      : initialWorkspace;
    const threadId = routeParam(req.params.threadId);
    const modelOptions = requestCodexModelOptions(req, workspace);
    const saved = rememberCodexModelOptions(config, workspace, modelOptions);
    const result = await readCodexThreadFast(emit, threadId, saved.workspacePath);
    const nextWorkspace = updateWorkspace(config, saved.workspaceId, { activeThreadId: threadId });
    res.json({ ok: true, workspace: nextWorkspace, ...result });
  }));
  app.post("/agent/codex/threads/:threadId/delete", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const threadId = routeParam(req.params.threadId);
    await archiveCodexThread(emit, threadId, workspace.workspacePath);
    if (workspace.activeThreadId === threadId) updateWorkspace(config, workspace.workspaceId, { activeThreadId: undefined });
    res.json({ ok: true });
  }));
  app.post("/agent/codex/turn", route(async (req, res) => {
    const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const modelOptions = requestCodexModelOptions(req, workspace);
    const saved = rememberCodexModelOptions(config, workspace, modelOptions);
    const prompt = String(req.body?.prompt || "");
    let threadId = String(req.body?.threadId || saved.activeThreadId || "");
    if (!threadId) {
      const thread = await startCodexThread(emit, saved.workspacePath, modelOptions);
      threadId = String((thread as Record<string, unknown>).id || "");
      updateWorkspace(config, saved.workspaceId, { activeThreadId: threadId });
    } else if (threadId !== saved.activeThreadId) {
      await verifyCodexThreadWorkspace(emit, threadId, saved.workspacePath);
      updateWorkspace(config, saved.workspaceId, { activeThreadId: threadId });
    }
    const started = await beginCodexTurn(prompt, emit, attachments, { threadId, cwd: saved.workspacePath, ...modelOptions });
    res.json({ ok: true, ...started });
  }));
  app.post("/agent/codex/turn/steer", route(async (req, res) => {
    const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const threadId = String(req.body?.threadId || workspace.activeThreadId || "");
    if (!threadId) throw new Error("There is no active Codex thread to steer.");
    const requestId = String(req.get("idempotency-key") || req.body?.requestId || "");
    await steerCodexTurn(String(req.body?.prompt || ""), emit, attachments, { threadId, cwd: workspace.workspacePath, requestId });
    res.json({ ok: true, threadId });
  }));
  app.post("/agent/codex/turn/interrupt", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const threadId = String(req.body?.threadId || workspace.activeThreadId || "");
    if (!threadId) return res.json({ ok: true, interrupted: false, reason: "no_active_thread" });
    const turnId = String(req.body?.turnId || "");
    const result = await interruptCodexTurn(emit, threadId, workspace.workspacePath, turnId);
    res.json({ ok: true, threadId, ...result });
  }));
  app.get("/agent/git/repos", (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    res.json({ ok: true, workspace, repos: discoverGitRepos(workspace.workspacePath) });
  });
  app.post("/agent/git/push", route(async (req, res) => {
    const workspace = ensureWorkspace(config, requestWorkspaceId(req));
    const repos = discoverGitRepos(workspace.workspacePath);
    const requestedRepoPath = String(req.body?.repoPath || "").trim();
    const defaultRepoPath = resolveGitWorkspace(workspace.workspacePath);
    const repo = requestedRepoPath ? findRepoByPath(repos, requestedRepoPath) : findRepoByPath(repos, defaultRepoPath) || repos[0];
    if (!repo) throw new Error("No Git repository was found in this workspace.");
    if (repo.pushBlocked && !req.body?.allowBlocked) throw new Error(`Refusing to push ${repo.repoPath}: ${repo.warnings.join(" ")}`);
    const remote = safeGitRef(String(req.body?.remote || repo.defaultRemote || "origin"), "origin");
    const branch = safeGitRef(String(req.body?.branch || repo.defaultBranch || "main"), "main");
    const result = await runGitPush(repo.repoPath, remote, branch);
    res.json({ ok: true, workspace, repo, remote, branch, ...result });
  }));

  app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ ok: false, error: error.message });
  });

  const server = app.listen(port, listenHost, () => {
    console.log("Codex Remote Bridge");
    console.log(`Agent URL: ${config.url}`);
    if (listenHost === "0.0.0.0" && !fixedPublicUrl(config)) lanUrls(port).forEach((url) => console.log(`LAN URL: ${url}`));
    console.log(`Connect token: ${config.token}`);
    console.log(`Workspace: ${ensureWorkspace(config, "default").workspacePath}`);
  });
  return server;
}

function route(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] || "" : value;
}

function requestWorkspaceId(req: Request) {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  return String(body.workspaceId || req.query.workspaceId || "default");
}

function requestCodexModelPatch(req: Request) {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  return {
    ...(Object.prototype.hasOwnProperty.call(body, "model") ? { model: stringOrUndefined(body.model) } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "effort") ? { effort: stringOrUndefined(body.effort) } : {}),
  };
}

function requestCodexModelOptions(req: Request, workspace?: { model?: string; effort?: string }) {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const patch = requestCodexModelPatch(req);
  return {
    model: Object.prototype.hasOwnProperty.call(body, "model") ? patch.model || "" : workspace?.model || "",
    effort: Object.prototype.hasOwnProperty.call(body, "effort") ? patch.effort || "" : workspace?.effort || "",
  };
}

function rememberCodexModelOptions<T extends { workspaceId: string; workspacePath: string; activeThreadId?: string; model?: string; effort?: string }>(
  config: BridgeConfig,
  workspace: T,
  options: { model?: string; effort?: string },
) {
  if (options.model === (workspace.model || "") && options.effort === (workspace.effort || "")) return workspace;
  return updateWorkspace(config, workspace.workspaceId, {
    model: stringOrUndefined(options.model),
    effort: stringOrUndefined(options.effort),
  });
}

function stringOrUndefined(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function requestUrl(req: Request, config: BridgeConfig) {
  return new URL(req.originalUrl || req.url || "/", config.url);
}

function setCors(req: Request, res: Response, url: URL, config: BridgeConfig) {
  const origin = req.headers.origin;
  const allowed = new Set([...(config.origins || []), ...envAllowedOrigins()].map((item) => item.replace(/\/+$/, "")));
  const normalizedOrigin = origin?.replace(/\/+$/, "");
  const publicRoute = url.pathname === "/health" || url.pathname === "/config";
  const authenticated = validToken(req, url, config.token);
  if (normalizedOrigin && authenticated && !allowed.has(normalizedOrigin)) {
    config.origins = [...new Set([...(config.origins || []), normalizedOrigin])];
    saveConfig(config);
    allowed.add(normalizedOrigin);
  }
  const originAllowed = !normalizedOrigin || req.method === "OPTIONS" || publicRoute || allowed.has(normalizedOrigin);
  if (originAllowed) res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-codex-remote-token,x-canvas-agent-token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
  return originAllowed;
}

function validToken(req: Request, url: URL, token: string) {
  const current = req.headers["x-codex-remote-token"] || req.headers["x-canvas-agent-token"];
  return url.searchParams.get("token") === token || current === token || (Array.isArray(current) && current.includes(token));
}

function lanUrls(port: number) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item): item is NetworkInterfaceInfo => Boolean(item && item.family === "IPv4" && !item.internal))
    .map((item) => `http://${item.address}:${port}`);
}

function codexWorkspaceProjects(config: BridgeConfig, threads: CodexThreadSummary[]) {
  const projects = new Map<string, CodexWorkspaceProject>();
  Object.entries(config.workspaces || {}).forEach(([workspaceId, workspace]) => {
    if (!workspace.workspacePath) return;
    const workspacePath = path.resolve(workspace.workspacePath);
    projects.set(repoKey(workspacePath), {
      id: workspaceId,
      label: workspaceLabel(workspaceId, workspacePath),
      workspaceId,
      workspacePath,
      threadId: workspace.activeThreadId || "",
      threadCount: 0,
      updatedAt: 0,
      source: "saved",
    });
  });
  threads.forEach((thread) => {
    if (!thread.cwd) return;
    const workspacePath = path.resolve(thread.cwd);
    const key = repoKey(workspacePath);
    const updatedAt = Number(thread.updatedAt || thread.createdAt || 0);
    const existing = projects.get(key);
    if (existing) {
      existing.threadCount += 1;
      if (updatedAt > existing.updatedAt) {
        existing.updatedAt = updatedAt;
        if (!existing.threadId || existing.source === "discovered") existing.threadId = thread.id;
      }
      return;
    }
    const workspaceId = workspacePathId(workspacePath);
    projects.set(key, {
      id: workspaceId,
      label: workspaceLabel("", workspacePath),
      workspaceId,
      workspacePath,
      threadId: thread.id,
      threadCount: 1,
      updatedAt,
      source: "discovered",
    });
  });
  return [...projects.values()].sort((a, b) => {
    if (Boolean(a.threadCount) !== Boolean(b.threadCount)) return a.threadCount ? -1 : 1;
    if (a.source !== b.source) return a.source === "saved" ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0) || a.label.localeCompare(b.label);
  });
}

function workspacePathId(workspacePath: string) {
  const name = path.basename(workspacePath).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32) || "workspace";
  const hash = Buffer.from(path.resolve(workspacePath).toLowerCase()).toString("base64url").slice(0, 18);
  return `${name}-${hash}`;
}

function workspaceLabel(workspaceId: string, workspacePath: string) {
  if (workspaceId && !workspaceId.startsWith("workspace-") && workspaceId !== "default") return workspaceId;
  return path.basename(workspacePath) || workspacePath;
}

function repoKey(repoPath: string) {
  const resolved = path.resolve(repoPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
