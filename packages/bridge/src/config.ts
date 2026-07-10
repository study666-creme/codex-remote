import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BridgeConfig, WorkspaceConfig } from "./types.js";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".codex-remote");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const VERSION = readPackageVersion();

export function loadConfig(create = false): BridgeConfig {
  try {
    const config = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as BridgeConfig);
    if (create) saveConfig(config);
    return config;
  } catch {
    const config = normalizeConfig({
      url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`,
      token: crypto.randomBytes(18).toString("hex"),
    });
    if (create) saveConfig(config);
    return config;
  }
}

export function saveConfig(config: BridgeConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function configureBridge(values: {
  publicUrl?: string;
  token?: string;
  workspacePath?: string;
  listenHost?: string;
  port?: number;
  origins?: string[];
}) {
  const config = loadConfig(true);
  if (values.publicUrl) {
    const publicUrl = validatePublicUrl(values.publicUrl);
    config.publicUrl = publicUrl;
    config.url = publicUrl;
  }
  if (values.token) config.token = values.token;
  if (values.listenHost) config.listenHost = values.listenHost;
  if (values.port && Number.isInteger(values.port) && values.port > 0 && values.port < 65536) config.port = values.port;
  if (values.origins?.length) config.origins = [...new Set(values.origins.map((origin) => origin.replace(/\/+$/, "")))];
  saveConfig(config);
  if (values.workspacePath) updateWorkspace(config, "default", { workspacePath: values.workspacePath });
  return loadConfig();
}

export function ensureWorkspace(config: BridgeConfig, workspaceId: string) {
  const id = safeSegment(workspaceId || "default");
  config.workspaces ||= {};
  const current = config.workspaces[id];

  if (current?.workspacePath) {
    const workspacePath = resolveWorkspacePath(current.workspacePath);
    fs.mkdirSync(workspacePath, { recursive: true });
    return { workspaceId: id, ...current, workspacePath };
  }

  const defaultWorkspace = String(process.env.CODEX_REMOTE_WORKSPACE || process.env.CANVAS_AGENT_WORKSPACE || "").trim();
  const workspacePath = id === "default" && defaultWorkspace ? resolveWorkspacePath(defaultWorkspace) : path.join(CONFIG_DIR, "workspaces", id);
  config.workspaces[id] = { workspacePath };
  fs.mkdirSync(workspacePath, { recursive: true });
  saveConfig(config);
  return { workspaceId: id, workspacePath };
}

export function updateWorkspace(config: BridgeConfig, workspaceId: string, patch: Partial<WorkspaceConfig>) {
  const current = ensureWorkspace(config, workspaceId);
  const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
  const next = { ...current, ...patch, workspacePath };
  config.workspaces ||= {};
  config.workspaces[current.workspaceId] = {
    workspacePath: next.workspacePath,
    activeThreadId: next.activeThreadId,
    pinnedThreadIds: next.pinnedThreadIds,
    model: next.model,
    effort: next.effort,
  };
  fs.mkdirSync(workspacePath, { recursive: true });
  saveConfig(config);
  return { workspaceId: current.workspaceId, ...config.workspaces[current.workspaceId] };
}

export function fixedPublicUrl(config?: BridgeConfig) {
  return Boolean(
    String(process.env.CODEX_REMOTE_PUBLIC_URL || process.env.CODEX_REMOTE_URL || process.env.CANVAS_AGENT_PUBLIC_URL || process.env.CANVAS_AGENT_URL || config?.publicUrl || "").trim(),
  );
}

export function envAllowedOrigins() {
  return String(process.env.CODEX_REMOTE_ALLOWED_ORIGINS || process.env.CANVAS_AGENT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveWorkspacePath(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function normalizeConfig(config: BridgeConfig) {
  const token = String(process.env.CODEX_REMOTE_TOKEN || process.env.CANVAS_AGENT_TOKEN || "").trim();
  const publicUrl = String(process.env.CODEX_REMOTE_PUBLIC_URL || process.env.CODEX_REMOTE_URL || process.env.CANVAS_AGENT_PUBLIC_URL || process.env.CANVAS_AGENT_URL || "").trim();
  if (!config.token) config.token = crypto.randomBytes(18).toString("hex");
  if (token) config.token = token;
  if (!config.url) config.url = `http://127.0.0.1:${Number(process.env.PORT) || config.port || DEFAULT_PORT}`;
  if (publicUrl) config.publicUrl = publicUrl.replace(/\/+$/, "");
  if (config.publicUrl) config.url = config.publicUrl.replace(/\/+$/, "");
  return config;
}

function validatePublicUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Public URL must use HTTPS. HTTP is allowed only for localhost.");
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Public URL must be an origin without a path, query, or hash.");
  return normalized;
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "default";
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
