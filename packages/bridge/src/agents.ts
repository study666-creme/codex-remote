import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { codexSandboxMode, VERSION } from "./config.js";
import type { AgentAttachment, AgentEmit } from "./types.js";

type Json = Record<string, unknown>;
type AgentEvent = Json & { type: string; usage?: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
type CodexModelOptions = { model?: string; effort?: string };
type CodexRunOptions = { threadId?: string; cwd?: string } & CodexModelOptions;
type CodexSteerOptions = Required<Pick<CodexRunOptions, "threadId">> & Pick<CodexRunOptions, "cwd"> & { requestId?: string };
type DocumentMention = { name: string; path: string };
type PreparedAttachments = { images: string[]; documents: DocumentMention[]; cleanupPaths: string[] };
type AgentHistoryMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  title?: string;
  text: string;
  detail?: unknown;
  streamId?: string;
};
type ThreadListResult = {
  data: ReturnType<typeof summarizeCodexThread>[];
  nextCursor: unknown;
  backwardsCursor: unknown;
};

let codexApp: CodexAppClient | null = null;
let codexAppStart: Promise<CodexAppClient> | null = null;
let threadListGeneration = 0;
const threadListCache = new Map<string, { expiresAt: number; value: ThreadListResult }>();
const threadListInFlight = new Map<string, Promise<ThreadListResult>>();
const steerRequests = new Map<string, Promise<void>>();
const THREAD_LIST_CACHE_MS = 10_000;
const STEER_REQUEST_CACHE_MS = 10 * 60_000;
const STEER_REQUEST_CACHE_LIMIT = 256;
const CODEX_SESSION_TAIL_BYTES = 8 * 1024 * 1024;
const CODEX_SESSION_HEAD_BYTES = 1024 * 1024;
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const fastThreadCache = new Map<string, { size: number; mtimeMs: number; value: Awaited<ReturnType<typeof readSessionThreadNow>> }>();
let sessionFileIndex: { expiresAt: number; files: Map<string, string> } | null = null;
const require = createRequire(import.meta.url);

function invalidateThreadListCache() {
  threadListGeneration += 1;
  threadListCache.clear();
  threadListInFlight.clear();
}

function getCodexApp(emit: AgentEmit) {
  if (codexApp) return Promise.resolve(codexApp);
  codexAppStart ||= CodexAppClient.start(emit)
    .then((client) => {
      codexApp = client;
      return client;
    })
    .finally(() => {
      codexAppStart = null;
    });
  return codexAppStart;
}

export async function beginCodexTurn(
  prompt: string,
  emit: AgentEmit,
  attachments: AgentAttachment[] = [],
  options: CodexRunOptions = {},
) {
  if (!prompt.trim()) throw new Error("Prompt cannot be empty.");
  let prepared = emptyPreparedAttachments();
  try {
    prepared = await prepareAttachmentFiles(attachments);
    const app = await getCodexApp(emit);
    const threadId = await ensureCodexThread(app, options);
    const { turnId, completion } = await app.beginTurn(threadId, prompt, prepared.images, prepared.documents, options);
    const receipt = {
      accepted: prepared.images.length + prepared.documents.length,
      images: prepared.images.length,
      documents: prepared.documents.length,
      names: attachments.map((item) => item.name || "attachment"),
    };
    invalidateThreadListCache();
    void completion
      .catch((error) => emit("agent_error", { message: errorMessage(error) }, { threadId, turnId }))
      .finally(async () => {
        invalidateThreadListCache();
        await cleanupPreparedAttachments(prepared);
      });
    return { threadId, turnId, attachments: receipt };
  } catch (error) {
    await cleanupPreparedAttachments(prepared);
    throw error;
  }
}

export async function steerCodexTurn(
  prompt: string,
  emit: AgentEmit,
  attachments: AgentAttachment[] = [],
  options: CodexSteerOptions,
) {
  if (!prompt.trim()) throw new Error("Steering prompt cannot be empty.");
  const requestId = String(options.requestId || "").trim().slice(0, 200);
  const requestKey = requestId ? `${options.threadId}\u0000${requestId}` : "";
  const existing = requestKey ? steerRequests.get(requestKey) : undefined;
  if (existing) return existing;

  const request = executeCodexSteer(prompt, emit, attachments, options);
  if (requestKey) {
    if (steerRequests.size >= STEER_REQUEST_CACHE_LIMIT) {
      const oldest = steerRequests.keys().next().value;
      if (oldest) steerRequests.delete(oldest);
    }
    steerRequests.set(requestKey, request);
    void request.then(
      () => {
        const timer = setTimeout(() => {
          if (steerRequests.get(requestKey) === request) steerRequests.delete(requestKey);
        }, STEER_REQUEST_CACHE_MS);
        timer.unref();
      },
      () => {
        if (steerRequests.get(requestKey) === request) steerRequests.delete(requestKey);
      },
    );
  }
  return request;
}

async function executeCodexSteer(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: CodexSteerOptions) {
  let prepared = emptyPreparedAttachments();
  let cleanupDeferred = false;
  try {
    prepared = await prepareAttachmentFiles(attachments);
    const app = await getCodexApp(emit);
    let activeTurnId = app.activeTurnId(options.threadId);
    if (!activeTurnId) {
      const thread = await loadCodexThread(emit, options.threadId, options.cwd, true);
      activeTurnId = activeTurnIdFromThread(thread);
    }
    await app.steerTurn(options.threadId, prompt, prepared.images, prepared.documents, activeTurnId);
    if (prepared.documents.length) {
      deferAttachmentCleanup(prepared);
      cleanupDeferred = true;
    }
  } finally {
    invalidateThreadListCache();
    if (!cleanupDeferred) await cleanupPreparedAttachments(prepared);
  }
}

export async function getCodexThreadStatus(emit: AgentEmit, threadId: string, cwd?: string) {
  const app = await getCodexApp(emit);
  const result = threadId ? await loadCodexThread(emit, threadId, cwd, true) : null;
  const thread = result ? summarizeCodexThread(result) : null;
  const localActiveTurnId = app.activeTurnId(threadId);
  const inferredActiveTurnId = localActiveTurnId ? "" : activeTurnIdFromThread(result);
  const activeTurnId = localActiveTurnId || inferredActiveTurnId || "";
  const busy = Boolean(activeTurnId) || busyStatus(String(thread?.status || ""));
  return { thread, busy, activeTurnId, canSteer: Boolean(activeTurnId) };
}

export async function startCodexThread(emit: AgentEmit, cwd?: string, options: CodexModelOptions = {}) {
  const app = await getCodexApp(emit);
  const thread = await app.startThread(cwd, options);
  invalidateThreadListCache();
  return thread;
}

export async function resumeCodexThread(
  emit: AgentEmit,
  threadId: string,
  cwd?: string,
  options: CodexModelOptions = {},
) {
  const app = await getCodexApp(emit);
  await loadCodexThread(emit, threadId, cwd, false);
  const thread = await app.resumeThread(threadId, cwd, options);
  assertThreadWorkspace(thread, cwd);
  return { thread, messages: threadMessages(thread) };
}

export async function listCodexThreads(
  emit: AgentEmit,
  options: { cwd?: string; searchTerm?: string; limit?: number },
) {
  const key = JSON.stringify({ cwd: options.cwd || "", searchTerm: options.searchTerm || "", limit: options.limit || 40 });
  const cached = threadListCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = threadListInFlight.get(key);
  if (existing) return existing;

  const generation = threadListGeneration;
  const request = (async () => {
    const app = await getCodexApp(emit);
    const result = await app.listThreads({
      limit: options.limit || 40,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer", "exec"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    });
    const data = Array.isArray(field(result, "data"))
      ? (field(result, "data") as unknown[])
          .map(summarizeCodexThread)
          .filter((thread) => !options.cwd || threadInWorkspace(thread, options.cwd))
      : [];
    const value = {
      data,
      nextCursor: field(result, "nextCursor") || null,
      backwardsCursor: field(result, "backwardsCursor") || null,
    };
    if (generation === threadListGeneration) threadListCache.set(key, { expiresAt: Date.now() + THREAD_LIST_CACHE_MS, value });
    return value;
  })();
  threadListInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (threadListInFlight.get(key) === request) threadListInFlight.delete(key);
  }
}

export async function readCodexThread(emit: AgentEmit, threadId: string, cwd?: string) {
  const thread = await loadCodexThread(emit, threadId, cwd, true);
  const summary = summarizeCodexThread(thread);
  const activeTurnId = codexApp?.activeTurnId(threadId) || activeTurnIdFromThread(thread);
  return {
    thread: summary,
    messages: threadMessages(thread),
    busy: Boolean(activeTurnId) || busyStatus(summary.status),
    activeTurnId,
  };
}

export async function readCodexThreadFast(emit: AgentEmit, threadId: string, cwd?: string) {
  try {
    const sessionFile = await findSessionFile(threadId);
    if (!sessionFile) return await readCodexThread(emit, threadId, cwd);
    const stat = await fs.stat(sessionFile);
    const cached = fastThreadCache.get(threadId);
    const value = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
      ? cached.value
      : await readSessionThreadNow(sessionFile, threadId, stat);
    fastThreadCache.set(threadId, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    if (fastThreadCache.size > 24) fastThreadCache.delete(fastThreadCache.keys().next().value || "");
    assertThreadWorkspace(value.thread, cwd);
    const activeTurnId = codexApp?.activeTurnId(threadId) || value.activeTurnId;
    return {
      ...value,
      thread: { ...value.thread, status: activeTurnId ? "running" : value.thread.status },
      busy: Boolean(activeTurnId),
      activeTurnId,
      fastHistory: true,
    };
  } catch {
    return await readCodexThread(emit, threadId, cwd);
  }
}

export async function verifyCodexThreadWorkspace(emit: AgentEmit, threadId: string, cwd: string) {
  await loadCodexThread(emit, threadId, cwd, false);
}

export async function archiveCodexThread(emit: AgentEmit, threadId: string, cwd?: string) {
  const app = await getCodexApp(emit);
  await loadCodexThread(emit, threadId, cwd, false);
  await app.archiveThread(threadId);
  invalidateThreadListCache();
}

async function ensureCodexThread(app: CodexAppClient, options: CodexRunOptions) {
  if (options.threadId) {
    const result = await app.readThread(options.threadId, false);
    assertThreadWorkspace(field(result, "thread") || {}, options.cwd);
    const thread = await app.resumeThread(options.threadId, options.cwd, options);
    assertThreadWorkspace(thread, options.cwd);
    return String(field(thread, "id") || options.threadId);
  }
  const thread = await app.startThread(options.cwd, options);
  return String(field(thread, "id") || "");
}

class CodexAppClient {
  private nextId = 1;
  private buffer = "";
  private textByItem = new Map<string, string>();
  private deltaCount = 0;
  private lastUsage: unknown = null;
  private pending = new Map<number, PendingRequest>();
  private activeTurns = new Map<string, PendingRequest>();
  private activeTurnByThread = new Map<string, string>();
  private threadByTurn = new Map<string, string>();
  private threadByItem = new Map<string, string>();
  private completedTurns = new Map<string, Error | null>();

  private constructor(private child: ChildProcess, private emit: AgentEmit) {}

  private emitForThread(type: string, payload: unknown, context: { threadId?: string; turnId?: string } = {}) {
    this.emit(type, payload, context);
  }

  static async start(emit: AgentEmit) {
    const child = spawn(process.execPath, [codexBin(), "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new CodexAppClient(child, emit);
    child.stdout?.on("data", (chunk) => client.read(chunk.toString()));
    child.stderr?.on("data", (chunk) => emit("agent_log", { text: chunk.toString() }));
    child.on("error", (error) => emit("agent_error", { message: error.message }));
    child.on("exit", (code) => {
      client.failAll(`Codex app-server exited: ${code ?? 0}`);
      if (codexApp === client) codexApp = null;
      emit("agent_log", { text: `Codex app-server exited: ${code ?? 0}` });
    });
    await client.request("initialize", {
      clientInfo: { name: "codex-remote-bridge", title: "Codex Remote Bridge", version: VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify("initialized");
    return client;
  }

  async startThread(cwd?: string, options: CodexModelOptions = {}) {
    const result = await this.request("thread/start", {
      ...codexModelRequestOptions(options),
      approvalPolicy: "never",
      sandbox: codexSandboxMode(),
      config: codexConfig(options),
      ...(cwd ? { cwd } : {}),
      threadSource: "user",
    });
    const thread = field(result, "thread") as Json | undefined;
    if (!field(thread, "id")) throw new Error("Codex app-server did not return a thread id.");
    return thread || {};
  }

  async resumeThread(threadId: string, cwd?: string, options: CodexModelOptions = {}) {
    const result = await this.request("thread/resume", {
      threadId,
      ...codexModelRequestOptions(options),
      approvalPolicy: "never",
      sandbox: codexSandboxMode(),
      config: codexConfig(options),
      ...(cwd ? { cwd } : {}),
    });
    const thread = field(result, "thread") as Json | undefined;
    if (!field(thread, "id")) throw new Error("Codex app-server did not return a thread id.");
    return thread || {};
  }

  listThreads(params: Json) {
    return this.request("thread/list", params);
  }

  readThread(threadId: string, includeTurns = true) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  archiveThread(threadId: string) {
    return this.request("thread/archive", { threadId });
  }

  async beginTurn(threadId: string, prompt: string, images: string[], documents: DocumentMention[], options: CodexModelOptions = {}) {
    const result = await this.request("turn/start", {
      threadId,
      input: codexInput(prompt, images, documents),
      approvalPolicy: "never",
      ...codexTurnRequestOptions(options),
    });
    const turnId = String(field(field(result, "turn"), "id") || "");
    if (!turnId) throw new Error("Codex app-server did not return a turn id.");
    this.activeTurnByThread.set(threadId, turnId);
    this.threadByTurn.set(turnId, threadId);
    this.emitForThread("agent_event", { agent: "codex", type: "turn.started", thread_id: threadId, turn_id: turnId }, { threadId, turnId });
    const completed = this.completedTurns.get(turnId);
    let completion: Promise<unknown>;
    if (this.completedTurns.has(turnId)) {
      this.completedTurns.delete(turnId);
      completion = completed ? Promise.reject(completed) : Promise.resolve();
    } else {
      completion = new Promise((resolve, reject) => this.activeTurns.set(turnId, { resolve, reject }));
    }
    completion = completion.finally(() => {
      if (this.activeTurnByThread.get(threadId) === turnId) this.activeTurnByThread.delete(threadId);
      this.threadByTurn.delete(turnId);
    });
    return { turnId, completion };
  }

  async steerTurn(threadId: string, prompt: string, images: string[], documents: DocumentMention[], activeTurnId = "") {
    const expectedTurnId = activeTurnId || this.activeTurnByThread.get(threadId);
    if (!expectedTurnId) throw new Error("This thread has no active Codex turn to steer.");
    const input = codexInput(prompt, images, documents);
    try {
      return await this.request("turn/steer", { threadId, input, expectedTurnId });
    } catch (error) {
      const mismatch = parseActiveTurnMismatch(error);
      if (!mismatch?.found || mismatch.found === expectedTurnId) throw error;
      this.activeTurnByThread.set(threadId, mismatch.found);
      this.threadByTurn.set(mismatch.found, threadId);
      return this.request("turn/steer", { threadId, input, expectedTurnId: mismatch.found });
    }
  }

  activeTurnId(threadId?: string) {
    if (threadId) return this.activeTurnByThread.get(threadId) || "";
    const value = this.activeTurnByThread.values().next().value;
    return typeof value === "string" ? value : "";
  }

  private request(method: string, params: unknown) {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server request timed out: ${method}`));
        if (codexApp === this) {
          codexApp = null;
        }
        this.child.kill();
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(value: unknown) {
    this.child.stdin?.write(`${JSON.stringify(value)}\n`);
  }

  private read(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    lines.filter(Boolean).forEach((line) => {
      try {
        this.handle(JSON.parse(line) as Json);
      } catch {
        this.emit("agent_log", { text: line });
      }
    });
  }

  private handle(message: Json) {
    const id = Number(message.id);
    if (message.error && this.pending.has(id)) {
      this.reject(id, String(field(message.error, "message") || "Codex request failed"));
      return;
    }
    if (this.pending.has(id)) {
      this.resolve(id, message.result);
      return;
    }
    if (typeof message.method === "string" && "id" in message) {
      this.answerServerRequest(message);
      return;
    }
    if (typeof message.method === "string") this.handleNotification(message.method, (message.params || {}) as Json);
  }

  private handleNotification(method: string, params: Json) {
    const context = this.notificationContext(method, params);
    if (method === "item/agentMessage/delta") {
      this.emitDelta(params, context);
      return;
    }
    if (method === "thread/tokenUsage/updated") this.lastUsage = normalizeUsage(params);
    const event = normalizeCodexNotification(method, params);
    if (!event) return;
    if (event.type === "turn.completed") event.usage = this.lastUsage;
    this.emitForThread("agent_event", { agent: "codex", ...event }, context);
    if (event.type !== "turn.completed") return;

    const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
    const threadId = String(field(params, "threadId") || field(field(params, "turn"), "threadId") || "");
    if (threadId && this.activeTurnByThread.get(threadId) === turnId) this.activeTurnByThread.delete(threadId);
    const pending = this.activeTurns.get(turnId);
    const error = field(field(params, "turn"), "error");
    if (pending) {
      this.activeTurns.delete(turnId);
      error ? pending.reject(new Error(String(field(error, "message") || "Codex turn failed"))) : pending.resolve(event);
    } else if (turnId) {
      this.completedTurns.set(turnId, error ? new Error(String(field(error, "message") || "Codex turn failed")) : null);
    }
    this.emitForThread("agent_event", { agent: "codex", type: "stream.summary", delta_count: this.deltaCount }, context);
    this.deltaCount = 0;
    this.emitForThread("agent_done", { agent: "codex", usage: event.usage }, context);
  }

  private emitDelta(params: Json, context: { threadId?: string; turnId?: string }) {
    const id = String(field(params, "itemId") || "");
    const text = `${this.textByItem.get(id) || ""}${String(field(params, "delta") || "")}`;
    this.deltaCount += 1;
    this.textByItem.set(id, text);
    this.emitForThread("agent_event", { agent: "codex", type: "item.updated", item: { id, type: "agent_message", text } }, context);
  }

  private notificationContext(method: string, params: Json) {
    const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
    let threadId = String(field(params, "threadId") || field(field(params, "thread"), "id") || field(field(params, "turn"), "threadId") || "");
    const itemId = String(field(params, "itemId") || field(field(params, "item"), "id") || "");
    if (!threadId && turnId) threadId = this.threadByTurn.get(turnId) || "";
    if (!threadId && itemId) threadId = this.threadByItem.get(itemId) || "";
    if (method === "turn/started" && threadId && turnId) {
      this.threadByTurn.set(turnId, threadId);
      this.activeTurnByThread.set(threadId, turnId);
    }
    if (method === "item/started" && threadId && itemId) this.threadByItem.set(itemId, threadId);
    if (method === "item/completed" && itemId) this.threadByItem.delete(itemId);
    return { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
  }

  private answerServerRequest(message: Json) {
    const method = String(message.method);
    const result = method === "mcpServer/elicitation/request"
      ? { action: "decline", content: {}, _meta: null }
      : { decision: "decline" };
    this.write({ id: message.id, result });
    this.emit("agent_event", { agent: "codex", type: "server.request", method, params: message.params, result });
  }

  private resolve(id: number, result: unknown) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private reject(id: number, message: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }

  private failAll(message: string) {
    [...this.pending.values(), ...this.activeTurns.values()].forEach((item) => {
      if (item.timer) clearTimeout(item.timer);
      item.reject(new Error(message));
    });
    this.pending.clear();
    this.activeTurns.clear();
    this.activeTurnByThread.clear();
    this.threadByTurn.clear();
    this.threadByItem.clear();
  }
}

function codexConfig(options: CodexModelOptions = {}) {
  const config: Json = {};
  const normalized = normalizeCodexModelOptions(options);
  if (normalized.model) config.model = normalized.model;
  if (normalized.effort) config.model_reasoning_effort = normalized.effort;
  return config;
}

function normalizeCodexModelOptions(options: CodexModelOptions = {}) {
  return { model: String(options.model || "").trim(), effort: String(options.effort || "").trim() };
}

function codexModelRequestOptions(options: CodexModelOptions = {}) {
  const normalized = normalizeCodexModelOptions(options);
  return normalized.model ? { model: normalized.model } : {};
}

function codexTurnRequestOptions(options: CodexModelOptions = {}) {
  const normalized = normalizeCodexModelOptions(options);
  return {
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.effort ? { effort: normalized.effort } : {}),
  };
}

function codexInput(prompt: string, images: string[], documents: DocumentMention[]) {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...images.map((file) => ({ type: "localImage", path: file })),
    ...documents.map((file) => ({ type: "mention", name: file.name, path: file.path })),
  ];
}

function normalizeCodexNotification(method: string, params: Json): AgentEvent | null {
  if (method === "thread/started") return { type: "thread.started", thread_id: field(field(params, "thread"), "id") };
  if (method === "turn/started") return { type: "turn.started", thread_id: field(params, "threadId"), turn_id: field(field(params, "turn"), "id") };
  if (method === "turn/completed") return { type: "turn.completed", usage: null };
  if (method === "item/started") return { type: "item.started", item: normalizeItem(field(params, "item")) };
  if (method === "item/completed") return { type: "item.completed", item: normalizeItem(field(params, "item")) };
  if (method === "error") return { type: "error", message: field(params, "message") };
  return null;
}

async function findSessionFile(threadId: string) {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(threadId)) return "";
  if (!sessionFileIndex || sessionFileIndex.expiresAt <= Date.now()) {
    const files = new Map<string, string>();
    await indexSessionFiles(CODEX_SESSIONS_DIR, files);
    sessionFileIndex = { expiresAt: Date.now() + 30_000, files };
  }
  return sessionFileIndex.files.get(threadId) || "";
}

async function indexSessionFiles(directory: string, files: Map<string, string>) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await indexSessionFiles(filePath, files);
      continue;
    }
    const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
    if (!match) continue;
    const previous = files.get(match[1]);
    if (!previous || filePath.localeCompare(previous) > 0) files.set(match[1], filePath);
  }
}

async function readSessionThreadNow(sessionFile: string, threadId: string, stat: { size: number; mtimeMs: number; birthtimeMs: number }) {
  const tailStart = Math.max(0, stat.size - CODEX_SESSION_TAIL_BYTES);
  const tailBuffer = await readFileSlice(sessionFile, tailStart, stat.size - tailStart);
  let tailText = tailBuffer.toString("utf8");
  if (tailStart > 0) tailText = tailText.slice(Math.max(0, tailText.indexOf("\n") + 1));
  const tailRows = parseSessionRows(tailText);
  let metadata = [...tailRows].reverse().find((row) => row.type === "session_meta");
  if (!metadata) {
    const headBuffer = await readFileSlice(sessionFile, 0, Math.min(stat.size, CODEX_SESSION_HEAD_BYTES));
    metadata = parseSessionRows(headBuffer.toString("utf8")).find((row) => row.type === "session_meta");
  }

  const messages: AgentHistoryMessage[] = [];
  let activeTurnId = "";
  for (let index = 0; index < tailRows.length; index += 1) {
    const row = tailRows[index];
    const payload = field(row, "payload") as Json | undefined;
    const rowType = String(field(row, "type") || "");
    const payloadType = String(field(payload, "type") || "");
    const sourceId = String(field(payload, "id") || field(payload, "call_id") || "event");
    const id = `session-${index}-${sourceId}`;

    if (rowType === "event_msg" && payloadType === "task_started") {
      activeTurnId = String(field(payload, "turn_id") || id);
      continue;
    }
    if (rowType === "event_msg" && (payloadType === "task_complete" || payloadType === "turn_aborted")) {
      const completedTurnId = String(field(payload, "turn_id") || "");
      if (!completedTurnId || !activeTurnId || completedTurnId === activeTurnId) activeTurnId = "";
      continue;
    }
    if (rowType === "event_msg" && payloadType === "thread_rolled_back") {
      removeRecentTurns(messages, Number(field(payload, "num_turns") || 0));
      continue;
    }
    if (rowType === "event_msg" && payloadType === "user_message") {
      const text = String(field(payload, "message") || "").trim();
      if (text) messages.push({ id, role: "user", text });
      continue;
    }
    if (rowType === "event_msg" && payloadType === "agent_message") {
      const text = String(field(payload, "message") || "").trim();
      if (text) messages.push({ id, streamId: id, role: "assistant", title: "Codex", text });
      continue;
    }
    const tool = sessionToolMessage(rowType, payloadType, payload, id);
    if (tool) messages.push(tool);
  }

  const metaPayload = field(metadata, "payload") as Json | undefined;
  const cwd = String(field(metaPayload, "cwd") || "");
  return {
    thread: {
      id: threadId,
      sessionId: String(field(metaPayload, "session_id") || field(metaPayload, "id") || threadId),
      cwd,
      status: activeTurnId ? "running" : "completed",
      createdAt: stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
    },
    messages: limitSessionMessages(messages.filter((message) => message.text)),
    activeTurnId,
  };
}

async function readFileSlice(filePath: string, position: number, length: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseSessionRows(text: string) {
  const rows: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as Json);
    } catch {
      // The first or last line of a byte range can be incomplete.
    }
  }
  return rows;
}

function sessionToolMessage(rowType: string, payloadType: string, payload: Json | undefined, id: string): AgentHistoryMessage | null {
  if (rowType === "response_item" && payloadType === "function_call") {
    const name = String(field(payload, "name") || "Command");
    const args = parseMaybeJson(field(payload, "arguments"));
    const command = field(args, "cmd") || field(args, "command");
    return { id, role: "tool", title: name === "exec_command" ? "Command" : name, text: limitedToolText(command || `${name} completed`) };
  }
  if (rowType === "response_item" && payloadType === "custom_tool_call") {
    const name = String(field(payload, "name") || "Tool call");
    return { id, role: "tool", title: name === "apply_patch" ? "File change" : name, text: `${name} ${String(field(payload, "status") || "completed")}` };
  }
  if (rowType === "response_item" && payloadType === "tool_search_call") {
    return { id, role: "tool", title: "Tool search", text: limitedToolText(field(payload, "arguments") || "Tool search completed") };
  }
  if (rowType === "event_msg" && payloadType === "mcp_tool_call_end") {
    const invocation = field(payload, "invocation") as Json | undefined;
    const name = String(field(invocation, "tool") || field(invocation, "name") || "MCP tool");
    return { id, role: "tool", title: name, text: `${name} completed` };
  }
  return null;
}

function limitedToolText(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "completed").slice(0, 4000);
}

function removeRecentTurns(messages: AgentHistoryMessage[], count: number) {
  for (let turn = 0; turn < count; turn += 1) {
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) return;
    messages.splice(userIndex);
  }
}

function limitSessionMessages(messages: AgentHistoryMessage[]) {
  if (messages.length <= 120) return messages;
  const limited = messages.slice(-119);
  let latestUser: AgentHistoryMessage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUser = messages[index];
      break;
    }
  }
  if (!latestUser || limited.some((message) => message.id === latestUser?.id)) return messages.slice(-120);
  return [latestUser, ...limited];
}

async function loadCodexThread(emit: AgentEmit, threadId: string, cwd: string | undefined, includeTurns: boolean) {
  const app = await getCodexApp(emit);
  const result = await app.readThread(threadId, includeTurns);
  const thread = field(result, "thread") || {};
  assertThreadWorkspace(thread, cwd);
  return thread;
}

function assertThreadWorkspace(thread: unknown, cwd?: string) {
  if (!cwd || threadInWorkspace(thread, cwd)) return;
  throw new Error("This Codex thread does not belong to the selected workspace.");
}

function threadInWorkspace(thread: unknown, cwd: string) {
  const threadCwd = String(field(thread, "cwd") || "");
  if (!threadCwd) return false;
  const left = path.resolve(threadCwd);
  const right = path.resolve(cwd);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function busyStatus(status: string) {
  return ["running", "in_progress", "active", "busy", "pending"].includes(status.toLowerCase());
}

function terminalStatus(status: string) {
  return ["completed", "complete", "done", "failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

function activeTurnIdFromThread(thread: unknown) {
  const turns = arrayValue(field(thread, "turns"));
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const id = String(field(turn, "id") || "");
    if (!id) continue;
    const status = String(field(turn, "status") || field(turn, "state") || "").toLowerCase();
    if (busyStatus(status)) return id;
    if (terminalStatus(status)) continue;
    const completedAt = field(turn, "completedAt") || field(turn, "completed_at") || field(turn, "finishedAt") || field(turn, "finished_at");
    if (!completedAt && !field(turn, "error") && busyStatus(String(field(thread, "status") || ""))) return id;
  }
  return "";
}

export function parseActiveTurnMismatch(error: unknown) {
  const match = errorMessage(error).match(/expected active turn id\s+[`'"]([^`'"]+)[`'"]\s+but found\s+[`'"]([^`'"]+)[`'"]/i);
  return match ? { expected: match[1], found: match[2] } : null;
}

function normalizeItem(item: unknown) {
  const value = item && typeof item === "object" ? { ...(item as Json) } : {};
  if (value.type === "agentMessage") value.type = "agent_message";
  if (value.type === "mcpToolCall") value.type = "mcp_tool_call";
  if (value.type === "agent_message" && typeof value.id === "string") value.text = String(value.text || "");
  if ("arguments" in value) value.arguments = parseMaybeJson(value.arguments);
  return value;
}

function normalizeUsage(params: Json) {
  const total = field(field(params, "tokenUsage"), "total") as Json | undefined;
  return {
    input_tokens: field(total, "inputTokens"),
    cached_input_tokens: field(total, "cachedInputTokens"),
    output_tokens: field(total, "outputTokens"),
    reasoning_output_tokens: field(total, "reasoningOutputTokens"),
  };
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function field(value: unknown, key: string) {
  return value && typeof value === "object" ? (value as Json)[key] : undefined;
}

export function summarizeCodexThread(thread: unknown) {
  return {
    id: String(field(thread, "id") || ""),
    sessionId: String(field(thread, "sessionId") || ""),
    preview: String(field(thread, "preview") || "").trim(),
    name: stringOrNull(field(thread, "name")),
    cwd: String(field(thread, "cwd") || ""),
    status: String(field(thread, "status") || ""),
    source: field(thread, "source"),
    threadSource: field(thread, "threadSource"),
    createdAt: Number(field(thread, "createdAt") || 0),
    updatedAt: Number(field(thread, "updatedAt") || 0),
  };
}

function threadMessages(thread: unknown): AgentHistoryMessage[] {
  const messages: AgentHistoryMessage[] = [];
  arrayValue(field(thread, "turns")).forEach((turn, turnIndex) => {
    arrayValue(field(turn, "items")).forEach((item, itemIndex) => {
      const type = String(field(item, "type") || "");
      const id = String(field(item, "id") || `${turnIndex}-${itemIndex}`);
      if (type === "userMessage") {
        const text = userInputText(field(item, "content"));
        if (text) messages.push({ id, role: "user", text });
      }
      if (type === "agentMessage") {
        const text = String(field(item, "text") || "").trim();
        if (text) messages.push({ id, role: "assistant", title: "Codex", text, streamId: id });
      }
      if (type === "mcpToolCall") {
        const tool = String(field(item, "tool") || "Tool call");
        const error = field(field(item, "error"), "message");
        messages.push({ id, role: error ? "error" : "tool", title: tool, text: error ? String(error) : `${tool} ${String(field(item, "status") || "completed")}`, detail: item });
      }
      if (type === "commandExecution") {
        const command = String(field(item, "command") || "").trim();
        if (command) messages.push({ id, role: "tool", title: "Command", text: command, detail: item });
      }
      if (type === "fileChange") messages.push({ id, role: "tool", title: "File change", text: "Codex changed project files.", detail: item });
    });
  });
  return messages.filter((item) => item.text).slice(-120);
}

function userInputText(content: unknown) {
  return arrayValue(content)
    .map((item) => {
      const type = String(field(item, "type") || "");
      if (type === "text") return String(field(item, "text") || "");
      if (type === "image" || type === "localImage") return "[Image attachment]";
      if (type === "mention") return `@${String(field(item, "name") || "file")}`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

const maxAttachmentCount = 6;
const maxAttachmentBytes = 8 * 1024 * 1024;
const maxAttachmentTotalBytes = 18 * 1024 * 1024;
const documentExtensions = new Set([
  ".c", ".cfg", ".cpp", ".cs", ".csv", ".doc", ".docx", ".go", ".h", ".hpp", ".htm", ".html", ".ini", ".java", ".js", ".json", ".jsonl", ".jsx", ".log", ".md", ".markdown", ".pdf", ".php", ".ppt", ".pptx", ".ps1", ".py", ".rb", ".rs", ".rtf", ".sh", ".sql", ".toml", ".ts", ".tsv", ".tsx", ".txt", ".xls", ".xlsx", ".xml", ".yaml", ".yml",
]);

export async function prepareAttachmentFiles(attachments: AgentAttachment[]): Promise<PreparedAttachments> {
  if (attachments.length > maxAttachmentCount) throw new Error(`At most ${maxAttachmentCount} attachments can be sent at once.`);
  const prepared = emptyPreparedAttachments();
  let totalBytes = 0;
  let documentDir = "";
  try {
    for (const [index, item] of attachments.entries()) {
      const { mime, bytes } = decodeAttachment(item);
      if (bytes.length > maxAttachmentBytes) throw new Error(`${item.name || "Attachment"} exceeds the 8 MB limit.`);
      totalBytes += bytes.length;
      if (totalBytes > maxAttachmentTotalBytes) throw new Error("Attachments exceed the 18 MB combined limit.");
      if (mime.startsWith("image/") && item.kind !== "document") {
        const file = path.join(os.tmpdir(), `codex-remote-${Date.now()}-${Math.random().toString(16).slice(2)}.${imageExt(mime || item.type)}`);
        await fs.writeFile(file, bytes);
        prepared.images.push(file);
        prepared.cleanupPaths.push(file);
        continue;
      }

      const extension = documentExtension(item.name, mime || item.type);
      if (!extension) throw new Error(`${item.name || "Document"} is not a supported document type.`);
      if (!documentDir) {
        documentDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-remote-docs-"));
        prepared.cleanupPaths.push(documentDir);
      }
      const name = safeAttachmentName(item.name, extension, index);
      const file = path.join(documentDir, name);
      await fs.writeFile(file, bytes);
      prepared.documents.push({ name: item.name?.trim() || name, path: file });
    }
    return prepared;
  } catch (error) {
    await cleanupPreparedAttachments(prepared);
    throw error;
  }
}

function decodeAttachment(item: AgentAttachment) {
  const [, mime = "", data = ""] = item.dataUrl?.match(/^data:([^;,]*);base64,(.+)$/) || [];
  if (!data) throw new Error(`Invalid attachment: ${item.name || "unnamed file"}`);
  return { mime: mime.toLowerCase(), bytes: Buffer.from(data, "base64") };
}

function documentExtension(name = "", type = "") {
  const extension = path.extname(path.basename(name)).toLowerCase();
  if (documentExtensions.has(extension)) return extension;
  const mime = type.toLowerCase();
  if (mime === "application/pdf") return ".pdf";
  if (mime.startsWith("text/")) return ".txt";
  if (mime.includes("wordprocessingml")) return ".docx";
  if (mime.includes("spreadsheetml")) return ".xlsx";
  if (mime.includes("presentationml")) return ".pptx";
  return "";
}

function safeAttachmentName(name: string | undefined, extension: string, index: number) {
  const basename = path.basename(name || `document${extension}`);
  const stem = basename.slice(0, Math.max(0, basename.length - path.extname(basename).length));
  const safeStem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "document";
  return `${index + 1}-${safeStem}${extension}`;
}

function emptyPreparedAttachments(): PreparedAttachments {
  return { images: [], documents: [], cleanupPaths: [] };
}

export async function cleanupPreparedAttachments(prepared: PreparedAttachments) {
  await Promise.all(prepared.cleanupPaths.map((file) => fs.rm(file, { recursive: true, force: true }).catch(() => undefined)));
}

function deferAttachmentCleanup(prepared: PreparedAttachments) {
  const timer = setTimeout(() => void cleanupPreparedAttachments(prepared), 60 * 60 * 1000);
  timer.unref();
}

function imageExt(type = "") {
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  return "jpg";
}

function codexBin() {
  return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
