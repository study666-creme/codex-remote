import {
  Archive,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Code2,
  Eye,
  EyeOff,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Github,
  ImagePlus,
  ListPlus,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
  Wifi,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentAttachment,
  BridgeConfigResponse,
  CodexAgentEvent,
  CodexRemoteMessage,
  CodexRemoteSettings,
  CodexThreadSummary,
  CodexWorkspace,
  CodexWorkspaceProject,
  GitRepoInfo,
} from "@codex-remote/shared";

type Tab = "chat" | "workspaces" | "git" | "settings";
type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
type UiAttachment = AgentAttachment & { id: string; size?: number };
type QueuedTask = { id: string; text: string; attachments: UiAttachment[] };

const STORAGE_KEY = "codex-remote.settings.v1";
const MESSAGE_KEY = "codex-remote.messages.v1";
const QUEUE_KEY = "codex-remote.queue.v1";
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") || "";
const ENV_AGENT_URL = String(import.meta.env.VITE_CODEX_REMOTE_DEFAULT_AGENT_URL || "").trim();
const ENV_TOKEN = String(import.meta.env.VITE_CODEX_REMOTE_DEFAULT_TOKEN || "").trim();
const SOURCE_URL = String(import.meta.env.VITE_CODEX_REMOTE_SOURCE_URL || "https://github.com/study666-creme/codex-remote").trim();

const DEFAULT_SETTINGS: CodexRemoteSettings = {
  agentUrl: ENV_AGENT_URL,
  token: ENV_TOKEN,
  workspaceId: "default",
  workspacePath: "",
  threadId: "",
  gitRepoPath: "",
  model: "",
  effort: "high",
  receiveMode: "full",
};

const DEMO_MESSAGES: CodexRemoteMessage[] = [
  { id: "m1", role: "user", text: "检查移动端登录状态，并修复小屏幕下按钮重叠。" },
  { id: "m2", role: "tool", title: "读取文件", text: "src/pages/login.tsx · src/styles/mobile.css" },
  { id: "m3", role: "assistant", title: "Codex", text: "已定位到操作区使用固定宽度。我把它改成两列自适应布局，并补了 390px 视口测试。现在正在运行构建检查。", streamId: "demo-stream" },
  { id: "m4", role: "status", title: "运行中", text: "npm run build" },
];

const DEMO_PROJECTS: CodexWorkspaceProject[] = [
  { id: "storefront", label: "storefront", workspaceId: "storefront", workspacePath: "D:\\projects\\storefront", threadId: "thread-a", threadCount: 7, updatedAt: Date.now(), source: "saved" },
  { id: "api-service", label: "api-service", workspaceId: "api-service", workspacePath: "D:\\projects\\api-service", threadId: "thread-b", threadCount: 4, updatedAt: Date.now() - 36e5, source: "discovered" },
  { id: "design-system", label: "design-system", workspaceId: "design-system", workspacePath: "D:\\projects\\design-system", threadId: "thread-c", threadCount: 2, updatedAt: Date.now() - 72e5, source: "saved" },
];

const DEMO_THREADS: CodexThreadSummary[] = [
  { id: "thread-a", name: "修复移动端登录布局", preview: "检查移动端登录状态，并修复小屏幕下按钮重叠", cwd: "D:\\projects\\storefront", status: "running", updatedAt: Date.now() },
  { id: "thread-a2", name: "商品列表性能", preview: "定位首屏渲染慢的问题", cwd: "D:\\projects\\storefront", status: "completed", updatedAt: Date.now() - 86_400_000 },
  { id: "thread-a3", name: "支付回调测试", preview: "补充 webhook 幂等性测试", cwd: "D:\\projects\\storefront", status: "completed", updatedAt: Date.now() - 172_800_000 },
];

const DEMO_REPOS: GitRepoInfo[] = [
  {
    repoPath: "D:\\projects\\storefront",
    branch: "codex/mobile-login",
    defaultRemote: "origin",
    defaultBranch: "codex/mobile-login",
    remotes: [{ name: "origin", url: "git@github.com:you/storefront.git" }],
    dirty: true,
    statusShort: ["M src/pages/login.tsx", "M src/styles/mobile.css", "A tests/mobile-login.spec.ts"],
    warnings: ["有未提交改动；手机推送只会推送已经提交的 HEAD。"],
    pushBlocked: false,
  },
];

export default function App() {
  const initialTab = (["chat", "workspaces", "git", "settings"].includes(DEMO_MODE) ? DEMO_MODE : DEMO_MODE === "attachments" ? "chat" : "chat") as Tab;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState<CodexRemoteSettings>(() => ({ ...DEFAULT_SETTINGS, ...readStored<CodexRemoteSettings>(STORAGE_KEY), ...(DEMO_MODE ? { agentUrl: "https://agent.example.com", token: "demo-token", workspaceId: "storefront", workspacePath: "D:\\projects\\storefront", threadId: "thread-a", gitRepoPath: "D:\\projects\\storefront" } : {}) }));
  const [connection, setConnection] = useState<ConnectionState>(DEMO_MODE ? "connected" : "disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [bridgeConfig, setBridgeConfig] = useState<BridgeConfigResponse | null>(DEMO_MODE ? { ok: true, url: "https://agent.example.com", listenHost: "127.0.0.1", lanUrls: [], hasToken: true, fixedPublicUrl: true, version: "0.1.0" } : null);
  const [messages, setMessages] = useState<CodexRemoteMessage[]>(() => DEMO_MODE ? DEMO_MESSAGES : readStored<CodexRemoteMessage[]>(MESSAGE_KEY) || []);
  const [projects, setProjects] = useState<CodexWorkspaceProject[]>(DEMO_MODE ? DEMO_PROJECTS : []);
  const [threads, setThreads] = useState<CodexThreadSummary[]>(DEMO_MODE ? DEMO_THREADS : []);
  const [repos, setRepos] = useState<GitRepoInfo[]>(DEMO_MODE ? DEMO_REPOS : []);
  const [prompt, setPrompt] = useState(DEMO_MODE === "attachments" ? "根据这两张截图修复移动端间距，并补回归测试。" : "");
  const [attachments, setAttachments] = useState<UiAttachment[]>(DEMO_MODE === "attachments" ? [
    { id: "a1", name: "login-390.png", type: "image/png", size: 184_320 },
    { id: "a2", name: "expected.png", type: "image/png", size: 121_400 },
  ] : []);
  const [queue, setQueue] = useState<QueuedTask[]>(() => DEMO_MODE === "attachments" ? [
    { id: "q1", text: "构建通过后再检查暗色模式。", attachments: [] },
    { id: "q2", text: "最后整理提交说明。", attachments: [] },
  ] : readStored<QueuedTask[]>(QUEUE_KEY) || []);
  const [busy, setBusy] = useState(DEMO_MODE === "chat");
  const [showToken, setShowToken] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [toast, setToast] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef(settings);

  const activeProject = useMemo(() => projects.find((item) => item.workspaceId === settings.workspaceId), [projects, settings.workspaceId]);
  const activeRepo = useMemo(() => repos.find((item) => item.repoPath === settings.gitRepoPath) || repos[0], [repos, settings.gitRepoPath]);

  useEffect(() => {
    settingsRef.current = settings;
    writeStored(STORAGE_KEY, settings);
  }, [settings]);
  useEffect(() => writeStored(MESSAGE_KEY, messages.slice(-160)), [messages]);
  useEffect(() => writeStored(QUEUE_KEY, queue), [queue]);
  useEffect(() => messageEndRef.current?.scrollIntoView({ block: "end" }), [messages, busy]);
  useEffect(() => () => eventSourceRef.current?.close(), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function connect() {
    if (DEMO_MODE) {
      setConnection("connected");
      setToast("已连接固定地址");
      return;
    }
    setConnection("connecting");
    setConnectionError("");
    try {
      let agentUrl = validateAgentUrl(settings.agentUrl);
      const config = await requestJson<BridgeConfigResponse>(agentUrl, "", "/config");
      if (config.url && config.fixedPublicUrl) agentUrl = validateAgentUrl(config.url);
      const nextSettings = { ...settings, agentUrl };
      setSettings(nextSettings);
      const workspaceQuery = `?workspaceId=${encodeURIComponent(nextSettings.workspaceId || "default")}`;
      const workspaceRequest = nextSettings.workspacePath
        ? requestJson<{ workspace: CodexWorkspace }>(agentUrl, nextSettings.token, "/agent/codex/workspace", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: nextSettings.workspaceId || "default",
              workspacePath: nextSettings.workspacePath,
              model: nextSettings.model,
              effort: nextSettings.effort,
            }),
          })
        : requestJson<{ workspace: CodexWorkspace }>(agentUrl, nextSettings.token, `/agent/codex/workspace${workspaceQuery}`);
      const [workspaceData, projectData, repoData] = await Promise.all([
        workspaceRequest,
        requestJson<{ projects: CodexWorkspaceProject[] }>(agentUrl, nextSettings.token, "/agent/codex/workspaces"),
        requestJson<{ repos: GitRepoInfo[] }>(agentUrl, nextSettings.token, `/agent/git/repos${workspaceQuery}`),
      ]);
      const workspace = workspaceData.workspace;
      setSettings((current) => ({ ...current, agentUrl, workspacePath: workspace.workspacePath, threadId: workspace.activeThreadId || current.threadId }));
      setProjects(projectData.projects || []);
      setRepos(repoData.repos || []);
      setBridgeConfig(config);
      openEventStream(agentUrl, nextSettings.token);
      setConnection("connected");
      await refreshThreads(agentUrl, nextSettings.token, workspace.workspaceId);
    } catch (error) {
      setConnection("error");
      setConnectionError(errorMessage(error));
    }
  }

  function disconnect() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setConnection("disconnected");
    setBusy(false);
  }

  function openEventStream(agentUrl: string, token: string) {
    eventSourceRef.current?.close();
    const url = `${agentUrl}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId())}`;
    const source = new EventSource(url);
    eventSourceRef.current = source;
    source.addEventListener("hello", () => setConnection("connected"));
    source.addEventListener("agent_event", (event) => handleAgentEvent(parseEvent(event) as CodexAgentEvent));
    source.addEventListener("agent_error", (event) => {
      const value = parseEvent(event) as { message?: string };
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "error", title: "Codex 错误", text: value.message || "Codex 运行失败" }]);
      setBusy(false);
    });
    source.addEventListener("agent_done", () => setBusy(false));
    source.onerror = () => setConnection((current) => current === "connected" ? "error" : current);
  }

  function handleAgentEvent(event: CodexAgentEvent) {
    if (event.type === "turn.started") setBusy(true);
    if (event.type === "turn.completed") setBusy(false);
    if (event.type === "error") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "error", title: "Codex 错误", text: String(event.message || "运行失败") }]);
      return;
    }
    const item = event.item;
    if (!item) return;
    const itemId = String(item.id || crypto.randomUUID());
    const type = String(item.type || "");
    const receiveMode = settingsRef.current.receiveMode;
    if (receiveMode === "final" && event.type !== "item.completed") return;
    if (receiveMode === "text" && type !== "agent_message") return;
    if (type === "agent_message") {
      upsertMessage({ id: `assistant-${itemId}`, role: "assistant", title: "Codex", text: String(item.text || ""), streamId: itemId });
    } else if (["commandExecution", "command_execution", "mcp_tool_call", "fileChange", "file_change"].includes(type)) {
      const title = type.includes("command") ? "命令" : type.includes("file") ? "文件变更" : "工具调用";
      const text = String(item.command || item.tool || item.status || title);
      upsertMessage({ id: `tool-${itemId}`, role: "tool", title, text, detail: item });
    }
  }

  function upsertMessage(message: CodexRemoteMessage) {
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return [...current, message];
      const next = [...current];
      next[index] = { ...next[index], ...message };
      return next;
    });
  }

  async function submitPrompt(text = prompt, files = attachments) {
    const value = text.trim() || (files.length ? "请查看附件并处理。" : "");
    if (!value) return;
    if (connection !== "connected") {
      setTab("settings");
      setToast("请先连接桥接服务");
      return;
    }
    const steering = busy && Boolean(settings.threadId);
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: value }]);
    setPrompt("");
    setAttachments([]);
    setBusy(true);
    if (DEMO_MODE) {
      window.setTimeout(() => {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", title: "Codex", text: steering ? "收到，我会在当前任务中优先处理这个要求。" : "任务已收到，正在检查项目文件。" }]);
        setBusy(false);
      }, 500);
      return;
    }
    try {
      const endpoint = steering ? "/agent/codex/turn/steer" : "/agent/codex/turn";
      const result = await bridgeJson<{ threadId: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          workspaceId: settings.workspaceId,
          threadId: settings.threadId,
          prompt: value,
          attachments: files.map(({ name, type, dataUrl }) => ({ name, type, dataUrl })),
          model: settings.model,
          effort: settings.effort,
        }),
      });
      if (result.threadId) setSettings((current) => ({ ...current, threadId: result.threadId }));
    } catch (error) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "error", title: "发送失败", text: errorMessage(error) }]);
      setBusy(false);
    }
  }

  function queuePrompt() {
    const text = prompt.trim() || (attachments.length ? "请查看附件并处理。" : "");
    if (!text) return;
    setQueue((current) => [...current, { id: crypto.randomUUID(), text, attachments }]);
    setPrompt("");
    setAttachments([]);
    setToast("已加入任务队列");
  }

  async function runNextQueuedTask() {
    const [next, ...rest] = queue;
    if (!next || busy) return;
    setQueue(rest);
    await submitPrompt(next.text, next.attachments);
  }

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const oversized = images.filter((file) => file.size > 6 * 1024 * 1024);
    if (oversized.length) setToast("单张图片不能超过 6 MB");
    const selected = images.filter((file) => file.size <= 6 * 1024 * 1024).slice(0, Math.max(0, 4 - attachments.length));
    const next = await Promise.all(selected.map(async (file) => ({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, dataUrl: await readDataUrl(file) })));
    setAttachments((current) => [...current, ...next].slice(0, 4));
  }

  async function refreshThreads(agentUrl = settings.agentUrl, token = settings.token, workspaceId = settings.workspaceId) {
    if (DEMO_MODE) return;
    const result = await requestJson<{ data: CodexThreadSummary[] }>(agentUrl, token, `/agent/codex/threads?workspaceId=${encodeURIComponent(workspaceId)}`);
    setThreads(result.data || []);
  }

  async function selectProject(project: CodexWorkspaceProject) {
    setWorkspaceBusy(true);
    setSettings((current) => ({ ...current, workspaceId: project.workspaceId, workspacePath: project.workspacePath, threadId: project.threadId || "" }));
    if (DEMO_MODE) {
      setWorkspaceBusy(false);
      setToast(`已切换到 ${project.label}`);
      return;
    }
    try {
      await bridgeJson("/agent/codex/workspace", { method: "POST", body: JSON.stringify({ workspaceId: project.workspaceId, workspacePath: project.workspacePath }) });
      await refreshThreads(settings.agentUrl, settings.token, project.workspaceId);
      const repoData = await requestJson<{ repos: GitRepoInfo[] }>(settings.agentUrl, settings.token, `/agent/git/repos?workspaceId=${encodeURIComponent(project.workspaceId)}`);
      setRepos(repoData.repos || []);
    } catch (error) {
      setToast(errorMessage(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function resumeThread(thread: CodexThreadSummary) {
    setWorkspaceBusy(true);
    try {
      if (DEMO_MODE) {
        setSettings((current) => ({ ...current, threadId: thread.id }));
        setMessages(DEMO_MESSAGES);
      } else {
        const result = await bridgeJson<{ messages: CodexRemoteMessage[] }>(`/agent/codex/threads/${encodeURIComponent(thread.id)}/resume`, {
          method: "POST",
          body: JSON.stringify({ workspaceId: settings.workspaceId, model: settings.model, effort: settings.effort }),
        });
        setSettings((current) => ({ ...current, threadId: thread.id }));
        setMessages(result.messages || []);
      }
      setTab("chat");
    } catch (error) {
      setToast(errorMessage(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function newThread() {
    setWorkspaceBusy(true);
    try {
      if (DEMO_MODE) {
        setSettings((current) => ({ ...current, threadId: "thread-new" }));
      } else {
        const result = await bridgeJson<{ thread: CodexThreadSummary }>("/agent/codex/threads/new", {
          method: "POST",
          body: JSON.stringify({ workspaceId: settings.workspaceId, model: settings.model, effort: settings.effort }),
        });
        setSettings((current) => ({ ...current, threadId: result.thread.id }));
      }
      setMessages([]);
      setTab("chat");
    } catch (error) {
      setToast(errorMessage(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function deleteThread(thread: CodexThreadSummary) {
    if (!window.confirm(`归档会话“${thread.name || thread.preview || thread.id}”？`)) return;
    if (!DEMO_MODE) await bridgeJson(`/agent/codex/threads/${encodeURIComponent(thread.id)}/delete`, { method: "POST", body: JSON.stringify({ workspaceId: settings.workspaceId }) });
    setThreads((current) => current.filter((item) => item.id !== thread.id));
    if (settings.threadId === thread.id) setSettings((current) => ({ ...current, threadId: "" }));
  }

  async function pushRepo() {
    if (!activeRepo || activeRepo.pushBlocked) return;
    if (!window.confirm(`把当前 HEAD 推送到 ${activeRepo.defaultRemote}/${activeRepo.defaultBranch}？`)) return;
    setGitBusy(true);
    try {
      if (!DEMO_MODE) {
        await bridgeJson("/agent/git/push", {
          method: "POST",
          body: JSON.stringify({ workspaceId: settings.workspaceId, repoPath: activeRepo.repoPath, remote: activeRepo.defaultRemote, branch: activeRepo.defaultBranch }),
        });
      }
      setToast("推送完成");
    } catch (error) {
      setToast(errorMessage(error));
    } finally {
      setGitBusy(false);
    }
  }

  async function bridgeJson<T>(path: string, init?: RequestInit) {
    return requestJson<T>(validateAgentUrl(settings.agentUrl), settings.token, path, init);
  }

  const connectionLabel = connection === "connected" ? "已连接" : connection === "connecting" ? "连接中" : connection === "error" ? "连接异常" : "未连接";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><Code2 size={18} strokeWidth={2.2} /></div>
        <div className="brand-copy">
          <strong>Codex Remote</strong>
          <span>{activeProject?.label || settings.workspaceId || "default"}</span>
        </div>
        {busy && <div className="run-indicator"><span />运行中</div>}
        <button className={`connection-pill ${connection}`} onClick={() => setTab("settings")} title="连接状态">
          {connection === "connected" ? <Wifi size={14} /> : <Unplug size={14} />}
          <span>{connectionLabel}</span>
        </button>
      </header>

      <main className="content">
        {tab === "chat" && (
          <section className="chat-view">
            <div className="chat-context">
              <button className="context-button" onClick={() => setTab("workspaces")}>
                <FolderOpen size={16} />
                <span>{activeProject?.label || pathName(settings.workspacePath) || "选择项目"}</span>
                <ChevronRight size={15} />
              </button>
              <button className="icon-button" onClick={newThread} title="新建会话"><Plus size={18} /></button>
            </div>

            <div className="messages" aria-live="polite">
              {!messages.length && (
                <div className="empty-state">
                  <div className="empty-icon"><Bot size={28} /></div>
                  <strong>新的 Codex 会话</strong>
                  <span>{settings.workspacePath || "连接后选择本地项目"}</span>
                </div>
              )}
              {messages.map((message) => <MessageRow key={message.id} message={message} />)}
              {busy && (
                <div className="typing-row">
                  <LoaderCircle className="spin" size={16} />
                  <span>Codex 正在处理</span>
                  <MoreHorizontal size={18} />
                </div>
              )}
              <div ref={messageEndRef} />
            </div>

            {queue.length > 0 && (
              <div className="queue-strip">
                <div><ListPlus size={16} /><span>队列 {queue.length}</span></div>
                <span className="queue-preview">{queue[0].text}</span>
                <button className="icon-button small" onClick={runNextQueuedTask} disabled={busy} title="运行下一项"><Play size={15} /></button>
              </div>
            )}

            <div className="composer-wrap">
              {attachments.length > 0 && (
                <div className="attachment-list">
                  {attachments.map((item) => (
                    <div className="attachment-chip" key={item.id}>
                      {item.dataUrl ? <img src={item.dataUrl} alt="" /> : <div className="attachment-placeholder"><ImagePlus size={18} /></div>}
                      <div><strong>{item.name}</strong><span>{formatBytes(item.size)}</span></div>
                      <button onClick={() => setAttachments((current) => current.filter((attachment) => attachment.id !== item.id))} title="移除附件"><X size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="composer">
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={busy ? "引导正在运行的任务…" : "给 Codex 安排任务…"} rows={1} />
                <div className="composer-actions">
                  <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => void handleFiles(event.target.files)} />
                  <button className="icon-button" onClick={() => fileInputRef.current?.click()} title="添加图片"><ImagePlus size={19} /></button>
                  <button className="icon-button" onClick={queuePrompt} title="加入队列"><ListPlus size={19} /></button>
                  <button className={`send-button ${busy ? "steer" : ""}`} onClick={() => void submitPrompt()} disabled={!prompt.trim() && !attachments.length} title={busy ? "引导任务" : "发送任务"}>
                    {busy ? <ArrowUp size={18} /> : <Send size={18} />}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {tab === "workspaces" && (
          <section className="page-view">
            <PageTitle icon={<FolderOpen size={20} />} title="项目与会话" action={<button className="primary-button compact" onClick={newThread}><Plus size={16} />新会话</button>} />
            <div className="section-label"><span>本地项目</span><button className="icon-button small" onClick={() => connection === "connected" && connect()} title="刷新"><RefreshCw size={15} /></button></div>
            <div className="project-grid">
              {projects.map((project) => (
                <button key={project.id} className={`project-row ${project.workspaceId === settings.workspaceId ? "active" : ""}`} onClick={() => void selectProject(project)}>
                  <span className="project-icon"><FolderGit2 size={18} /></span>
                  <span className="project-main"><strong>{project.label}</strong><small>{project.workspacePath}</small></span>
                  <span className="count-badge">{project.threadCount}</span>
                  {project.workspaceId === settings.workspaceId ? <Check size={17} /> : <ChevronRight size={17} />}
                </button>
              ))}
            </div>
            <div className="section-label"><span>最近会话</span><span>{threads.length}</span></div>
            <div className="thread-list">
              {threads.map((thread) => (
                <div className="thread-row" key={thread.id}>
                  <button className="thread-open" onClick={() => void resumeThread(thread)}>
                    <span className={`thread-state ${thread.status || "completed"}`} />
                    <span><strong>{thread.name || thread.preview || "未命名会话"}</strong><small>{thread.preview || thread.id}</small><em>{relativeTime(thread.updatedAt)}</em></span>
                  </button>
                  <button className="icon-button small danger" onClick={() => void deleteThread(thread)} title="归档会话"><Archive size={15} /></button>
                </div>
              ))}
            </div>
            {workspaceBusy && <div className="loading-overlay"><LoaderCircle className="spin" size={22} /></div>}
          </section>
        )}

        {tab === "git" && (
          <section className="page-view">
            <PageTitle icon={<GitBranch size={20} />} title="Git 推送" action={<button className="icon-button" onClick={() => connection === "connected" && connect()} title="刷新仓库"><RefreshCw size={17} /></button>} />
            <div className="repo-selector">
              <label>仓库</label>
              <select value={activeRepo?.repoPath || ""} onChange={(event) => setSettings((current) => ({ ...current, gitRepoPath: event.target.value }))}>
                {repos.map((repo) => <option value={repo.repoPath} key={repo.repoPath}>{pathName(repo.repoPath)}</option>)}
              </select>
            </div>
            {activeRepo ? (
              <>
                <div className="repo-header">
                  <div className="repo-avatar"><FolderGit2 size={23} /></div>
                  <div><strong>{pathName(activeRepo.repoPath)}</strong><span>{activeRepo.repoPath}</span></div>
                </div>
                <div className="git-facts">
                  <div><span>当前分支</span><strong><GitBranch size={15} />{activeRepo.branch}</strong></div>
                  <div><span>推送目标</span><strong>{activeRepo.defaultRemote}/{activeRepo.defaultBranch}</strong></div>
                  <div><span>工作区</span><strong className={activeRepo.dirty ? "warning-text" : "success-text"}>{activeRepo.dirty ? `${activeRepo.statusShort.length} 项未提交` : "干净"}</strong></div>
                </div>
                {activeRepo.warnings.map((warning) => <div className="warning-banner" key={warning}><CircleAlert size={17} /><span>{warning}</span></div>)}
                <div className="section-label"><span>变更</span><span>{activeRepo.statusShort.length}</span></div>
                <div className="change-list">
                  {activeRepo.statusShort.map((line) => <div key={line}><code>{line.slice(0, 2)}</code><span>{line.slice(2).trim()}</span></div>)}
                  {!activeRepo.statusShort.length && <div className="empty-line">没有未提交改动</div>}
                </div>
                <button className="primary-button full" onClick={() => void pushRepo()} disabled={gitBusy || activeRepo.pushBlocked}>
                  {gitBusy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={17} />}
                  推送当前 HEAD
                </button>
              </>
            ) : <div className="empty-state compact"><FolderGit2 size={26} /><strong>未发现 Git 仓库</strong></div>}
          </section>
        )}

        {tab === "settings" && (
          <section className="page-view settings-view">
            <PageTitle icon={<Settings size={20} />} title="连接设置" />
            <div className={`connection-banner ${connection}`}>
              <span className="connection-icon">{connection === "connected" ? <ShieldCheck size={21} /> : <Server size={21} />}</span>
              <div><strong>{connectionLabel}</strong><span>{bridgeConfig?.fixedPublicUrl ? "固定 Agent URL" : "Codex Remote Bridge"}</span></div>
              {connection === "connected" && <Check size={20} />}
            </div>
            {connectionError && <div className="error-banner"><CircleAlert size={17} /><span>{connectionError}</span></div>}
            <div className="form-section">
              <div className="section-heading"><LockKeyhole size={16} /><span>桥接服务</span>{bridgeConfig?.fixedPublicUrl && <em>固定</em>}</div>
              <label className="field"><span>Agent URL</span><div className="field-input"><Server size={16} /><input value={settings.agentUrl} onChange={(event) => setSettings((current) => ({ ...current, agentUrl: event.target.value }))} placeholder="https://agent.example.com" inputMode="url" /></div></label>
              <label className="field"><span>连接令牌</span><div className="field-input"><LockKeyhole size={16} /><input value={settings.token} onChange={(event) => setSettings((current) => ({ ...current, token: event.target.value }))} type={showToken ? "text" : "password"} placeholder="bridge token" /><button onClick={() => setShowToken((value) => !value)} title={showToken ? "隐藏令牌" : "显示令牌"}>{showToken ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            </div>
            <div className="form-section">
              <div className="section-heading"><FolderOpen size={16} /><span>工作区</span></div>
              <label className="field"><span>项目路径</span><div className="field-input"><FolderOpen size={16} /><input value={settings.workspacePath} onChange={(event) => setSettings((current) => ({ ...current, workspacePath: event.target.value }))} placeholder="D:\projects\app" /></div></label>
              <label className="field"><span>工作区 ID</span><div className="field-input"><Code2 size={16} /><input value={settings.workspaceId} onChange={(event) => setSettings((current) => ({ ...current, workspaceId: event.target.value }))} placeholder="default" /></div></label>
            </div>
            <div className="form-section">
              <div className="section-heading"><Bot size={16} /><span>Codex</span></div>
              <div className="field-grid">
                <label className="field"><span>模型</span><input className="plain-input" value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} placeholder="默认" /></label>
                <label className="field"><span>推理强度</span><select className="plain-input" value={settings.effort} onChange={(event) => setSettings((current) => ({ ...current, effort: event.target.value }))}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option></select></label>
              </div>
              <label className="field"><span>事件显示</span><div className="segmented">{(["full", "text", "final"] as const).map((mode) => <button key={mode} className={settings.receiveMode === mode ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, receiveMode: mode }))}>{mode === "full" ? "完整" : mode === "text" ? "文本" : "最终"}</button>)}</div></label>
            </div>
            <div className="settings-actions">
              {connection === "connected" ? <button className="secondary-button" onClick={disconnect}><CircleStop size={17} />断开</button> : null}
              <button className="primary-button" onClick={() => void connect()} disabled={connection === "connecting"}>{connection === "connecting" ? <LoaderCircle className="spin" size={17} /> : <Wifi size={17} />}{connection === "connected" ? "重新连接" : "连接"}</button>
            </div>
            <div className="security-row"><ShieldCheck size={16} /><span>令牌仅保存在此设备的浏览器中</span>{SOURCE_URL && <a href={SOURCE_URL} target="_blank" rel="noreferrer"><Github size={14} />源代码与许可</a>}</div>
          </section>
        )}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <NavButton active={tab === "chat"} icon={<MessageSquareText size={20} />} label="对话" onClick={() => setTab("chat")} />
        <NavButton active={tab === "workspaces"} icon={<FolderOpen size={20} />} label="项目" onClick={() => setTab("workspaces")} />
        <NavButton active={tab === "git"} icon={<GitBranch size={20} />} label="Git" onClick={() => setTab("git")} />
        <NavButton active={tab === "settings"} icon={<Menu size={20} />} label="设置" onClick={() => setTab("settings")} />
      </nav>
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
    </div>
  );
}

function MessageRow({ message }: { message: CodexRemoteMessage }) {
  if (message.role === "user") return <div className="message user-message"><p>{message.text}</p></div>;
  if (message.role === "tool" || message.role === "status") return <div className="tool-message"><span className="tool-icon">{message.role === "status" ? <LoaderCircle className="spin" size={14} /> : <Code2 size={14} />}</span><div><strong>{message.title || "工具"}</strong><p>{message.text}</p></div></div>;
  if (message.role === "error") return <div className="message error-message"><strong>{message.title || "错误"}</strong><p>{message.text}</p></div>;
  return <div className="assistant-message"><div className="assistant-label"><Bot size={15} /><strong>{message.title || "Codex"}</strong></div><p>{message.text}</p></div>;
}

function PageTitle({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return <div className="page-title"><span>{icon}</span><h1>{title}</h1>{action && <div className="page-action">{action}</div>}</div>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

async function requestJson<T>(agentUrl: string, token: string, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${agentUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "x-codex-remote-token": token } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `Bridge request failed (${response.status})`);
  return body;
}

function validateAgentUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("请填写 Agent URL");
  const url = new URL(normalized);
  if (["/codex-remote", "/mobile-agent", "/canvas"].some((part) => url.pathname.includes(part))) throw new Error("Agent URL 应填写桥接服务域名，不是网页地址");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("非本机 Agent URL 必须使用 HTTPS");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Agent URL 不能包含路径、查询参数或锚点");
  return normalized;
}

function readStored<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The live in-memory state remains usable when browser storage is full or disabled.
  }
}

function parseEvent(event: Event) {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as unknown;
  } catch {
    return {};
  }
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function clientId() {
  const key = "codex-remote.client-id";
  const current = localStorage.getItem(key);
  if (current) return current;
  const value = crypto.randomUUID();
  localStorage.setItem(key, value);
  return value;
}

function pathName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function formatBytes(value = 0) {
  if (!value) return "图片";
  return value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
}

function relativeTime(value = 0) {
  if (!value) return "";
  const diff = Math.max(0, Date.now() - value);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
