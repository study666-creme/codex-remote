"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Clock3, Copy, FileText, FileUp, FolderGit2, GitBranch, ImagePlus, ListTodo, LoaderCircle, Menu, Pencil, PlugZap, Plus, RefreshCcw, RotateCcw, SendHorizontal, Settings2, Square, TerminalSquare, Trash2, UploadCloud, X } from "lucide-react";

type MessageRole = "user" | "assistant" | "tool" | "error" | "status";
type MobileMessage = { id: string; role: MessageRole; title?: string; text: string; streamId?: string };
type ReceiveMode = "full" | "text" | "final";
type Settings = { agentUrl: string; token: string; canvasId: string; threadId: string; workspacePath: string; gitRepoPath: string; model: string; effort: string; receiveMode: ReceiveMode };
type Workspace = { canvasId: string; workspaceId?: string; workspacePath: string; activeThreadId?: string; model?: string; effort?: string };
type AgentEvent = { type?: string; item?: Record<string, unknown>; usage?: unknown; message?: string; thread_id?: string; turn_id?: string; will_retry?: boolean };
type PendingRun = { threadId: string; canvasId: string; prompt: string; startedAt: number };
type ConnectionStatus = "idle" | "connecting" | "connected" | "offline" | "error";
type GitRemoteInfo = { name: string; url: string };
type GitRepoInfo = {
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
type ThreadSummary = {
    id: string;
    preview?: string;
    name?: string | null;
    cwd?: string;
    status?: string;
    updatedAt?: number;
    createdAt?: number;
};
type AgentAttachment = { name?: string; type?: string; dataUrl?: string; kind?: "image" | "document"; size?: number };
type QueuedTaskStatus = "queued" | "running" | "done" | "failed";
type QueuedTask = { id: string; text: string; attachments: AgentAttachment[]; createdAt: number; status: QueuedTaskStatus; error?: string };
type PendingGuide = { id: string; text: string; attachments: AgentAttachment[]; createdAt: number };
type ThreadGroup = { key: string; label: string; path: string; threads: ThreadSummary[] };
type ProjectPreset = { id: string; label: string; canvasId: string; workspaceId?: string; workspacePath: string; threadId: string; gitRepoPath?: string };
type ProjectDraft = { label: string; canvasId: string; workspacePath: string; threadId: string; gitRepoPath: string };
type ThreadCatalogCache = { updatedAt: number; threads: ThreadSummary[]; projects: ProjectPreset[] };

const settingsKey = "codex-remote-mobile:settings";
const messagesKey = "codex-remote-mobile:messages";
const threadMessagesKey = "codex-remote-mobile:thread-messages";
const pendingRunKey = "codex-remote-mobile:pending-run";
const runningThreadsKey = "codex-remote-mobile:running-threads";
const queueKey = "codex-remote-mobile:task-queue";
const pendingGuideKey = "codex-remote-mobile:pending-guide";
const activeProjectKey = "codex-remote-mobile:active-project";
const projectsKey = "codex-remote-mobile:projects";
const threadCatalogKey = "codex-remote-mobile:thread-catalog";
const dailyUsageKey = "codex-remote-mobile:daily-usage";
const quotaUnlockKey = "codex-remote-mobile:quota-unlocked";
const demoNoticeKey = "codex-remote-mobile:demo-notice-dismissed";
const codexRemoteDemoMode = false;
const codexRemoteDailyTurnLimit = 10;
const defaultAgentUrl = String(import.meta.env.VITE_CODEX_REMOTE_DEFAULT_AGENT_URL || "").trim();
const pendingRunMaxAge = 1000 * 60 * 60 * 12;
const threadCatalogMaxAge = 1000 * 60 * 60 * 24 * 7;
const maxAttachmentCount = 6;
const maxAttachmentBytes = 8 * 1024 * 1024;
const documentAccept = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.rtf,.log,.js,.jsx,.ts,.tsx,.py,.java,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.sh,.ps1,.sql,.toml,.ini,.cfg";
const documentExtensions = new Set(documentAccept.split(","));
const projectPresets: ProjectPreset[] = [];
const defaultSettings: Settings = {
    agentUrl: defaultAgentUrl,
    token: "",
    canvasId: "default",
    threadId: "",
    workspacePath: "",
    gitRepoPath: "",
    model: "",
    effort: "",
    receiveMode: "text",
};
const emptyProjectDraft: ProjectDraft = { label: "", canvasId: "", workspacePath: "", threadId: "", gitRepoPath: "" };

function createId() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function localDayKey() {
    const date = new Date();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

function dailyUsageStorageKey(userId: string) {
    return `${dailyUsageKey}:${userId || "anonymous"}`;
}

function readDailyUsage(userId: string) {
    if (typeof localStorage === "undefined" || !userId) return 0;
    const value = readJson<{ day?: string; count?: number }>(localStorage.getItem(dailyUsageStorageKey(userId)), {});
    return value.day === localDayKey() ? Math.max(0, Number(value.count || 0)) : 0;
}

function writeDailyUsage(userId: string, count: number) {
    if (typeof localStorage === "undefined" || !userId) return;
    localStorage.setItem(dailyUsageStorageKey(userId), JSON.stringify({ day: localDayKey(), count: Math.max(0, count) }));
}

function endpoint(value: string) {
    const raw = value.trim();
    try {
        return new URL(raw).origin;
    } catch {
        return raw.replace(/\/+$/, "");
    }
}

function normalizeLocalPathForCompare(value: string) {
    return value.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

function isCanvasWebUrl(value: string) {
    const raw = value.trim();
    if (!raw) return false;
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        const currentHost = typeof window === "undefined" ? "" : window.location.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        return host === currentHost || path === "/codex-remote" || path.startsWith("/codex-remote/") || path === "/mobile-agent" || path.startsWith("/mobile-agent/") || path === "/canvas" || path.startsWith("/canvas/");
    } catch {
        return /(?:^|\/)(codex-remote|mobile-agent|canvas)(?:\/|$)/i.test(raw);
    }
}

function sanitizeSettings(value: Partial<Settings>) {
    const next = { ...defaultSettings, ...value };
    if (isCanvasWebUrl(next.agentUrl)) next.agentUrl = "";
    if (!["full", "text", "final"].includes(next.receiveMode)) next.receiveMode = "text";
    return next;
}

function agentUrlMistakeMessage(value: string) {
    const raw = value.trim();
    if (!raw) return "请先填写 Codex Remote Bridge 的 HTTPS 服务地址。";
    if (isCanvasWebUrl(raw)) return "Agent URL 填成了网页地址。这里要填电脑上 Codex Remote Bridge 暴露出来的地址，例如 Cloudflare Tunnel / Tailscale / VPS 反代地址，不是 /codex-remote 或 /mobile-agent 页面。";
    return "";
}

function validateAgentUrl(value: string) {
    const raw = value.trim();
    const mistake = agentUrlMistakeMessage(raw);
    if (mistake) throw new Error(mistake);
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("Agent URL 不是有效网址。");
    }
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new Error("手机远程连接需要 HTTPS Agent URL。局域网调试才可以用 localhost / 127.0.0.1。");
    return endpoint(raw);
}

function normalizeCanvasId(value: string) {
    const raw = value.trim();
    if (!raw) return "default";
    const match = raw.match(/(?:^|\/)canvas\/([^/?#]+)/i);
    return decodeURIComponent(match?.[1] || raw.replace(/^\/?canvas\//i, "")).trim() || "default";
}

function workspaceRequestBody(workspaceId: string, extra: Record<string, unknown> = {}) {
    return { ...extra, workspaceId, canvasId: workspaceId };
}

function codexModelSettings(settings: Settings) {
    return {
        model: settings.model.trim(),
        effort: settings.effort.trim(),
    };
}

function shouldChooseWorkspaceAfterConnect(settings: Settings) {
    return normalizeCanvasId(settings.canvasId) === "default" && !settings.workspacePath.trim() && !normalizeThreadId(settings.threadId);
}

function workspaceSearchParams(workspaceId: string, extra: Record<string, string> = {}) {
    return new URLSearchParams({ workspaceId, canvasId: workspaceId, ...extra });
}

function normalizeThreadId(value: string) {
    const raw = value.trim();
    if (!raw) return "";
    const match = raw.match(/(?:codex:\/\/threads\/|\/threads\/)([^/?#]+)/i);
    return decodeURIComponent(match?.[1] || raw).trim();
}

function withToken(base: string, path: string, token: string) {
    return `${endpoint(base)}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token.trim())}`;
}

function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : value == null ? "" : JSON.stringify(value, null, 2);
}

function messagesForReceiveMode(items: MobileMessage[], mode: ReceiveMode) {
    if (mode === "full") return items;
    const textItems = items.filter((item) => item.role === "user" || item.role === "assistant" || item.role === "error");
    if (mode === "text") return textItems;
    const finalItems: MobileMessage[] = [];
    let finalReply: MobileMessage | null = null;
    const flushReply = () => {
        if (finalReply) finalItems.push(finalReply);
        finalReply = null;
    };
    textItems.forEach((item) => {
        if (item.role === "user") {
            flushReply();
            finalItems.push(item);
            return;
        }
        finalReply = item;
    });
    flushReply();
    return finalItems;
}

function itemField(item: unknown, key: string) {
    return item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined;
}

function toolLabel(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_run_generation") return "触发生成";
    return name || "工具调用";
}

function itemStatusLabel(itemType: string, tool: string) {
    if (itemType === "commandExecution") return "正在执行命令";
    if (itemType === "fileChange") return "正在修改文件";
    if (tool) return `正在执行：${toolLabel(tool)}`;
    return "正在处理";
}

function parseEventData<T>(event: Event) {
    try {
        return JSON.parse((event as MessageEvent).data) as T;
    } catch {
        return null;
    }
}

function readPendingRun(canvasId?: string) {
    if (typeof localStorage === "undefined") return null;
    const value = readJson<PendingRun | null>(localStorage.getItem(pendingRunKey), null);
    if (!value?.threadId || !value.prompt || Date.now() - Number(value.startedAt || 0) > pendingRunMaxAge) {
        localStorage.removeItem(pendingRunKey);
        return null;
    }
    if (canvasId && value.canvasId !== canvasId) return null;
    return value;
}

function writePendingRun(run: PendingRun) {
    localStorage.setItem(pendingRunKey, JSON.stringify(run));
}

function clearPendingRun() {
    localStorage.removeItem(pendingRunKey);
}

function readRunningThreads() {
    if (typeof localStorage === "undefined") return [] as string[];
    return readJson<string[]>(localStorage.getItem(runningThreadsKey), []).filter(Boolean);
}

function writeRunningThreads(threadIds: string[]) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(runningThreadsKey, JSON.stringify([...new Set(threadIds.filter(Boolean))]));
}

function threadIsBusy(status = "") {
    return ["running", "in_progress", "active", "busy", "pending"].includes(status.toLowerCase());
}

function samePath(a: string, b: string) {
    return a.trim().replaceAll("/", "\\").toLowerCase() === b.trim().replaceAll("/", "\\").toLowerCase();
}

function normalizeProjectList(items: ProjectPreset[]): ProjectPreset[] {
    const seen = new Set<string>();
    return items
        .filter((item) => item?.id && item?.label)
        .map((item) => ({
            id: String(item.id),
            label: String(item.label),
            canvasId: normalizeCanvasId(item.workspaceId || item.canvasId || item.id),
            workspaceId: normalizeCanvasId(item.workspaceId || item.canvasId || item.id),
            workspacePath: item.workspacePath || "",
            threadId: normalizeThreadId(item.threadId || ""),
            gitRepoPath: item.gitRepoPath || "",
        }))
        .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
}

function mergeProjectLists(current: ProjectPreset[], incoming: ProjectPreset[]) {
    const next = normalizeProjectList(current);
    for (const project of normalizeProjectList(incoming)) {
        const index = next.findIndex(
            (item) =>
                item.id === project.id ||
                item.canvasId === project.canvasId ||
                (item.workspacePath && project.workspacePath && samePath(item.workspacePath, project.workspacePath)) ||
                (item.threadId && project.threadId && item.threadId === project.threadId),
        );
        if (index >= 0) {
            next[index] = {
                ...project,
                ...next[index],
                threadId: next[index].threadId || project.threadId,
                gitRepoPath: next[index].gitRepoPath || project.gitRepoPath,
            };
        } else {
            next.push(project);
        }
    }
    return normalizeProjectList(next);
}

function mergeThreadLists(current: ThreadSummary[], incoming: ThreadSummary[]) {
    const items = new Map<string, ThreadSummary>();
    [...current, ...incoming].forEach((thread) => {
        if (!thread?.id) return;
        items.set(thread.id, { ...(items.get(thread.id) || {}), ...thread });
    });
    return [...items.values()].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

function workspaceCanvasIdFromPath(workspacePath: string) {
    const name = repoName(workspacePath).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32) || "workspace";
    let hash = 0;
    for (let index = 0; index < workspacePath.length; index += 1) hash = (hash * 31 + workspacePath.charCodeAt(index)) | 0;
    return normalizeCanvasId(`${name}-${Math.abs(hash).toString(36)}`);
}

function projectFromThread(thread: ThreadSummary, projects: ProjectPreset[]): ProjectPreset | null {
    const workspacePath = thread.cwd?.trim() || "";
    if (!workspacePath) return null;
    const existing =
        projects.find((project) => project.workspacePath && samePath(project.workspacePath, workspacePath)) ||
        projects.find((project) => project.threadId && project.threadId === thread.id);
    if (existing) return { ...existing, threadId: thread.id };
    const canvasId = workspaceCanvasIdFromPath(workspacePath);
    return {
        id: canvasId,
        label: threadGroupLabel(workspacePath),
        canvasId,
        workspaceId: canvasId,
        workspacePath,
        threadId: thread.id,
        gitRepoPath: "",
    };
}

function projectCanvasIdFromDraft(draft: ProjectDraft, id: string) {
    return normalizeCanvasId(draft.canvasId || draft.threadId || id);
}

function findProjectPreset(projects: ProjectPreset[], value: Partial<Settings>, currentWorkspace?: Workspace | null) {
    const canvasId = normalizeCanvasId(value.canvasId || "");
    const threadId = normalizeThreadId(value.threadId || "");
    const workspacePath = value.workspacePath || currentWorkspace?.workspacePath || "";
    return (
        projects.find((project) => project.canvasId === canvasId) ||
        projects.find((project) => threadId && threadId === project.threadId) ||
        projects.find((project) => workspacePath && project.workspacePath && samePath(workspacePath, project.workspacePath)) ||
        null
    );
}

function messagesStorageKey(canvasId: string) {
    return `${messagesKey}:${canvasId || "default"}`;
}

function readStoredMessages(canvasId: string) {
    if (typeof localStorage === "undefined") return [];
    const scopedKey = messagesStorageKey(canvasId);
    const scoped = localStorage.getItem(scopedKey);
    if (scoped !== null) return readJson<MobileMessage[]>(scoped, []);
    return readJson<MobileMessage[]>(localStorage.getItem(messagesKey), []);
}

function repoName(repoPath: string) {
    return repoPath.split(/[\\/]/).filter(Boolean).pop() || repoPath;
}

function threadTitle(thread: ThreadSummary) {
    return thread.name || thread.preview || thread.id;
}

function queueTaskCount(items: QueuedTask[]) {
    return items.filter((item) => item.status === "queued" || item.status === "running").length;
}

function normalizeQueue(items: QueuedTask[]) {
    return items
        .filter((item) => item?.text?.trim())
        .slice(-30)
        .map((item) => ({ ...item, attachments: item.attachments || [], status: item.status === "running" ? "queued" : item.status }));
}

function isAgentRouteNotFound(message: string) {
    return /\b404\b/i.test(message) || /\bnot found\b/i.test(message);
}

function normalizePendingGuideItem(value: PendingGuide | null | undefined) {
    if (!value?.text?.trim()) return null;
    return { ...value, text: value.text.trim(), attachments: value.attachments || [] };
}

function normalizePendingGuides(value: PendingGuide | PendingGuide[] | null) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.map(normalizePendingGuideItem).filter((item): item is PendingGuide => Boolean(item)).slice(-20);
}

function threadGroupLabel(path: string) {
    if (!path) return "Current workspace";
    const name = repoName(path);
    return name === path ? path : name;
}

function formatThreadTime(value?: number) {
    if (!value) return "";
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function isNearBottom(element: HTMLElement, distance = 80) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < distance;
}

function readFileAsDataUrl(file: File, kind: "image" | "document") {
    return new Promise<AgentAttachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: String(reader.result || ""), kind, size: file.size });
        reader.onerror = () => reject(reader.error || new Error("读取附件失败"));
        reader.readAsDataURL(file);
    });
}

function threadMessagesStorageKey(threadId: string) {
    return `${threadMessagesKey}:${normalizeThreadId(threadId)}`;
}

function readStoredThreadMessages(threadId: string) {
    if (typeof localStorage === "undefined" || !normalizeThreadId(threadId)) return null;
    const stored = localStorage.getItem(threadMessagesStorageKey(threadId));
    return stored === null ? null : readJson<MobileMessage[]>(stored, []);
}

function readThreadCatalog() {
    if (typeof localStorage === "undefined") return { threads: [], projects: [] };
    const value = readJson<ThreadCatalogCache | null>(localStorage.getItem(threadCatalogKey), null);
    if (!value || Date.now() - Number(value.updatedAt || 0) > threadCatalogMaxAge) return { threads: [], projects: [] };
    return { threads: value.threads || [], projects: normalizeProjectList(value.projects || []) };
}

function writeThreadCatalog(threads: ThreadSummary[], projects: ProjectPreset[]) {
    try {
        localStorage.setItem(threadCatalogKey, JSON.stringify({ updatedAt: Date.now(), threads, projects: normalizeProjectList(projects) } satisfies ThreadCatalogCache));
    } catch {
        // Cached discovery data is optional when browser storage is full.
    }
}

function isImageAttachment(item: AgentAttachment) {
    return item.kind === "image" || (!item.kind && item.type?.startsWith("image/"));
}

function isSupportedDocument(file: File) {
    const extension = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
    return documentExtensions.has(extension) || file.type === "application/pdf" || file.type.startsWith("text/");
}

function attachmentSummary(items: AgentAttachment[]) {
    const images = items.filter(isImageAttachment).length;
    const documents = items.length - images;
    return [images ? `${images} 张图片` : "", documents ? `${documents} 个文档` : ""].filter(Boolean).join(" · ");
}

function attachmentExtension(item: AgentAttachment) {
    return item.name?.split(".").pop()?.slice(0, 5).toUpperCase() || "FILE";
}

export function CodexRemoteConsole() {
    const quotaUserId = "";
    const [settings, setSettings] = useState<Settings>(defaultSettings);
    const [messages, setMessages] = useState<MobileMessage[]>([]);
    const [input, setInput] = useState("");
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [sending, setSending] = useState(false);
    const [pushing, setPushing] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [threadsOpen, setThreadsOpen] = useState(false);
    const [requirementsOpen, setRequirementsOpen] = useState(false);
    const [projects, setProjects] = useState<ProjectPreset[]>(projectPresets);
    const [projectsLoading, setProjectsLoading] = useState(false);
    const [activeProjectId, setActiveProjectId] = useState("");
    const [expandedProjectId, setExpandedProjectId] = useState("");
    const [projectFormOpen, setProjectFormOpen] = useState(false);
    const [editingProjectId, setEditingProjectId] = useState("");
    const [projectDraft, setProjectDraft] = useState<ProjectDraft>(emptyProjectDraft);
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [activeThreadId, setActiveThreadId] = useState("");
    const [copiedId, setCopiedId] = useState("");
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
    const [connectionMessage, setConnectionMessage] = useState("");
    const [hydrated, setHydrated] = useState(false);
    const [repos, setRepos] = useState<GitRepoInfo[]>([]);
    const [reposLoading, setReposLoading] = useState(false);
    const [repoError, setRepoError] = useState("");
    const [threads, setThreads] = useState<ThreadSummary[]>([]);
    const [threadsLoading, setThreadsLoading] = useState(false);
    const [threadSearch, setThreadSearch] = useState("");
    const [threadError, setThreadError] = useState("");
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    const [attachmentsReading, setAttachmentsReading] = useState(0);
    const [queuedTasks, setQueuedTasks] = useState<QueuedTask[]>([]);
    const [pendingGuides, setPendingGuides] = useState<PendingGuide[]>([]);
    const [steeringGuideIds, setSteeringGuideIds] = useState<string[]>([]);
    const [remoteBusy, setRemoteBusy] = useState(false);
    const [runningThreadIds, setRunningThreadIds] = useState<string[]>([]);
    const [dailyUsage, setDailyUsage] = useState(0);
    const [quotaUnlocked, setQuotaUnlocked] = useState(false);
    const [unlockCode, setUnlockCode] = useState("");
    const [unlockError, setUnlockError] = useState("");
    const [demoNoticeOpen, setDemoNoticeOpen] = useState(false);
    const [runStatus, setRunStatus] = useState("");
    const [unreadCount, setUnreadCount] = useState(0);
    const [resettingModelSettings, setResettingModelSettings] = useState(false);
    const eventSourceRef = useRef<EventSource | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollingRunKeyRef = useRef("");
    const pendingPromptRef = useRef("");
    const activeQueueTaskIdRef = useRef("");
    const queuedTasksRef = useRef<QueuedTask[]>([]);
    const pendingGuidesRef = useRef<PendingGuide[]>([]);
    const steeringGuideIdsRef = useRef(new Set<string>());
    const settingsRef = useRef<Settings>(defaultSettings);
    const activeThreadIdRef = useRef("");
    const threadSyncSeqRef = useRef(0);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const messageElementsRef = useRef(new Map<string, HTMLElement>());
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const documentInputRef = useRef<HTMLInputElement>(null);
    const atBottomRef = useRef(true);
    const failedTurnKeysRef = useRef(new Map<string, string>());
    const recentUnscopedErrorRef = useRef<{ id: string; message: string; at: number } | null>(null);

    const canSend = useMemo(() => attachmentsReading === 0 && Boolean(input.trim() || attachments.length), [attachments.length, attachmentsReading, input]);
    const codexBusy = sending || remoteBusy;
    const backgroundRunningCount = runningThreadIds.filter((threadId) => threadId !== activeThreadId).length;
    const quotaEnabled = codexRemoteDemoMode && Boolean(quotaUserId) && !quotaUnlocked;
    const quotaLabel = quotaUnlocked ? "已解锁无限" : `今日 ${Math.min(dailyUsage, codexRemoteDailyTurnLimit)}/${codexRemoteDailyTurnLimit}`;
    const activeQueueCount = useMemo(() => queueTaskCount(queuedTasks), [queuedTasks]);
    const visibleQueueTasks = useMemo(() => queuedTasks.filter((task) => task.status !== "done"), [queuedTasks]);
    const requirementMessages = useMemo(() => messages.filter((message) => message.role === "user" && message.text.trim()), [messages]);
    const selectedRepo = useMemo(() => repos.find((repo) => samePath(repo.repoPath, settings.gitRepoPath)) || null, [repos, settings.gitRepoPath]);
    const detectedProject = useMemo(() => findProjectPreset(projects, settings, workspace), [projects, settings.canvasId, settings.threadId, settings.workspacePath, workspace]);
    const activeProject = useMemo(() => detectedProject || projects.find((project) => project.id === activeProjectId) || null, [activeProjectId, detectedProject, projects]);
    const groupedThreads = useMemo<ThreadGroup[]>(() => {
        const groups = new Map<string, ThreadGroup>();
        for (const thread of threads) {
            const path = thread.cwd || workspace?.workspacePath || "Current workspace";
            const key = path.trim().toLowerCase() || "current";
            const existing = groups.get(key);
            if (existing) existing.threads.push(thread);
            else groups.set(key, { key, label: threadGroupLabel(path), path, threads: [thread] });
        }
        return [...groups.values()];
    }, [threads, workspace?.workspacePath]);

    useEffect(() => {
        const loadedSettings = sanitizeSettings(readJson<Partial<Settings>>(localStorage.getItem(settingsKey), {}));
        const storedProjects = localStorage.getItem(projectsKey);
        const cachedCatalog = readThreadCatalog();
        setRunningThreadIds(readRunningThreads());
        const savedProjects = storedProjects === null ? projectPresets : normalizeProjectList(readJson<ProjectPreset[]>(storedProjects, []));
        const initialProjects = mergeProjectLists(savedProjects, cachedCatalog.projects);
        const savedProjectId = localStorage.getItem(activeProjectKey) || "";
        const matchedProject = findProjectPreset(initialProjects, loadedSettings);
        const savedProject = initialProjects.find((project) => project.id === savedProjectId) || null;
        const initialProject = matchedProject || savedProject;
        const initialSettings = initialProject && !matchedProject
            ? sanitizeSettings({
                  ...loadedSettings,
                  canvasId: initialProject.canvasId,
                  workspacePath: initialProject.workspacePath,
                  threadId: initialProject.threadId,
                  gitRepoPath: initialProject.gitRepoPath || loadedSettings.gitRepoPath,
              })
            : loadedSettings;
        settingsRef.current = initialSettings;
        setSettings(initialSettings);
        setProjects(initialProjects);
        setThreads(cachedCatalog.threads);
        setActiveProjectId(initialProject?.id || "");
        setMessages(readStoredThreadMessages(initialSettings.threadId) || readStoredMessages(normalizeCanvasId(initialSettings.canvasId)));
        setQueuedTasks(normalizeQueue(readJson<QueuedTask[]>(localStorage.getItem(queueKey), [])));
        setPendingGuides(normalizePendingGuides(readJson<PendingGuide | PendingGuide[] | null>(localStorage.getItem(pendingGuideKey), null)));
        setQuotaUnlocked(codexRemoteDemoMode && localStorage.getItem(quotaUnlockKey) === "1");
        setHydrated(true);
        return () => {
            eventSourceRef.current?.close();
            stopThreadPoll();
            if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        };
    }, []);

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    useEffect(() => {
        if (!hydrated) return;
        if (!codexRemoteDemoMode || !quotaUserId) {
            setDailyUsage(0);
            return;
        }
        setDailyUsage(readDailyUsage(quotaUserId));
        setQuotaUnlocked(localStorage.getItem(quotaUnlockKey) === "1");
        if (localStorage.getItem(demoNoticeKey) !== "1") setDemoNoticeOpen(true);
    }, [hydrated, quotaUserId]);

    useEffect(() => {
        activeThreadIdRef.current = activeThreadId;
    }, [activeThreadId]);

    useEffect(() => {
        queuedTasksRef.current = queuedTasks;
        if (hydrated) localStorage.setItem(queueKey, JSON.stringify(queuedTasks));
    }, [hydrated, queuedTasks]);

    useEffect(() => {
        pendingGuidesRef.current = pendingGuides;
        if (!hydrated) return;
        if (pendingGuides.length) localStorage.setItem(pendingGuideKey, JSON.stringify(pendingGuides));
        else localStorage.removeItem(pendingGuideKey);
    }, [hydrated, pendingGuides]);

    useEffect(() => {
        if (hydrated) localStorage.setItem(settingsKey, JSON.stringify(settings));
    }, [hydrated, settings]);

    useEffect(() => {
        if (!hydrated) return;
        setMessages((items) => messagesForReceiveMode(items, settings.receiveMode));
    }, [hydrated, settings.receiveMode]);

    useEffect(() => {
        if (hydrated) localStorage.setItem(activeProjectKey, activeProjectId);
    }, [activeProjectId, hydrated]);

    useEffect(() => {
        if (hydrated) localStorage.setItem(projectsKey, JSON.stringify(projects));
    }, [hydrated, projects]);

    useEffect(() => {
        if (!threadsOpen) return;
        setExpandedProjectId((value) => value || activeProject?.id || projects[0]?.id || "");
    }, [activeProject?.id, projects, threadsOpen]);

    useEffect(() => {
        if (!hydrated) return;
        const matchedProject = findProjectPreset(projects, settings, workspace);
        if (matchedProject && matchedProject.id !== activeProjectId) setActiveProjectId(matchedProject.id);
    }, [activeProjectId, hydrated, projects, settings, workspace]);

    useEffect(() => {
        if (!hydrated) return;
        atBottomRef.current = true;
        setUnreadCount(0);
        setMessages(readStoredThreadMessages(settings.threadId) || readStoredMessages(normalizeCanvasId(settings.canvasId)));
    }, [hydrated, settings.canvasId]);

    useEffect(() => {
        if (!hydrated) return;
        const storedMessages = JSON.stringify(messages.slice(-120));
        try {
            localStorage.setItem(messagesStorageKey(normalizeCanvasId(settingsRef.current.canvasId)), storedMessages);
            localStorage.setItem(messagesKey, storedMessages);
            const threadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
            if (threadId) localStorage.setItem(threadMessagesStorageKey(threadId), storedMessages);
        } catch {
            // Message caches are best effort and must not interrupt the active chat.
        }
        const scroller = scrollerRef.current;
        if (!scroller) return;
        if (atBottomRef.current) {
            requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
            setUnreadCount(0);
        } else {
            setUnreadCount((value) => value + 1);
        }
    }, [hydrated, messages]);

    useEffect(() => {
        if (!hydrated) return;
        const pendingRun = readPendingRun(normalizeCanvasId(settings.canvasId));
        if (pendingRun?.threadId === (activeThreadIdRef.current || normalizeThreadId(settings.threadId))) {
            pendingPromptRef.current = pendingRun.prompt;
            setSending(true);
            setTemporaryStatus("Codex 正在执行...");
            pollThreadUntilReply(pendingRun.threadId, pendingRun.canvasId, pendingRun.prompt);
        }
        try {
            ensureRealtimeEvents(validateAgentUrl(settingsRef.current.agentUrl), { silent: true });
        } catch {
            // Connection settings may still be incomplete; the explicit connect button will show the error.
        }
        const syncVisibleThread = () => {
            if (document.visibilityState === "hidden") return;
            const threadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
            if (!threadId || !settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) return;
            void refreshThreadMessages(threadId, normalizeCanvasId(settingsRef.current.canvasId)).catch(() => undefined);
        };
        const handleVisibility = () => syncVisibleThread();
        window.addEventListener("focus", syncVisibleThread);
        window.addEventListener("online", syncVisibleThread);
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            window.removeEventListener("focus", syncVisibleThread);
            window.removeEventListener("online", syncVisibleThread);
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, [hydrated, activeThreadId, settings.agentUrl, settings.token, settings.canvasId, settings.threadId]);

    const setTemporaryStatus = (text: string, autoClear = false) => {
        setRunStatus(text);
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        if (autoClear) statusTimerRef.current = setTimeout(() => setRunStatus(""), 1800);
    };

    const pushMessage = (message: MobileMessage) => setMessages((items) => [...items, message].slice(-140));

    const upsertStreamMessage = (message: MobileMessage) => {
        setMessages((items) => {
            const key = message.streamId || message.id;
            const index = items.findIndex((item) => (item.streamId || item.id) === key);
            if (index < 0) return [...items, message].slice(-140);
            const next = [...items];
            next[index] = { ...next[index], ...message, id: next[index].id };
            return next;
        });
    };

    const updateSettings = (patch: Partial<Settings>) =>
        setSettings((value) => {
            const next = { ...value, ...patch };
            settingsRef.current = next;
            return next;
        });

    function markActiveQueueTask(status: QueuedTaskStatus, error = "") {
        const id = activeQueueTaskIdRef.current;
        if (!id) return;
        setQueuedTasks((items) => {
            const next = items.map((item) => (item.id === id ? { ...item, status, error } : item));
            queuedTasksRef.current = next;
            return next;
        });
        activeQueueTaskIdRef.current = "";
    }

    function stopThreadPoll() {
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
        pollingRunKeyRef.current = "";
    }

    function setThreadRunning(threadId: string, running: boolean) {
        if (!threadId) return;
        setRunningThreadIds((current) => {
            const next = running ? [...new Set([...current, threadId])] : current.filter((id) => id !== threadId);
            writeRunningThreads(next);
            return next;
        });
    }

    function finishCurrentTurn(statusText = "本轮完成", autoClear = true) {
        setThreadRunning(activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId), false);
        pendingPromptRef.current = "";
        setSending(false);
        setRemoteBusy(false);
        clearPendingRun();
        stopThreadPoll();
        markActiveQueueTask("done");
        setTemporaryStatus(statusText, autoClear);
        window.setTimeout(() => void runNextQueuedTask(), 350);
    }

    function failCurrentTurn(errorText: string) {
        setThreadRunning(activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId), false);
        pendingPromptRef.current = "";
        setSending(false);
        setRemoteBusy(false);
        clearPendingRun();
        stopThreadPoll();
        setTemporaryStatus("");
        markActiveQueueTask("failed", errorText);
        window.setTimeout(() => void runNextQueuedTask(), 350);
    }

    function enqueueTask(text: string, taskAttachments: AgentAttachment[] = []) {
        const task: QueuedTask = {
            id: createId(),
            text: text.trim(),
            attachments: taskAttachments,
            createdAt: Date.now(),
            status: "queued",
        };
        setQueuedTasks((items) => {
            const next = normalizeQueue([...items, task]);
            queuedTasksRef.current = next;
            return next;
        });
        window.setTimeout(() => void runNextQueuedTask(), 100);
        return task;
    }

    function setPendingGuideDraft(text: string, taskAttachments: AgentAttachment[] = []) {
        const trimmed = text.trim();
        if (!trimmed && !taskAttachments.length) return null;
        const draft: PendingGuide = {
            id: createId(),
            text: trimmed || "请根据所附图片或文档继续处理当前任务。",
            attachments: taskAttachments,
            createdAt: Date.now(),
        };
        const next = [...pendingGuidesRef.current, draft].slice(-20);
        pendingGuidesRef.current = next;
        setPendingGuides(next);
        setTemporaryStatus("已加入待引导队列，任务结束后会自动继续；也可点“引导”插入当前任务。", true);
        return draft;
    }

    function clearPendingGuide(id: string) {
        const next = pendingGuidesRef.current.filter((draft) => draft.id !== id);
        pendingGuidesRef.current = next;
        setPendingGuides(next);
    }

    function editPendingGuide(id: string) {
        const draft = pendingGuidesRef.current.find((item) => item.id === id);
        if (!draft) return;
        const currentInput = input.trim();
        const currentAttachments = attachments;
        const nextGuides = pendingGuidesRef.current.filter((item) => item.id !== id);
        if (currentInput || currentAttachments.length) {
            nextGuides.push({
                id: createId(),
                text: currentInput || "请根据所附图片或文档继续处理当前任务。",
                attachments: currentAttachments,
                createdAt: Date.now(),
            });
        }
        const normalizedGuides = nextGuides.slice(-20);
        pendingGuidesRef.current = normalizedGuides;
        setPendingGuides(normalizedGuides);
        setInput(draft.text);
        setAttachments(draft.attachments || []);
        setTemporaryStatus("已放回输入框，可继续修改。", true);
        requestAnimationFrame(() => inputRef.current?.focus());
    }

    function firstPendingGuide() {
        return pendingGuidesRef.current[0] || null;
    }

    function hasDailyTurnQuota(actionLabel = "发送") {
        if (!quotaEnabled) return true;
        const current = readDailyUsage(quotaUserId);
        if (current >= codexRemoteDailyTurnLimit) {
            setDailyUsage(current);
            pushMessage({ id: createId(), role: "error", title: "今日额度已用完", text: `当前账号今天已使用 ${codexRemoteDailyTurnLimit}/${codexRemoteDailyTurnLimit} 次 Codex Remote。请明天再用，输入激活码解锁无限使用，或改成自己的私有部署。` });
            return false;
        }
        return true;
    }

    function spendDailyTurn() {
        if (!quotaEnabled) return;
        const next = readDailyUsage(quotaUserId) + 1;
        writeDailyUsage(quotaUserId, next);
        setDailyUsage(next);
    }

    async function unlockQuota() {
        const normalized = unlockCode.trim();
        setUnlockError("");
        if (!normalized) {
            setUnlockError("请输入激活码。");
            return;
        }
        const response = await fetch("/api/codex-remote-unlock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: normalized }),
        }).catch(() => null);
        const payload = (await response?.json().catch(() => ({}))) as { error?: string };
        if (!response?.ok) {
            setUnlockError(payload.error || "激活码不正确。");
            return;
        }
        localStorage.setItem(quotaUnlockKey, "1");
        setQuotaUnlocked(true);
        setUnlockCode("");
        setTemporaryStatus("已解锁 Codex Remote 无限使用。", true);
    }

    function dismissDemoNotice() {
        localStorage.setItem(demoNoticeKey, "1");
        setDemoNoticeOpen(false);
    }

    async function currentTurnBusy() {
        const localBusy = Boolean(sending || pendingPromptRef.current || activeQueueTaskIdRef.current || remoteBusy);
        if (!localBusy) return false;
        const threadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
        if (!threadId || !settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) return localBusy;
        try {
            const query = workspaceSearchParams(normalizeCanvasId(settingsRef.current.canvasId));
            query.set("threadId", threadId);
            const data = await agentFetch<{ busy?: boolean; canSteer?: boolean; stale?: boolean }>(`/agent/codex/status?${query.toString()}`);
            if (data.busy && data.canSteer !== false) {
                setThreadRunning(threadId, true);
                setSending(true);
                setRemoteBusy(true);
                return true;
            }
            pendingPromptRef.current = "";
            setThreadRunning(threadId, false);
            setSending(false);
            setRemoteBusy(false);
            clearPendingRun();
            stopThreadPoll();
            markActiveQueueTask("done");
            await refreshThreadMessages(threadId, normalizeCanvasId(settingsRef.current.canvasId), "", { forceScroll: true }).catch(() => undefined);
            return false;
        } catch {
            return localBusy;
        }
    }

    async function stopCurrentTurn() {
        const threadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
        try {
            await agentFetch<{ interrupted?: boolean }>("/agent/codex/turn/interrupt", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(normalizeCanvasId(settingsRef.current.canvasId), { threadId })),
            });
            if (threadId) await refreshThreadMessages(threadId, normalizeCanvasId(settingsRef.current.canvasId), "", { forceScroll: true }).catch(() => undefined);
            finishCurrentTurn("已停止当前任务", true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushMessage({ id: createId(), role: "error", title: "停止失败", text: message });
        }
    }

    async function confirmPendingGuide(id: string, extraGuide = "") {
        const draft = pendingGuidesRef.current.find((item) => item.id === id);
        if (!draft) return;
        const text = [draft.text.trim(), extraGuide.trim()].filter(Boolean).join("\n");
        if (!text) {
            clearPendingGuide(id);
            return;
        }
        const threadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
        if (!threadId) {
            setTemporaryStatus("当前没有可引导的 Codex 会话。", true);
            return;
        }
        if (steeringGuideIdsRef.current.has(id)) return;
        steeringGuideIdsRef.current.add(id);
        setSteeringGuideIds((items) => (items.includes(id) ? items : [...items, id]));
        try {
            const busy = await currentTurnBusy();
            if (!busy) {
                clearPendingGuide(id);
                setTemporaryStatus("当前没有运行任务，已立即发送。", true);
                const ok = await submitPrompt(text, draft.attachments || []);
                if (!ok) {
                    const next = [draft, ...pendingGuidesRef.current].slice(0, 20);
                    pendingGuidesRef.current = next;
                    setPendingGuides(next);
                }
                return;
            }
            if (!hasDailyTurnQuota("引导")) return;
            await agentFetch<{ threadId?: string }>("/agent/codex/turn/steer", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(normalizeCanvasId(settingsRef.current.canvasId), {
                    threadId,
                    requestId: id,
                    prompt: text,
                    attachments: draft.attachments || [],
                    ...codexModelSettings(settingsRef.current),
                })),
            });
            spendDailyTurn();
            clearPendingGuide(id);
            setTemporaryStatus("已引导对话", true);
            pushMessage({ id: createId(), role: "status", text: "已引导对话" });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/no active.*turn|active.*turn.*steer|没有活动.*回合|没有.*turn/i.test(message)) {
                clearPendingGuide(id);
                await refreshThreadMessages(threadId, normalizeCanvasId(settingsRef.current.canvasId), "", { forceScroll: true }).catch(() => undefined);
                finishCurrentTurn("当前任务已结束", true);
                setTemporaryStatus("当前任务已结束，请作为新消息发送", true);
                return;
            }
            const fallbackMessage = isAgentRouteNotFound(message) ? "电脑 Agent 还没更新到支持 Codex 引导。重启新版 Agent 后再点“引导”。" : message;
            setTemporaryStatus("");
            pushMessage({ id: createId(), role: "error", title: "引导失败", text: fallbackMessage });
        } finally {
            steeringGuideIdsRef.current.delete(id);
            setSteeringGuideIds((items) => items.filter((item) => item !== id));
        }
    }

    function removeQueueTask(id: string) {
        setQueuedTasks((items) => {
            const next = items.filter((item) => item.id !== id || item.status === "running");
            queuedTasksRef.current = next;
            return next;
        });
    }

    function clearFinishedQueue() {
        setQueuedTasks((items) => {
            const next = items.filter((item) => item.status === "queued" || item.status === "running");
            queuedTasksRef.current = next;
            return next;
        });
    }

    function scrollToLatest() {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        atBottomRef.current = true;
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
        setUnreadCount(0);
    }

    function scrollToRequirement(messageId: string) {
        const element = messageElementsRef.current.get(messageId);
        if (!element) return;
        atBottomRef.current = false;
        element.scrollIntoView({ block: "start", behavior: "smooth" });
        setRequirementsOpen(false);
    }

    function handleScroll() {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const nearBottom = isNearBottom(scroller);
        atBottomRef.current = nearBottom;
        if (nearBottom) setUnreadCount(0);
    }

    function sameText(a: string, b: string) {
        return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
    }

    function promptIndex(items: MobileMessage[], prompt: string) {
        if (!prompt.trim()) return -1;
        for (let index = items.length - 1; index >= 0; index -= 1) {
            if (items[index]?.role === "user" && (sameText(items[index].text, prompt) || items[index].text.trim().startsWith(`${prompt.trim()}\n\n[附件：`))) return index;
        }
        return -1;
    }

    function applyThreadMessages(items: MobileMessage[] | undefined, pendingPrompt = "", options: { requirePromptMatch?: boolean; forceScroll?: boolean } = {}) {
        if (!items?.length) return [];
        const visibleItems = messagesForReceiveMode(items, settingsRef.current.receiveMode);
        if (pendingPrompt && options.requirePromptMatch && promptIndex(visibleItems, pendingPrompt) < 0) return visibleItems;
        if (options.forceScroll) {
            atBottomRef.current = true;
            setUnreadCount(0);
        }
        setMessages((currentItems) => {
            if (!pendingPrompt) return visibleItems;
            const localPromptIndex = promptIndex(currentItems, pendingPrompt);
            if (localPromptIndex < 0) return visibleItems;
            const localTurn = currentItems.slice(localPromptIndex);
            const remotePromptIndex = promptIndex(visibleItems, pendingPrompt);
            if (remotePromptIndex < 0) return [...visibleItems, ...localTurn].slice(-140);

            const merged = [...visibleItems];
            localTurn.slice(1).forEach((localMessage) => {
                const key = localMessage.streamId || localMessage.id;
                const remoteIndex = merged.findIndex((remoteMessage) => (remoteMessage.streamId || remoteMessage.id) === key);
                if (remoteIndex < 0) {
                    merged.push(localMessage);
                    return;
                }
                if (localMessage.text.length > merged[remoteIndex].text.length) merged[remoteIndex] = localMessage;
            });
            return merged.slice(-140);
        });
        return visibleItems;
    }

    const agentFetch = async <T,>(targetPath: string, init?: RequestInit) => {
        const currentSettings = settingsRef.current;
        const mistake = agentUrlMistakeMessage(currentSettings.agentUrl);
        if (mistake) throw new Error(mistake);
        const controller = init?.signal ? null : new AbortController();
        const timeout = window.setTimeout(() => controller?.abort(), init?.method === "POST" ? 45_000 : 20_000);
        try {
            const response = await fetch(`${endpoint(currentSettings.agentUrl)}${targetPath}`, {
                ...init,
                signal: init?.signal || controller?.signal,
                headers: { "Content-Type": "application/json", "x-canvas-agent-token": currentSettings.token.trim(), ...(init?.headers || {}) },
            });
            const payload = (await response.json().catch(() => ({}))) as T & { error?: string; msg?: string };
            if (!response.ok) {
                if (response.status === 404) throw new Error(`${agentUrlMistakeMessage(currentSettings.agentUrl) || "Agent 请求 404。请确认 Agent URL 指向的是正在运行的 Codex Remote Bridge，而不是网页地址；如果地址正确，请重启电脑端 bridge 以更新接口。"} 请求路径：${targetPath}`);
                throw new Error(payload.error || payload.msg || `Agent 请求失败：${response.status}`);
            }
            return payload;
        } catch (error) {
            if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw new Error("Agent 请求超时，请检查电脑 Bridge 和网络连接后重试。");
            throw error;
        } finally {
            window.clearTimeout(timeout);
        }
    };

    const restoreCodexDefaults = async () => {
        if (resettingModelSettings) return;
        updateSettings({ model: "", effort: "" });
        if (!settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) {
            setTemporaryStatus("已清空手机端模型设置；连接电脑后将使用默认模型。", true);
            return;
        }
        setResettingModelSettings(true);
        try {
            const data = await agentFetch<{ workspace?: Workspace }>("/agent/codex/workspace", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(normalizeCanvasId(settingsRef.current.canvasId), { model: "", effort: "" })),
            });
            if (data.workspace) setWorkspace(data.workspace);
            setTemporaryStatus("已恢复电脑 Codex 默认模型", true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushMessage({ id: createId(), role: "error", title: "恢复默认失败", text: `手机端已清空模型设置，但电脑 Bridge 尚未确认：${message}` });
        } finally {
            setResettingModelSettings(false);
        }
    };

    const refreshThreadMessages = async (threadId: string, canvasId: string, pendingPrompt = "", options: { forceScroll?: boolean } = {}) => {
        const data = await agentFetch<{ workspace?: Workspace; messages?: MobileMessage[]; busy?: boolean }>(`/agent/codex/threads/${encodeURIComponent(threadId)}?${workspaceSearchParams(canvasId).toString()}`);
        if (data.workspace) {
            setWorkspace(data.workspace);
            setActiveThreadId(data.workspace.activeThreadId || threadId);
        }
        return { items: applyThreadMessages(data.messages, pendingPrompt, options), busy: Boolean(data.busy) };
    };

    const syncThreadInBackground = async (threadId: string, canvasId: string, options: { forceScroll?: boolean; clearWhenEmpty?: boolean; statusText?: string } = {}) => {
        if (!threadId) return false;
        const syncSeq = ++threadSyncSeqRef.current;
        try {
            const data = await agentFetch<{ workspace?: Workspace; messages?: MobileMessage[]; busy?: boolean }>(`/agent/codex/threads/${encodeURIComponent(threadId)}/resume`, {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(canvasId, { workspacePath: settingsRef.current.workspacePath.trim() || undefined, ...codexModelSettings(settingsRef.current) })),
            });
            if (syncSeq !== threadSyncSeqRef.current) return false;
            setWorkspace(data.workspace || workspace);
            activeThreadIdRef.current = threadId;
            setActiveThreadId(threadId);
            setThreadRunning(threadId, Boolean(data.busy));
            setSending(Boolean(data.busy));
            setRemoteBusy(Boolean(data.busy));
            if (data.busy) {
                const pendingRun = readPendingRun(canvasId);
                pollThreadUntilReply(threadId, canvasId, pendingRun?.threadId === threadId ? pendingRun.prompt : "");
            } else {
                stopThreadPoll();
            }
            if (!pendingPromptRef.current) {
                if (data.messages?.length) applyThreadMessages(data.messages, "", { forceScroll: options.forceScroll });
                else if (options.clearWhenEmpty) setMessages([]);
            }
            if (options.statusText) setTemporaryStatus(options.statusText, true);
            return true;
        } catch (error) {
            if (syncSeq !== threadSyncSeqRef.current) return false;
            const message = error instanceof Error ? error.message : String(error);
            setTemporaryStatus("");
            setConnectionMessage(`已连接 Agent，但会话同步失败：${message}`);
            pushMessage({ id: createId(), role: "error", title: "会话同步失败", text: message });
            return false;
        }
    };

    const refreshThreads = async (quiet = false) => {
        if (!settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) return threads;
        setThreadsLoading(true);
        setThreadError("");
        try {
            const query = new URLSearchParams();
            if (threadSearch.trim()) query.set("searchTerm", threadSearch.trim());
            const data = await agentFetch<{ projects?: ProjectPreset[]; data?: ThreadSummary[] }>(`/agent/codex/workspaces?${query.toString()}`);
            const discoveredProjects = normalizeProjectList(data.projects || []);
            const nextThreads = data.data || [];
            setRunningThreadIds((current) => {
                const next = [...new Set([...current, ...nextThreads.filter((thread) => threadIsBusy(thread.status)).map((thread) => thread.id)])];
                writeRunningThreads(next);
                return next;
            });
            const mergedProjects = mergeProjectLists(discoveredProjects, projects);
            setThreads(nextThreads);
            setProjects(mergedProjects);
            if (!threadSearch.trim()) writeThreadCatalog(nextThreads, mergedProjects);
            if (!quiet) pushMessage({ id: createId(), role: "status", text: nextThreads.length ? `已读取 ${nextThreads.length} 个全部工作区会话。` : "电脑上没有可显示的 Codex 会话。" });
            return nextThreads;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const fallbackMessage = isAgentRouteNotFound(message)
                ? "当前电脑 Agent 暂不支持读取会话列表。可以先用设置里的 Codex Thread ID 连接指定会话；电脑端 agent 更新并重启后，会话列表会恢复。"
                : message;
            if (!quiet) {
                setThreadError(fallbackMessage);
                pushMessage({ id: createId(), role: "error", title: "会话读取失败", text: fallbackMessage });
            } else {
                setThreadError("");
            }
            return threads;
        } finally {
            setThreadsLoading(false);
        }
    };

    const refreshWorkspaceProjects = async (quiet = false) => {
        if (!settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) {
            if (!quiet) setThreadError("请先填写 Agent URL 和 Token。");
            return projects;
        }
        setProjectsLoading(true);
        setThreadError("");
        try {
            const query = new URLSearchParams();
            if (threadSearch.trim()) query.set("searchTerm", threadSearch.trim());
            const data = await agentFetch<{ projects?: ProjectPreset[]; data?: ThreadSummary[] }>(`/agent/codex/workspaces?${query.toString()}`);
            const discoveredProjects = normalizeProjectList(data.projects || []);
            const discoveredThreads = data.data || [];
            const mergedProjects = mergeProjectLists(discoveredProjects, projects);
            setThreads(discoveredThreads);
            setProjects(mergedProjects);
            if (!threadSearch.trim()) writeThreadCatalog(discoveredThreads, mergedProjects);
            if (!quiet) pushMessage({ id: createId(), role: "status", text: discoveredProjects.length ? `已从电脑发现 ${discoveredProjects.length} 个 Codex 工作区。` : "没有发现新的 Codex 工作区。" });
            return mergedProjects;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const fallbackMessage = isAgentRouteNotFound(message)
                ? "当前电脑 Agent 暂不支持自动发现项目。可以点“新增”手动添加 Workspace；电脑端 agent 更新并重启后，“发现”会自动列出项目。"
                : message;
            if (!quiet) {
                setThreadError(fallbackMessage);
                pushMessage({ id: createId(), role: "error", title: "项目发现失败", text: fallbackMessage });
            } else {
                setThreadError("");
            }
            return projects;
        } finally {
            setProjectsLoading(false);
        }
    };

    const refreshGitRepos = async (quiet = false) => {
        if (!settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) return repos;
        setReposLoading(true);
        setRepoError("");
        try {
            const workspaceId = normalizeCanvasId(settingsRef.current.canvasId);
            const data = await agentFetch<{ workspace?: Workspace; repos?: GitRepoInfo[] }>(`/agent/git/repos?${workspaceSearchParams(workspaceId).toString()}`);
            const nextRepos = data.repos || [];
            setRepos(nextRepos);
            if (data.workspace) setWorkspace(data.workspace);
            const currentSelection = settingsRef.current.gitRepoPath;
            const nextSelection = nextRepos.find((repo) => samePath(repo.repoPath, currentSelection)) || nextRepos.find((repo) => !repo.pushBlocked) || nextRepos[0];
            if (nextSelection && !samePath(nextSelection.repoPath, currentSelection)) updateSettings({ gitRepoPath: nextSelection.repoPath });
            if (!quiet) pushMessage({ id: createId(), role: "status", text: nextRepos.length ? `已发现 ${nextRepos.length} 个本机 Git 仓库。` : "没有发现可推送的 Git 仓库。" });
            return nextRepos;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setRepoError(message);
            if (!quiet) pushMessage({ id: createId(), role: "error", title: "仓库刷新失败", text: message });
            return repos;
        } finally {
            setReposLoading(false);
        }
    };

    const pollThreadUntilReply = (threadId: string, canvasId: string, prompt: string) => {
        const runKey = `${canvasId}:${threadId}`;
        if (pollingRunKeyRef.current === runKey) return;
        stopThreadPoll();
        pollingRunKeyRef.current = runKey;
        if (prompt) writePendingRun({ threadId, canvasId, prompt, startedAt: Date.now() });
        let attempts = 0;
        let consecutiveFailures = 0;
        const tick = async () => {
            if (pollingRunKeyRef.current !== runKey || activeThreadIdRef.current !== threadId) return;
            attempts += 1;
            try {
                const query = workspaceSearchParams(canvasId);
                query.set("threadId", threadId);
                const status = await agentFetch<{ busy?: boolean; canSteer?: boolean; stale?: boolean }>(`/agent/codex/status?${query.toString()}`);
                if (pollingRunKeyRef.current !== runKey || activeThreadIdRef.current !== threadId) return;
                consecutiveFailures = 0;
                if (!status.busy || status.canSteer === false || status.stale) {
                    await refreshThreadMessages(threadId, canvasId, prompt, { forceScroll: true }).catch(() => undefined);
                    if (pollingRunKeyRef.current !== runKey || activeThreadIdRef.current !== threadId) return;
                    finishCurrentTurn("本轮完成", true);
                    return;
                }
                setThreadRunning(threadId, true);
                setSending(true);
                setRemoteBusy(true);
            } catch (error) {
                consecutiveFailures += 1;
                if (consecutiveFailures >= 4) {
                    setConnectionStatus("offline");
                    setConnectionMessage("状态确认暂时失败，电脑任务仍会继续；正在自动重试。");
                }
            }
            const delay = consecutiveFailures >= 4 ? 10_000 : attempts < 4 ? 2000 : 4000;
            pollTimerRef.current = setTimeout(tick, delay);
        };
        pollTimerRef.current = setTimeout(tick, 1500);
    };

    const eventBelongsToVisibleThread = (event: AgentEvent) => {
        const visibleThreadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
        if (event.thread_id) return event.thread_id === visibleThreadId;
        return Boolean(pendingPromptRef.current && visibleThreadId);
    };

    const turnFailureKeys = (threadId = "", turnId = "") => [
        turnId ? `turn:${turnId}` : "",
        threadId ? `thread:${threadId}` : "",
    ].filter(Boolean);

    const reportCodexError = (rawMessage: string, threadId = "", turnId = "") => {
        const message = rawMessage.trim() || "Codex 未返回具体错误原因";
        const failureKeys = turnFailureKeys(threadId, turnId);
        const existingKey = failureKeys.map((key) => failedTurnKeysRef.current.get(key)).find(Boolean) || "";
        const failureKey = existingKey || failureKeys[0] || "";
        const duplicate = Boolean(existingKey);
        if (failureKey) {
            failureKeys.forEach((key) => failedTurnKeysRef.current.set(key, failureKey));
            if (failedTurnKeysRef.current.size > 200) {
                const oldestKey = failedTurnKeysRef.current.keys().next().value;
                if (oldestKey) failedTurnKeysRef.current.delete(oldestKey);
            }
        }
        if (!duplicate) failCurrentTurn(message);

        const recent = recentUnscopedErrorRef.current;
        const now = Date.now();
        const id = failureKey
            ? `turn-error-${failureKey}`
            : recent && recent.message === message && now - recent.at < 30_000
              ? recent.id
              : createId();
        recentUnscopedErrorRef.current = { id, message, at: now };
        upsertStreamMessage({ id, streamId: id, role: "error", title: "Codex", text: message });
    };

    const handleAgentEvent = (event: AgentEvent) => {
        if (event.thread_id && event.type === "turn.started") setThreadRunning(event.thread_id, true);
        if (event.thread_id && (event.type === "turn.completed" || (event.type === "error" && !event.will_retry))) setThreadRunning(event.thread_id, false);
        if (!eventBelongsToVisibleThread(event)) return;
        const item = event.item;
        const itemType = normalizeText(itemField(item, "type"));
        if (event.type === "turn.started") {
            turnFailureKeys(event.thread_id, event.turn_id).forEach((key) => failedTurnKeysRef.current.delete(key));
            setSending(true);
            setRemoteBusy(true);
            setTemporaryStatus("Codex 正在思考...");
            upsertStreamMessage({ id: "turn-status", role: "status", text: "Codex 正在处理..." });
            if (event.thread_id) pollThreadUntilReply(event.thread_id, normalizeCanvasId(settingsRef.current.canvasId), pendingPromptRef.current);
            return;
        }
        if (event.type === "turn.completed") {
            const failed = turnFailureKeys(event.thread_id, event.turn_id).some((key) => failedTurnKeysRef.current.has(key));
            if (failed) return;
            finishCurrentTurn("本轮完成", true);
            upsertStreamMessage({ id: `done-${Date.now()}`, role: "status", text: "本轮完成" });
            return;
        }
        if (event.type === "error") {
            const message = normalizeText(event.message || itemField(item, "message")) || "Codex 未返回具体错误原因";
            if (event.will_retry) {
                setTemporaryStatus(`Codex 暂时出错，正在重试：${message}`);
                return;
            }
            reportCodexError(message, event.thread_id, event.turn_id);
            return;
        }
        if ((event.type === "item.updated" || event.type === "item.completed") && itemType === "agent_message") {
            if (settingsRef.current.receiveMode === "final" && event.type === "item.updated") return;
            const id = normalizeText(itemField(item, "id")) || createId();
            const text = normalizeText(itemField(item, "text"));
            if (text) {
                setTemporaryStatus("Codex 正在输出回复...");
                upsertStreamMessage({ id, streamId: id, role: "assistant", title: "Codex", text });
            }
            return;
        }
        if (event.type === "item.started" || event.type === "item.completed") {
            if (settingsRef.current.receiveMode !== "full") return;
            const tool = normalizeText(itemField(item, "tool"));
            if (tool || itemType === "commandExecution" || itemType === "fileChange") {
                const id = normalizeText(itemField(item, "id")) || createId();
                const label = itemType === "commandExecution" ? "命令" : itemType === "fileChange" ? "文件变更" : toolLabel(tool);
                const status = normalizeText(itemField(item, "status")) || (event.type === "item.started" ? "执行中" : "完成");
                setTemporaryStatus(event.type === "item.started" ? itemStatusLabel(itemType, tool) : `${label} 已完成`, event.type === "item.completed");
                upsertStreamMessage({ id, streamId: id, role: "tool", title: label, text: status });
            }
        }
    };

    const ensureRealtimeEvents = (agentEndpoint: string, options: { silent?: boolean; showProjectChooser?: boolean } = {}) => {
        if (eventSourceRef.current && eventSourceRef.current.readyState !== EventSource.CLOSED) return eventSourceRef.current;
        const source = new EventSource(withToken(agentEndpoint, `/events?clientId=mobile-codex-${Date.now()}`, settingsRef.current.token));
        eventSourceRef.current = source;
        source.addEventListener("hello", () => {
            setConnected(true);
            setConnecting(false);
            setConnectionStatus("connected");
            if (!options.silent && !options.showProjectChooser) setConnectionMessage("实时通道已连接");
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEvent>(event);
            if (data) handleAgentEvent(data);
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<{ message?: string; thread_id?: string; turn_id?: string }>(event);
            if (!data?.thread_id || data.thread_id !== (activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId))) return;
            reportCodexError(data.message || "Agent 未返回具体错误原因", data.thread_id, data.turn_id);
        });
        source.onerror = () => {
            setConnected(false);
            setConnecting(false);
            setConnectionStatus("offline");
            if (!options.silent) setConnectionMessage("实时通道断开；发送和同步仍会尝试通过 HTTP 继续");
            const threadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
            const prompt = pendingPromptRef.current;
            if (threadId && prompt) pollThreadUntilReply(threadId, normalizeCanvasId(settingsRef.current.canvasId), prompt);
        };
        return source;
    };

    const connect = async (options: { quiet?: boolean; silent?: boolean } = {}) => {
        eventSourceRef.current?.close();
        if (!options.silent) {
            setConnecting(true);
            setConnected(false);
            setConnectionStatus("connecting");
            setConnectionMessage("正在连接电脑 Agent...");
        }
        if (!options.quiet) pushMessage({ id: createId(), role: "status", text: "正在连接电脑 Agent..." });
        try {
            const agentEndpoint = validateAgentUrl(settingsRef.current.agentUrl);
            if (agentEndpoint !== settingsRef.current.agentUrl.trim()) {
                settingsRef.current = { ...settingsRef.current, agentUrl: agentEndpoint };
                updateSettings({ agentUrl: agentEndpoint });
            }
            ensureRealtimeEvents(agentEndpoint, { silent: true });
            const canvasId = normalizeCanvasId(settingsRef.current.canvasId);
            const threadId = normalizeThreadId(settingsRef.current.threadId) || activeThreadIdRef.current;
            const modelSettings = codexModelSettings(settingsRef.current);
            const workspaceData = await agentFetch<{ workspace?: Workspace }>("/agent/codex/workspace", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(canvasId, { ...(settingsRef.current.workspacePath.trim() ? { workspacePath: settingsRef.current.workspacePath.trim() } : {}), ...modelSettings })),
            });
            const currentWorkspace = workspaceData.workspace || null;
            const nextThreadId = threadId || currentWorkspace?.activeThreadId || "";
            const projectChoiceNeeded = !options.quiet && shouldChooseWorkspaceAfterConnect(settingsRef.current);
            const discoveredProjects = options.quiet ? projects : await refreshWorkspaceProjects(true);
            const showProjectChooser = projectChoiceNeeded && discoveredProjects.length > 0;
            setWorkspace(currentWorkspace);
            activeThreadIdRef.current = nextThreadId;
            setActiveThreadId(nextThreadId);

            setConnected(true);
            setConnecting(false);
            setConnectionStatus("connected");
            if (!options.silent) setConnectionMessage(showProjectChooser ? "已连接，请选择要继续的项目" : nextThreadId ? "已连接，正在同步会话..." : "已连接电脑 Codex");
            if (!options.quiet) pushMessage({ id: createId(), role: "status", text: "已连接电脑 Codex" });
            if (!options.quiet) {
                void refreshGitRepos(true);
                if (showProjectChooser) {
                    setSettingsOpen(false);
                    setThreadsOpen(true);
                    setTemporaryStatus("已发现电脑上的项目，请选择要继续的会话。", true);
                    pushMessage({ id: createId(), role: "status", text: "已发现电脑上的项目，已打开项目列表。" });
                } else {
                    void refreshThreads(true);
                }
                if (!showProjectChooser && nextThreadId) {
                    void syncThreadInBackground(nextThreadId, canvasId, { forceScroll: true, statusText: "会话已同步" }).then((ok) => {
                        if (ok && !options.silent) setConnectionMessage("已连接电脑 Codex");
                    });
                }
            }

            ensureRealtimeEvents(agentEndpoint, { silent: options.silent, showProjectChooser });
            return true;
        } catch (error) {
            setConnecting(false);
            setConnected(false);
            const message = error instanceof Error ? error.message : String(error);
            setConnectionStatus("error");
            if (!options.silent) {
                setConnectionMessage(message);
                pushMessage({ id: createId(), role: "error", title: "连接失败", text: message });
            }
            return false;
        }
    };

    const selectProject = async (project: ProjectPreset) => {
        stopThreadPoll();
        clearPendingRun();
        pendingPromptRef.current = "";
        markActiveQueueTask("done");
        setSending(false);
        setRemoteBusy(false);
        setRunStatus("");
        const nextSettings = sanitizeSettings({
            ...settingsRef.current,
            canvasId: project.canvasId,
            workspacePath: project.workspacePath,
            threadId: project.threadId,
            gitRepoPath: project.gitRepoPath || settingsRef.current.gitRepoPath,
        });
        settingsRef.current = nextSettings;
        setSettings(nextSettings);
        setActiveProjectId(project.id);
        if (typeof localStorage !== "undefined") localStorage.setItem(activeProjectKey, project.id);
        setWorkspace({ canvasId: project.canvasId, workspacePath: project.workspacePath, activeThreadId: project.threadId });
        activeThreadIdRef.current = project.threadId;
        setActiveThreadId(project.threadId);
        const projectBusy = runningThreadIds.includes(project.threadId);
        setSending(projectBusy);
        setRemoteBusy(projectBusy);
        setThreadSearch("");
        setThreadError("");
        setMessages(readStoredThreadMessages(project.threadId) || readStoredMessages(project.canvasId));
        setConnectionMessage(`已选择 ${project.label}，工作区：${project.workspacePath}`);
        setThreadsOpen(false);

        if (!nextSettings.agentUrl.trim() || !nextSettings.token.trim()) {
            setConnectionStatus("idle");
            return;
        }

        if (project.threadId) {
            setTemporaryStatus(`已切换到 ${project.label}`, true);
            void syncThreadInBackground(project.threadId, normalizeCanvasId(project.canvasId), { forceScroll: true, clearWhenEmpty: true });
            return;
        }

        setTemporaryStatus(`正在切换到 ${project.label}...`);
        try {
            const data = await agentFetch<{ workspace?: Workspace }>("/agent/codex/workspace", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(project.canvasId, { workspacePath: project.workspacePath, ...codexModelSettings(nextSettings) })),
            });
            if (data.workspace) setWorkspace(data.workspace);
            setConnected(true);
            setConnectionStatus("connected");
            setTemporaryStatus(`已切换到 ${project.label}`, true);
        } catch (error) {
            setTemporaryStatus("");
            pushMessage({ id: createId(), role: "error", title: "项目切换失败", text: error instanceof Error ? error.message : String(error) });
        }
    };

    function startAddProject() {
        setEditingProjectId("");
        setProjectDraft(emptyProjectDraft);
        setProjectFormOpen(true);
    }

    function startEditProject(project: ProjectPreset) {
        setEditingProjectId(project.id);
        setProjectDraft({
            label: project.label,
            canvasId: project.canvasId,
            workspacePath: project.workspacePath,
            threadId: project.threadId,
            gitRepoPath: project.gitRepoPath || "",
        });
        setProjectFormOpen(true);
    }

    function saveProject() {
        const label = projectDraft.label.trim();
        const workspacePath = projectDraft.workspacePath.trim();
        if (!label) {
            setThreadError("请填写项目名称。");
            return;
        }
        if (!workspacePath) {
            setThreadError("请填写 Workspace 路径。");
            return;
        }
        const id = editingProjectId || `custom-${createId()}`;
        const nextProject: ProjectPreset = {
            id,
            label,
            canvasId: projectCanvasIdFromDraft(projectDraft, id),
            workspacePath,
            threadId: normalizeThreadId(projectDraft.threadId),
            gitRepoPath: projectDraft.gitRepoPath.trim(),
        };
        setProjects((items) => {
            const next = editingProjectId ? items.map((item) => (item.id === editingProjectId ? nextProject : item)) : [...items, nextProject];
            return normalizeProjectList(next);
        });
        setThreadError("");
        setProjectFormOpen(false);
        setEditingProjectId("");
        setProjectDraft(emptyProjectDraft);
        setExpandedProjectId(nextProject.id);
    }

    function deleteProject(project: ProjectPreset) {
        if (codexBusy || pendingPromptRef.current || activeQueueTaskIdRef.current) {
            pushMessage({ id: createId(), role: "status", text: "当前 Codex 任务还在执行，完成后再删除项目。" });
            return;
        }
        const nextProjects = projects.filter((item) => item.id !== project.id);
        setProjects(nextProjects);
        if (activeProjectId === project.id) {
            setActiveProjectId("");
        }
        setExpandedProjectId((value) => (value === project.id ? nextProjects[0]?.id || "" : value));
    }

    const selectThread = async (thread: ThreadSummary) => {
        if (!thread.id) return;
        stopThreadPoll();
        clearPendingRun();
        pendingPromptRef.current = "";
        markActiveQueueTask("done");
        setSending(false);
        setRemoteBusy(false);
        setRunStatus("");
        const threadProject = projectFromThread(thread, projects);
        if (threadProject) {
            setProjects((items) => {
                const next = normalizeProjectList(items);
                const index = next.findIndex(
                    (project) =>
                        project.id === threadProject.id ||
                        project.canvasId === threadProject.canvasId ||
                        (project.workspacePath && threadProject.workspacePath && samePath(project.workspacePath, threadProject.workspacePath)),
                );
                if (index >= 0) next[index] = { ...next[index], ...threadProject, threadId: thread.id };
                else next.push(threadProject);
                return normalizeProjectList(next);
            });
            await selectProject(threadProject);
            return;
        }
        const canvasId = normalizeCanvasId(settingsRef.current.canvasId);
        threadSyncSeqRef.current += 1;
        activeThreadIdRef.current = thread.id;
        settingsRef.current = { ...settingsRef.current, threadId: thread.id };
        setActiveThreadId(thread.id);
        const threadBusy = runningThreadIds.includes(thread.id) || threadIsBusy(thread.status);
        setThreadRunning(thread.id, threadBusy);
        setSending(threadBusy);
        setRemoteBusy(threadBusy);
        updateSettings({ threadId: thread.id });
        setMessages(readStoredThreadMessages(thread.id) || readStoredMessages(canvasId));
        setThreadsOpen(false);
        setTemporaryStatus("已切换会话", true);
        void syncThreadInBackground(thread.id, canvasId, { forceScroll: true, clearWhenEmpty: true });
    };

    const pushCurrentCommit = async () => {
        if (pushing) return;
        if (!settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) {
            setSettingsOpen(true);
            pushMessage({ id: createId(), role: "error", title: "无法推送", text: "请先填写 Agent URL 和 Token。" });
            return;
        }
        if (!connected) {
            const ok = await connect({ quiet: true });
            if (!ok) return;
        }
        let repo = repos.find((item) => samePath(item.repoPath, settingsRef.current.gitRepoPath)) || selectedRepo;
        if (!repo) {
            const list = await refreshGitRepos(true);
            repo = list.find((item) => samePath(item.repoPath, settingsRef.current.gitRepoPath)) || list.find((item) => !item.pushBlocked) || list[0];
        }
        if (!repo) {
            pushMessage({ id: createId(), role: "error", title: "无法推送", text: "电脑上没有发现可推送的 Git 仓库。" });
            return;
        }
        if (repo.pushBlocked) {
            pushMessage({ id: createId(), role: "error", title: "推送已拦截", text: repo.warnings.join("\n") || "这个仓库当前不适合从手机直接 push。" });
            return;
        }
        const remote = repo.defaultRemote || "origin";
        const branch = repo.defaultBranch || "main";
        setPushing(true);
        setTemporaryStatus(`正在推送 ${repoName(repo.repoPath)}...`);
        pushMessage({ id: createId(), role: "status", text: `正在让电脑执行 git push ${remote} HEAD:${branch}\n${repo.repoPath}` });
        try {
            const data = await agentFetch<{ stdout?: string; stderr?: string; remote?: string; branch?: string; repo?: GitRepoInfo; repoPath?: string }>("/agent/git/push", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(normalizeCanvasId(settingsRef.current.canvasId), { repoPath: repo.repoPath, remote, branch })),
            });
            pushMessage({ id: createId(), role: "tool", title: "Git push", text: data.stdout || data.stderr || `已推送 ${repoName(data.repo?.repoPath || repo.repoPath)} 到 ${data.remote || remote}/${data.branch || branch}` });
            setTemporaryStatus("推送完成", true);
            void refreshGitRepos(true);
        } catch (error) {
            setTemporaryStatus("");
            pushMessage({ id: createId(), role: "error", title: "推送失败", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setPushing(false);
        }
    };

    const newThread = async () => {
        try {
            const data = await agentFetch<{ workspace?: Workspace; thread?: { id?: string }; messages?: MobileMessage[] }>("/agent/codex/threads/new", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(normalizeCanvasId(settingsRef.current.canvasId), codexModelSettings(settingsRef.current))),
            });
            setWorkspace(data.workspace || workspace);
            setActiveThreadId(data.thread?.id || data.workspace?.activeThreadId || "");
            if (data.thread?.id || data.workspace?.activeThreadId) updateSettings({ threadId: data.thread?.id || data.workspace?.activeThreadId || "" });
            setMessages([]);
            setThreadsOpen(false);
            pushMessage({ id: createId(), role: "status", text: "已创建新 Codex 对话" });
            void refreshThreads(true);
        } catch (error) {
            pushMessage({ id: createId(), role: "error", title: "新对话失败", text: error instanceof Error ? error.message : String(error) });
        }
    };

    async function submitPrompt(prompt: string, currentAttachments: AgentAttachment[], options: { queuedTaskId?: string } = {}) {
        if (!hasDailyTurnQuota("发送")) {
            if (options.queuedTaskId) markActiveQueueTask("failed", "今日 Codex Remote 额度已用完");
            else setAttachments(currentAttachments);
            return false;
        }
        if (!settingsRef.current.agentUrl.trim() || !settingsRef.current.token.trim()) {
            setConnectionStatus("error");
            setConnectionMessage("请先填写 Agent URL 和 Token");
            setSettingsOpen(true);
            if (options.queuedTaskId) markActiveQueueTask("queued");
            pushMessage({ id: createId(), role: "error", title: "发送失败", text: "请先填写 Agent URL 和 Token。" });
            return false;
        }
        setSending(true);
        pendingPromptRef.current = prompt;
        setTemporaryStatus("Codex 正在接收任务...");
        pushMessage({ id: createId(), role: "user", text: currentAttachments.length ? `${prompt}\n\n[附件：${attachmentSummary(currentAttachments)}]` : prompt });
        upsertStreamMessage({ id: "turn-status", role: "status", text: "Codex 正在处理..." });
        if (!connected) {
            const ok = await connect({ quiet: true });
            if (!ok) {
                setSending(false);
                pendingPromptRef.current = "";
                setTemporaryStatus("");
                setAttachments(currentAttachments);
                if (options.queuedTaskId) markActiveQueueTask("queued");
                return false;
            }
        }
        try {
            const canvasId = normalizeCanvasId(settingsRef.current.canvasId);
            const targetThreadId = activeThreadIdRef.current || normalizeThreadId(settingsRef.current.threadId);
            if (targetThreadId) writePendingRun({ threadId: targetThreadId, canvasId, prompt, startedAt: Date.now() });
            const data = await agentFetch<{ threadId?: string; attachments?: { accepted?: number; images?: number; documents?: number } }>("/agent/codex/turn", {
                method: "POST",
                body: JSON.stringify(workspaceRequestBody(canvasId, { prompt, threadId: targetThreadId || undefined, attachments: currentAttachments, ...codexModelSettings(settingsRef.current) })),
            });
            if (data.threadId) {
                const acceptedAttachments = Number(data.attachments?.accepted || 0);
                if (acceptedAttachments !== currentAttachments.length) throw new Error("附件传输未完成：选择了 " + currentAttachments.length + " 个，电脑只接收了 " + acceptedAttachments + " 个。");
                spendDailyTurn();
                activeThreadIdRef.current = data.threadId;
                setActiveThreadId(data.threadId);
                setThreadRunning(data.threadId, true);
                updateSettings({ threadId: data.threadId });
                pollThreadUntilReply(data.threadId, canvasId, prompt);
            }
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (options.queuedTaskId) {
                failCurrentTurn(message);
            } else {
                setSending(false);
                pendingPromptRef.current = "";
                stopThreadPoll();
                setTemporaryStatus("");
                setAttachments(currentAttachments);
            }
            pushMessage({ id: createId(), role: "error", title: "发送失败", text: message });
            return false;
        }
    }

    async function runNextQueuedTask() {
        if (pendingPromptRef.current || activeQueueTaskIdRef.current) return;
        const pendingGuide = firstPendingGuide();
        if (pendingGuide) {
            if (await currentTurnBusy()) {
                setTemporaryStatus("当前 Codex 会话仍在运行，待引导队列会稍后继续。", true);
                window.setTimeout(() => void runNextQueuedTask(), 2500);
                return;
            }
            setTemporaryStatus(`正在执行待引导：${pendingGuide.text.slice(0, 36)}${pendingGuide.text.length > 36 ? "..." : ""}`);
            const ok = await submitPrompt(pendingGuide.text, pendingGuide.attachments || []);
            if (ok) clearPendingGuide(pendingGuide.id);
            return;
        }
        const nextTask = queuedTasksRef.current.find((item) => item.status === "queued");
        if (!nextTask) return;
        if (await currentTurnBusy()) {
            setTemporaryStatus("当前 Codex 会话仍在运行，队列会稍后继续。", true);
            window.setTimeout(() => void runNextQueuedTask(), 2500);
            return;
        }
        activeQueueTaskIdRef.current = nextTask.id;
        setQueuedTasks((items) => {
            const next = items.map((item) => (item.id === nextTask.id ? { ...item, status: "running" as QueuedTaskStatus, error: "" } : item));
            queuedTasksRef.current = next;
            return next;
        });
        setTemporaryStatus(`正在执行队列任务：${nextTask.text.slice(0, 36)}${nextTask.text.length > 36 ? "..." : ""}`);
        await submitPrompt(nextTask.text, nextTask.attachments || [], { queuedTaskId: nextTask.id });
    }

    const submit = async (event?: FormEvent<HTMLFormElement>) => {
        event?.preventDefault();
        if (attachmentsReading) {
            setTemporaryStatus("附件正在读取，请稍候...", true);
            return;
        }
        const currentAttachments = attachments;
        const prompt = input.trim() || (currentAttachments.length ? "请根据所附图片或文档继续处理当前任务。" : "");
        if (!prompt) return;
        setInput("");
        setAttachments([]);
        if (await currentTurnBusy()) {
            setPendingGuideDraft(prompt, currentAttachments);
            return;
        }
        await submitPrompt(prompt, currentAttachments);
    };

    const copyMessage = async (message: MobileMessage) => {
        await navigator.clipboard.writeText(message.text);
        setCopiedId(message.id);
        window.setTimeout(() => setCopiedId(""), 1200);
    };

    const pickImages = async (event: ChangeEvent<HTMLInputElement>) => {
        const selected = [...(event.target.files || [])];
        event.target.value = "";
        const oversized = selected.find((file) => file.size > maxAttachmentBytes);
        if (oversized) {
            pushMessage({ id: createId(), role: "error", title: "图片过大", text: `${oversized.name} 超过 8 MB。` });
            return;
        }
        const files = selected.filter((file) => file.type.startsWith("image/")).slice(0, maxAttachmentCount);
        if (!files.length) return;
        setAttachmentsReading((value) => value + 1);
        try {
            const next = await Promise.all(files.map((file) => readFileAsDataUrl(file, "image")));
            setAttachments((items) => [...items, ...next].slice(0, maxAttachmentCount));
        } catch (error) {
            pushMessage({ id: createId(), role: "error", title: "图片读取失败", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setAttachmentsReading((value) => Math.max(0, value - 1));
        }
    };

    const pickDocuments = async (event: ChangeEvent<HTMLInputElement>) => {
        const selected = [...(event.target.files || [])];
        event.target.value = "";
        const unsupported = selected.find((file) => !isSupportedDocument(file));
        if (unsupported) {
            pushMessage({ id: createId(), role: "error", title: "文档格式不支持", text: unsupported.name });
            return;
        }
        const oversized = selected.find((file) => file.size > maxAttachmentBytes);
        if (oversized) {
            pushMessage({ id: createId(), role: "error", title: "文档过大", text: `${oversized.name} 超过 8 MB。` });
            return;
        }
        const files = selected.slice(0, maxAttachmentCount);
        if (!files.length) return;
        setAttachmentsReading((value) => value + 1);
        try {
            const next = await Promise.all(files.map((file) => readFileAsDataUrl(file, "document")));
            setAttachments((items) => [...items, ...next].slice(0, maxAttachmentCount));
        } catch (error) {
            pushMessage({ id: createId(), role: "error", title: "文档读取失败", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setAttachmentsReading((value) => Math.max(0, value - 1));
        }
    };

    return (
        <main className="flex h-full flex-col bg-[#f5f3ee] text-stone-950 dark:bg-[#070707] dark:text-stone-100">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-black/10 bg-white/60 px-4 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04]">
                <button
                    type="button"
                    className="grid size-9 shrink-0 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-400 dark:hover:bg-sky-400/10 dark:hover:text-sky-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        setThreadsOpen(true);
                        void refreshWorkspaceProjects(true);
                    }}
                    aria-label="打开侧边栏"
                    title="打开侧边栏"
                >
                    <Menu className="size-4" />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 text-base font-semibold leading-6">
                        <TerminalSquare className="size-4 shrink-0" />
                        <span className="truncate">Codex Remote</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span className="truncate">{activeProject ? `${activeProject.label} · ${workspace?.workspacePath || activeProject.workspacePath}` : workspace?.workspacePath || "未连接工作目录"}</span>
                        {codexRemoteDemoMode && quotaUserId ? <span className="shrink-0 rounded-full border border-black/10 bg-white/55 px-2 py-0.5 text-[11px] text-stone-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-stone-300">{quotaLabel}</span> : null}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-400 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setRequirementsOpen(true); }} aria-label="需求索引" title="需求索引">
                        <ListTodo className="size-4" />
                    </button>
                    <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-400 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void connect(); }} aria-label="连接" title="连接">
                        {connecting ? <LoaderCircle className="size-4 animate-spin" /> : connected ? <CheckCircle2 className="size-4" /> : <PlugZap className="size-4" />}
                    </button>
                    <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-400 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setSettingsOpen(true); }} aria-label="配置" title="配置">
                        <Settings2 className="size-4" />
                    </button>
                </div>
            </header>

            {connectionMessage ? (
                <div
                    className={[
                        "shrink-0 border-b px-4 py-2 text-xs leading-5",
                        connectionStatus === "connected"
                            ? "border-emerald-500/15 bg-emerald-500/10 text-emerald-800 dark:text-emerald-100"
                            : connectionStatus === "connecting"
                              ? "border-sky-500/15 bg-sky-500/10 text-sky-800 dark:text-sky-100"
                              : connectionStatus === "error"
                                ? "border-red-500/15 bg-red-500/10 text-red-800 dark:text-red-100"
                                : "border-amber-500/15 bg-amber-500/10 text-amber-800 dark:text-amber-100",
                    ].join(" ")}
                >
                    {connectionMessage}
                </div>
            ) : null}

            {codexBusy || runStatus || backgroundRunningCount ? (
                <div className="canvas-black-glass-sweep relative isolate shrink-0 overflow-hidden border-b border-sky-300/15 bg-[#111316] px-4 py-2 text-xs leading-5 shadow-[inset_0_1px_0_rgba(255,255,255,.05)] dark:border-white/10">
                    <span className="mobile-agent-thinking-sweep-text relative z-10 font-medium">
                        {runStatus || (codexBusy ? "Codex 后台执行中。切换会话不会停止电脑上的任务。" : `另有 ${backgroundRunningCount} 个会话正在后台执行，点回对应会话可查看进度。`)}
                    </span>
                </div>
            ) : null}

            <div ref={scrollerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
                <div className="mx-auto flex max-w-3xl flex-col gap-3">
                    {messages.length ? (
                        messages.map((message) => (
                            <article
                                key={message.id}
                                ref={(element) => {
                                    if (element) messageElementsRef.current.set(message.id, element);
                                    else messageElementsRef.current.delete(message.id);
                                }}
                                className={`group flex scroll-mt-5 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                            >
                                <div
                                    className={[
                                        "max-w-[90%] rounded-2xl px-4 py-3 text-[15px] leading-7 shadow-sm",
                                        message.role === "user"
                                            ? "bg-stone-950 text-white dark:bg-white dark:text-black"
                                            : message.role === "error"
                                              ? "border border-red-500/20 bg-red-500/10 text-red-900 dark:text-red-100"
                                              : message.role === "tool" || message.role === "status"
                                                ? "border border-black/10 bg-white/50 text-stone-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-stone-300"
                                                : "border border-black/10 bg-white/78 text-stone-900 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.07] dark:text-stone-100",
                                    ].join(" ")}
                                >
                                    {message.title ? <div className="mb-1 text-xs font-medium opacity-60">{message.title}</div> : null}
                                    <div className="whitespace-pre-wrap break-words">{message.text || "..."}</div>
                                    {message.role === "assistant" && message.text ? (
                                        <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs text-stone-400 transition hover:text-stone-700 dark:hover:text-stone-200" onClick={() => void copyMessage(message)}>
                                            {copiedId === message.id ? <CheckCircle2 className="size-3.5" /> : <Copy className="size-3.5" />}
                                            {copiedId === message.id ? "已复制" : "复制"}
                                        </button>
                                    ) : null}
                                </div>
                            </article>
                        ))
                    ) : (
                        <section className="flex min-h-[52vh] flex-col items-center justify-center text-center">
                            <div className="grid size-12 place-items-center rounded-2xl bg-stone-950 text-white shadow-sm dark:bg-white dark:text-black">
                                <FolderGit2 className="size-5" />
                            </div>
                            <h1 className="mt-5 text-2xl font-semibold">Codex Remote</h1>
                            <p className="mt-2 max-w-sm text-sm leading-6 text-stone-500 dark:text-stone-400">{connected ? "回复会显示在本页；电脑端窗口不一定实时同步。" : "连接电脑 Agent 后开始。"}</p>
                        </section>
                    )}
                </div>
            </div>

            {unreadCount > 0 ? (
                <button type="button" onClick={scrollToLatest} className="fixed bottom-24 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-sky-300/35 bg-[#0A84FF] px-3 py-2 text-xs font-semibold text-white shadow-[0_10px_30px_rgba(10,132,255,.38)] transition active:scale-95 dark:border-sky-300/25 dark:bg-[#0A84FF] dark:text-white">
                    <ChevronDown className="size-4" />
                    {unreadCount} 条新消息
                </button>
            ) : null}

            <form onSubmit={(event) => void submit(event)} className="shrink-0 border-t border-black/10 bg-white/72 p-3 backdrop-blur-xl dark:border-white/10 dark:bg-black/72">
                {codexBusy || runStatus || pendingGuides.length || visibleQueueTasks.length ? (
                    <div className="mx-auto mb-2 max-w-3xl rounded-2xl border border-black/10 bg-[#f9f8f4]/92 p-3 shadow-[0_10px_28px_rgba(23,21,19,.08)] dark:border-white/10 dark:bg-white/[0.06]">
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                {codexBusy || runStatus ? <LoaderCircle className="size-4 shrink-0 animate-spin text-sky-500" /> : <ListTodo className="size-4 shrink-0 text-stone-500 dark:text-stone-300" />}
                                <span className="truncate">{codexBusy || runStatus ? runStatus || (remoteBusy && !sending ? "当前会话运行中" : "Codex 后台执行中") : pendingGuides.length ? `${pendingGuides.length} 条待引导` : activeQueueCount ? `${activeQueueCount} 条任务排队中` : "任务队列"}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                {codexBusy || runStatus ? (
                                    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-red-600 transition hover:text-red-700 dark:text-red-300 dark:hover:text-red-200" onClick={() => void stopCurrentTurn()}>
                                        <Square className="size-3.5 fill-current" />
                                        停止
                                    </button>
                                ) : null}
                                {queuedTasks.some((task) => task.status === "done" || task.status === "failed") ? (
                                    <button type="button" className="text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100" onClick={clearFinishedQueue}>
                                        清理
                                    </button>
                                ) : null}
                            </div>
                        </div>

                        {pendingGuides.length ? (
                            <div className="mt-3 space-y-2">
                                {pendingGuides.map((pendingGuide, index) => {
                                    const steering = steeringGuideIds.includes(pendingGuide.id);
                                    return (
                                    <div key={pendingGuide.id} className="rounded-2xl border border-sky-400/25 bg-sky-500/[0.08] p-3 text-stone-900 shadow-[inset_0_1px_0_rgba(255,255,255,.45)] dark:border-sky-300/20 dark:bg-sky-300/[0.08] dark:text-stone-100">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700 dark:text-sky-200">待引导 #{index + 1}</div>
                                                <div className="mt-1 flex items-start gap-2">
                                                    <div className="min-w-0 flex-1 line-clamp-3 break-words text-sm leading-5">{pendingGuide.text}</div>
                                                    <div className="mt-0.5 flex shrink-0 items-center gap-1">
                                                        <button
                                                            type="button"
                                                            className="rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-xs font-semibold text-stone-700 shadow-[inset_0_1px_0_rgba(255,255,255,.65)] transition hover:bg-white active:scale-95 dark:border-white/10 dark:bg-white/[0.08] dark:text-stone-100 dark:hover:bg-white/[0.12]"
                                                            onClick={() => editPendingGuide(pendingGuide.id)}
                                                        >
                                                            修改
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="rounded-full bg-[#0A84FF] px-2.5 py-1 text-xs font-semibold text-white shadow-[0_6px_18px_rgba(10,132,255,.24)] transition hover:brightness-105 active:scale-95 disabled:cursor-wait disabled:opacity-65"
                                                            onClick={() => void confirmPendingGuide(pendingGuide.id)}
                                                            disabled={steering}
                                                        >
                                                            {steering ? "引导中" : "引导"}
                                                        </button>
                                                    </div>
                                                </div>
                                                {pendingGuide.attachments.length ? <div className="mt-1 text-xs text-stone-500 dark:text-stone-300">{attachmentSummary(pendingGuide.attachments)}</div> : null}
                                            </div>
                                            <button
                                                type="button"
                                                className="grid size-8 shrink-0 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.05] hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
                                                aria-label="取消待引导"
                                                onClick={() => clearPendingGuide(pendingGuide.id)}
                                            >
                                                <X className="size-4" />
                                            </button>
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>
                        ) : null}

                        {visibleQueueTasks.length ? (
                            <div className="mt-3 space-y-2">
                                {visibleQueueTasks.map((task, index) => (
                                    <div key={task.id} className="flex items-start gap-2 rounded-xl border border-black/10 bg-white/70 px-3 py-2.5 dark:border-white/10 dark:bg-black/20">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                                                {task.status === "running" ? <LoaderCircle className="size-3.5 animate-spin text-sky-500" /> : <Clock3 className="size-3.5" />}
                                                <span>#{index + 1}</span>
                                                <span
                                                    className={[
                                                        "rounded-full px-2 py-0.5",
                                                        task.status === "running"
                                                            ? "bg-sky-500/12 text-sky-700 dark:text-sky-200"
                                                            : task.status === "failed"
                                                              ? "bg-red-500/12 text-red-700 dark:text-red-200"
                                                              : "bg-black/[0.05] text-stone-600 dark:bg-white/[0.08] dark:text-stone-300",
                                                    ].join(" ")}
                                                >
                                                    {task.status === "running" ? "执行中" : task.status === "failed" ? "失败" : "待执行"}
                                                </span>
                                                {task.attachments.length ? <span>{attachmentSummary(task.attachments)}</span> : null}
                                            </div>
                                            <div className="mt-1 line-clamp-2 break-words text-sm leading-5 text-stone-900 dark:text-stone-100">{task.text}</div>
                                            {task.error ? <div className="mt-1 text-xs leading-5 text-red-700 dark:text-red-200">{task.error}</div> : null}
                                        </div>
                                        <button
                                            type="button"
                                            className="grid size-8 shrink-0 place-items-center rounded-xl text-stone-400 transition hover:bg-black/[0.04] hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-red-400/10 dark:hover:text-red-100"
                                            onClick={() => removeQueueTask(task.id)}
                                            disabled={task.status === "running"}
                                            aria-label={task.status === "running" ? "运行中不能取消" : "取消排队任务"}
                                            title={task.status === "running" ? "运行中不能从手机中止" : "取消排队"}
                                        >
                                            <X className="size-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {attachments.length ? (
                    <div className="mx-auto mb-2 flex max-w-3xl gap-2 overflow-x-auto">
                        {attachments.map((item, index) => (
                            <div key={`${item.name}-${index}`} className="relative size-16 shrink-0 overflow-hidden rounded-xl border border-black/10 bg-white dark:border-white/10 dark:bg-white/[0.06]">
                                {item.dataUrl && isImageAttachment(item) ? (
                                    <img src={item.dataUrl} alt={item.name || "attachment"} className="size-full object-cover" />
                                ) : (
                                    <div className="flex size-full flex-col items-center justify-center gap-1 px-1 text-stone-500 dark:text-stone-300" title={item.name}>
                                        <FileText className="size-5" />
                                        <span className="w-full truncate text-center text-[10px] font-semibold">{attachmentExtension(item)}</span>
                                    </div>
                                )}
                                <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/70 text-white" onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label="移除附件">
                                    <X className="size-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
                <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl border border-black/10 bg-[#f9f8f4] p-2 shadow-[0_12px_34px_rgba(23,21,19,.10)] dark:border-white/10 dark:bg-white/[0.06]">
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void pickImages(event)} />
                    <input ref={documentInputRef} type="file" accept={documentAccept} multiple className="hidden" onChange={(event) => void pickDocuments(event)} />
                    <button type="button" className="grid size-10 shrink-0 place-items-center rounded-2xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-300 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => fileInputRef.current?.click()} aria-label="添加图片" title="添加图片">
                        <ImagePlus className="size-4" />
                    </button>
                    <button type="button" className="grid size-10 shrink-0 place-items-center rounded-2xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-300 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => documentInputRef.current?.click()} aria-label="添加文档" title="添加文档">
                        <FileUp className="size-4" />
                    </button>
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                void submit();
                            }
                        }}
                        rows={1}
                        placeholder={attachmentsReading ? "正在读取附件..." : connected ? "让 Codex 继续做项目任务..." : "可以先输入，发送时会尝试连接电脑 Agent"}
                        className="max-h-36 min-h-10 flex-1 bg-transparent px-1 py-2 text-[16px] leading-6 outline-none placeholder:text-stone-400"
                    />
                    <button
                        type="button"
                        disabled={!canSend}
                        className="grid size-10 shrink-0 place-items-center rounded-2xl bg-[#0A84FF] text-white shadow-[0_8px_24px_rgba(10,132,255,.32)] transition enabled:hover:scale-[1.03] enabled:active:scale-95 disabled:bg-stone-300 disabled:text-stone-500 disabled:shadow-none dark:bg-[#0A84FF] dark:text-white dark:disabled:bg-white/10 dark:disabled:text-white/35"
                        aria-label={attachmentsReading ? "正在读取附件" : codexBusy ? "加入引导" : "发送"}
                        onClick={(event) => {
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        {attachmentsReading ? <LoaderCircle className="size-4 animate-spin" /> : codexBusy ? <Plus className="size-4" /> : <SendHorizontal className="size-4" />}
                    </button>
                </div>
            </form>

            {requirementsOpen ? (
                <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" onClick={() => setRequirementsOpen(false)}>
                    <section className="absolute inset-y-0 right-0 flex w-[min(92vw,390px)] flex-col border-l border-black/10 bg-[#f7f5ef] shadow-2xl dark:border-white/10 dark:bg-[#101010]" onClick={(event) => event.stopPropagation()}>
                        <div className="shrink-0 border-b border-black/10 p-4 dark:border-white/10">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h2 className="text-lg font-semibold">需求索引</h2>
                                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{requirementMessages.length ? `${requirementMessages.length} 条用户需求` : "当前会话还没有用户需求"}</p>
                                </div>
                                <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => setRequirementsOpen(false)} aria-label="关闭需求索引">
                                    <X className="size-4" />
                                </button>
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto p-4">
                            {requirementMessages.length ? (
                                <div className="space-y-2">
                                    {requirementMessages.map((message, index) => (
                                        <button
                                            key={message.id}
                                            type="button"
                                            className="block w-full rounded-2xl border border-black/10 bg-white/70 px-3 py-3 text-left transition hover:border-sky-400/35 hover:bg-sky-50 dark:border-white/10 dark:bg-white/[0.05] dark:hover:bg-sky-400/10"
                                            onClick={() => scrollToRequirement(message.id)}
                                        >
                                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-400 dark:text-stone-500">#{index + 1}</div>
                                            <div className="line-clamp-3 text-sm leading-5 text-stone-900 dark:text-stone-100">{message.text}</div>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="rounded-2xl bg-black/[0.04] px-4 py-5 text-sm leading-6 text-stone-500 dark:bg-white/[0.05] dark:text-stone-400">发送需求后会自动出现在这里。</div>
                            )}
                        </div>
                    </section>
                </div>
            ) : null}

            {threadsOpen ? (
                <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" onClick={() => setThreadsOpen(false)}>
                    <section className="absolute inset-y-0 left-0 flex w-[min(92vw,430px)] flex-col border-r border-black/10 bg-[#f7f5ef] shadow-2xl dark:border-white/10 dark:bg-[#101010]" onClick={(event) => event.stopPropagation()}>
                        <div className="shrink-0 border-b border-black/10 p-4 dark:border-white/10">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h2 className="text-lg font-semibold">项目与会话</h2>
                                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">选择项目、继续会话或新增自己的入口。</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={startAddProject} aria-label="新增项目">
                                        <Plus className="size-4" />
                                    </button>
                                    <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => setThreadsOpen(false)} aria-label="关闭">
                                        <X className="size-4" />
                                    </button>
                                </div>
                            </div>
                            <div className="mt-4 flex gap-2">
                                <input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder="搜索项目与会话" className="h-11 min-w-0 flex-1 rounded-xl border border-black/10 bg-white px-3 text-stone-950 outline-none placeholder:text-stone-400 focus:border-stone-500 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100" />
                                <button type="button" className="grid size-11 place-items-center rounded-xl border border-black/10 bg-white text-stone-600 disabled:opacity-45 dark:border-white/10 dark:bg-[#181818] dark:text-stone-300" onClick={() => void refreshThreads()} disabled={threadsLoading || !settings.agentUrl.trim() || !settings.token.trim()} aria-label="刷新会话">
                                    <RefreshCcw className={`size-4 ${threadsLoading ? "animate-spin" : ""}`} />
                                </button>
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2">
                                <button type="button" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-sm font-medium disabled:opacity-45 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100" onClick={() => void refreshWorkspaceProjects()} disabled={projectsLoading || !settings.agentUrl.trim() || !settings.token.trim()}>
                                    <RefreshCcw className={`size-4 ${projectsLoading ? "animate-spin" : ""}`} />
                                    发现
                                </button>
                                <button type="button" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-sm font-medium disabled:opacity-45 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100" onClick={() => void connect()}>
                                    <PlugZap className="size-4" />
                                    连接
                                </button>
                                <button type="button" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-sm font-medium disabled:opacity-45 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100" onClick={() => void newThread()} disabled={!connected}>
                                    <RotateCcw className="size-4" />
                                    新对话
                                </button>
                            </div>
                            {threadError ? <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-800 dark:text-red-100">{threadError}</div> : null}
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto p-4">
                            {projectFormOpen ? (
                                <div className="mb-4 rounded-2xl border border-black/10 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.05]">
                                    <div className="mb-3 flex items-center justify-between gap-2">
                                        <div className="text-sm font-semibold">{editingProjectId ? "编辑项目" : "新增项目"}</div>
                                        <button type="button" className="grid size-8 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => { setProjectFormOpen(false); setEditingProjectId(""); setProjectDraft(emptyProjectDraft); }} aria-label="取消">
                                            <X className="size-4" />
                                        </button>
                                    </div>
                                    <div className="space-y-3">
                                        <label className="block">
                                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">名称</span>
                                            <input value={projectDraft.label} onChange={(event) => setProjectDraft((value) => ({ ...value, label: event.target.value }))} placeholder="我的项目" className="mt-1 h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-[#181818]" />
                                        </label>
                                        <label className="block">
                                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">Workspace</span>
                                            <input value={projectDraft.workspacePath} onChange={(event) => setProjectDraft((value) => ({ ...value, workspacePath: event.target.value }))} placeholder="D:\project" className="mt-1 h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-[#181818]" />
                                        </label>
                                        <label className="block">
                                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">Codex Thread ID</span>
                                            <input value={projectDraft.threadId} onChange={(event) => setProjectDraft((value) => ({ ...value, threadId: event.target.value }))} placeholder="codex://threads/019f..." className="mt-1 h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-[#181818]" />
                                        </label>
                                        <div className="grid grid-cols-2 gap-2">
                                            <label className="block">
                                                <span className="text-xs font-medium text-stone-500 dark:text-stone-400">Workspace ID</span>
                                                <input value={projectDraft.canvasId} onChange={(event) => setProjectDraft((value) => ({ ...value, canvasId: event.target.value }))} placeholder="自动" className="mt-1 h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-[#181818]" />
                                            </label>
                                            <label className="block">
                                                <span className="text-xs font-medium text-stone-500 dark:text-stone-400">Git Repo</span>
                                                <input value={projectDraft.gitRepoPath} onChange={(event) => setProjectDraft((value) => ({ ...value, gitRepoPath: event.target.value }))} placeholder="可留空" className="mt-1 h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-[#181818]" />
                                            </label>
                                        </div>
                                    </div>
                                    <button type="button" className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-stone-950 px-4 text-sm font-medium text-white transition hover:bg-stone-800 dark:bg-[#0A84FF] dark:hover:bg-[#2F9BFF]" onClick={saveProject}>
                                        <CheckCircle2 className="size-4" />
                                        保存
                                    </button>
                                </div>
                            ) : null}

                            <div className="mb-2 flex items-center justify-between gap-2 px-1">
                                <div className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500 dark:text-stone-400">项目</div>
                                <button type="button" className="inline-flex h-8 items-center gap-1 rounded-xl px-2 text-xs font-medium text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-400 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={startAddProject}>
                                    <Plus className="size-3.5" />
                                    新增
                                </button>
                            </div>
                            <div className="space-y-3">
                                {projects.map((project) => {
                                    const projectActive = activeProject?.id === project.id;
                                    const projectExpanded = expandedProjectId === project.id;
                                    const switchDisabled = codexBusy || Boolean(pendingPromptRef.current);
                                    const projectThreadGroups = groupedThreads
                                        .map((group) => ({ ...group, threads: group.threads.filter((thread) => !thread.cwd || !project.workspacePath || samePath(thread.cwd, project.workspacePath)) }))
                                        .filter((group) => group.threads.length);
                                    return (
                                        <div key={project.id} className="space-y-2">
                                            <div
                                                className={[
                                                    "flex gap-2 rounded-xl border p-2 transition",
                                                    projectActive
                                                        ? "border-sky-500/45 bg-sky-500/12 text-stone-950 shadow-[0_10px_28px_rgba(14,165,233,.14)] dark:border-sky-400/45 dark:bg-[#0d2631] dark:text-stone-50"
                                                        : projectExpanded
                                                          ? "border-sky-400/30 bg-sky-500/[0.06] text-stone-900 dark:border-sky-400/25 dark:bg-sky-400/[0.06] dark:text-stone-100"
                                                        : "border-black/10 bg-white/70 text-stone-900 hover:border-sky-300/45 hover:bg-sky-50 dark:border-white/10 dark:bg-[#151515] dark:text-stone-100 dark:hover:border-sky-400/30 dark:hover:bg-sky-400/10",
                                                ].join(" ")}
                                            >
                                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpandedProjectId((value) => (value === project.id ? "" : project.id))} aria-expanded={projectExpanded}>
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="truncate text-sm font-semibold">{project.label}</span>
                                                        {projectActive ? <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-100">当前</span> : null}
                                                    </div>
                                                    <div className="mt-1 truncate text-xs opacity-65">{project.workspacePath}</div>
                                                    <div className="mt-1 truncate text-[11px] opacity-50">{project.threadId || "未指定默认会话"}</div>
                                                </button>
                                                <div className="flex shrink-0 flex-col gap-1">
                                                    <button type="button" className="grid size-8 place-items-center rounded-xl text-stone-400 transition hover:bg-black/[0.04] hover:text-stone-950 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => startEditProject(project)} aria-label="编辑项目">
                                                        <Pencil className="size-3.5" />
                                                    </button>
                                                    <button type="button" className="grid size-8 place-items-center rounded-xl text-stone-400 transition hover:bg-black/[0.04] hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-400/10 dark:hover:text-red-100" onClick={() => deleteProject(project)} disabled={switchDisabled} aria-label="删除项目">
                                                        <Trash2 className="size-3.5" />
                                                    </button>
                                                </div>
                                            </div>

                                            {projectExpanded ? (
                                                <div className="ml-3 space-y-2 border-l border-black/10 pl-3 dark:border-white/10">
                                                    {project.threadId ? (
                                                        <button
                                                            type="button"
                                                            className={[
                                                                "block w-full rounded-xl border px-3 py-2.5 text-left transition",
                                                                project.threadId === activeThreadId
                                                                    ? "border-sky-500/35 bg-sky-500/10 text-stone-950 dark:border-sky-400/35 dark:bg-sky-400/10 dark:text-stone-50"
                                                                    : "border-black/10 bg-white/60 text-stone-800 hover:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-stone-200 dark:hover:bg-sky-400/10",
                                                            ].join(" ")}
                                                            onClick={() => void selectProject(project)}
                                                        >
                                                            <div className="flex items-center justify-between gap-2 text-sm font-medium leading-5">
                                                                <span>默认会话</span>
                                                                {runningThreadIds.includes(project.threadId) ? <span className="mobile-agent-thinking-sweep-text text-[11px]">执行中</span> : null}
                                                            </div>
                                                            <div className="mt-1 truncate text-[11px] opacity-55">{project.threadId}</div>
                                                        </button>
                                                    ) : null}

                                                    {projectThreadGroups.map((group) => {
                                                        const groupThreads = group.threads.filter((thread) => thread.id !== project.threadId);
                                                        if (!groupThreads.length) return null;
                                                        return (
                                                            <div key={group.key} className="space-y-2">
                                                                <div className="px-1 pt-1">
                                                                    <div className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-500 dark:text-stone-400">{group.label}</div>
                                                                    <div className="truncate text-[11px] leading-4 text-stone-400 dark:text-stone-500">{group.path}</div>
                                                                </div>
                                                                {groupThreads.map((thread) => (
                                                                    <button
                                                                        key={thread.id}
                                                                        type="button"
                                                                        className={[
                                                                            "block w-full rounded-xl border px-3 py-2.5 text-left transition",
                                                                            thread.id === activeThreadId
                                                                                ? "border-sky-500/35 bg-sky-500/10 text-stone-950 dark:border-sky-400/35 dark:bg-sky-400/10 dark:text-stone-50"
                                                                                : "border-black/10 bg-white/60 text-stone-800 hover:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-stone-200 dark:hover:bg-sky-400/10",
                                                                        ].join(" ")}
                                                                        onClick={() => void selectThread(thread)}
                                                                    >
                                                                        <div className="flex items-start justify-between gap-2 text-sm font-medium leading-5">
                                                                            <span className="line-clamp-2">{threadTitle(thread)}</span>
                                                                            {runningThreadIds.includes(thread.id) || threadIsBusy(thread.status) ? <span className="mobile-agent-thinking-sweep-text shrink-0 text-[11px]">执行中</span> : null}
                                                                        </div>
                                                                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] opacity-55">
                                                                            <span className="truncate">{thread.id}</span>
                                                                            <span className="shrink-0">{formatThreadTime(thread.updatedAt || thread.createdAt)}</span>
                                                                        </div>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        );
                                                    })}

                                                    {!projectThreadGroups.length ? <div className="rounded-xl bg-black/[0.04] px-3 py-3 text-xs leading-5 text-stone-500 dark:bg-white/[0.05] dark:text-stone-400">连接或刷新后，会列出这个项目 workspace 下的其他 Codex 会话。</div> : null}
                                                </div>
                                            ) : null}
                                        </div>
                                    );
                                })}
                                {!projects.length ? <div className="rounded-xl bg-black/[0.04] px-3 py-4 text-center text-xs leading-5 text-stone-500 dark:bg-white/[0.05] dark:text-stone-400">还没有项目。点“新增”添加一个 Workspace。</div> : null}
                            </div>
                        </div>
                    </section>
                </div>
            ) : null}

            {settingsOpen ? (
                <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" onClick={() => setSettingsOpen(false)}>
                    <section className="absolute bottom-0 left-0 right-0 max-h-[88vh] overflow-y-auto rounded-t-[1.75rem] border border-black/10 bg-[#f7f5ef] p-5 shadow-2xl sm:left-auto sm:top-0 sm:h-full sm:w-[430px] sm:rounded-none dark:border-white/10 dark:bg-[#101010]" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-semibold">连接配置</h2>
                            <button type="button" className="grid size-9 place-items-center rounded-xl text-stone-500 transition hover:bg-black/[0.04] hover:text-stone-950 dark:hover:bg-sky-400/10 dark:hover:text-sky-100" onClick={() => setSettingsOpen(false)} aria-label="关闭">
                                <X className="size-4" />
                            </button>
                        </div>

                        <div className="mt-5 space-y-4">
                            <div className="rounded-2xl border border-black/10 bg-white/60 p-3 text-sm leading-6 dark:border-white/10 dark:bg-white/[0.05]">
                                <div className="font-medium">自托管模式</div>
                                <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">这个页面只连接你自己电脑上的 Codex Remote Bridge；连接配置只保存在当前浏览器中。</p>
                            </div>
                            <p className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-100">
                                Agent URL 是电脑上 Codex Remote Bridge 的 HTTPS 服务地址，不是静态 Web 页面地址、New API 地址或创作 Agent API。不要把 17372 端口无鉴权裸露到公网。
                            </p>
                            <label className="block">
                                <span className="text-sm font-medium">Agent URL</span>
                                <input value={settings.agentUrl} onChange={(event) => updateSettings({ agentUrl: event.target.value })} placeholder="https://your-codex-bridge.example.com" className="mt-2 h-11 w-full rounded-xl border border-black/10 bg-white px-3 outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]" />
                                <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">填 cloudflared / Tailscale / VPS 反代出的 Codex Remote Bridge 地址。</span>
                            </label>
                            <label className="block">
                                <span className="text-sm font-medium">Token</span>
                                <input value={settings.token} onChange={(event) => updateSettings({ token: event.target.value })} type="password" autoComplete="new-password" className="mt-2 h-11 w-full rounded-xl border border-black/10 bg-white px-3 outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]" />
                                <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">本机 Agent 启动输出的 Connect token，不是 Codex API Key。</span>
                            </label>
                            <p className="rounded-2xl border border-sky-500/15 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-800 dark:text-sky-100">
                                只填上面两项即可。连接成功后会自动列出电脑上的项目；展开项目后，点击具体会话即可进入。
                            </p>

                            <div className="rounded-2xl border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-white/[0.05]">
                                <div className="text-sm font-medium">接收内容</div>
                                <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-black/[0.05] p-1 dark:bg-black/30">
                                    {([
                                        ["full", "完整"],
                                        ["text", "仅文字"],
                                        ["final", "仅最终"],
                                    ] as const).map(([value, label]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            className={`h-9 rounded-lg text-xs font-semibold transition ${settings.receiveMode === value ? "bg-white text-stone-950 shadow-sm dark:bg-white/15 dark:text-white" : "text-stone-500 hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}`}
                                            onClick={() => updateSettings({ receiveMode: value })}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                                    {settings.receiveMode === "full" ? "显示回复、命令、文件变更和工具过程。" : settings.receiveMode === "text" ? "只显示 Codex 文字回复，隐藏命令和工具过程。" : "运行时只显示状态，完成后同步每轮最后一条回复。"}
                                </p>
                            </div>

                            <details className="rounded-2xl border border-black/10 bg-white/60 p-3 text-sm dark:border-white/10 dark:bg-white/[0.05]">
                                <summary className="cursor-pointer select-none font-medium">高级：手动指定会话 / 模型</summary>
                                <div className="mt-4 space-y-4">
                                    <label className="block">
                                        <span className="text-sm font-medium">Workspace</span>
                                        <input value={settings.workspacePath} onChange={(event) => updateSettings({ workspacePath: event.target.value })} placeholder="可留空" className="mt-2 h-11 w-full rounded-xl border border-black/10 bg-white px-3 outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]" />
                                        <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">留空使用 agent 已保存的工作区。指定 Codex 会话时，Workspace 必须和该会话的 cwd 一致。</span>
                                    </label>
                                    <label className="block">
                                        <span className="text-sm font-medium">Workspace ID</span>
                                        <input value={settings.canvasId} onChange={(event) => updateSettings({ canvasId: event.target.value })} placeholder="default 或项目名" className="mt-2 h-11 w-full rounded-xl border border-black/10 bg-white px-3 outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]" />
                                        <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">只用于区分本机项目分桶，不是 Codex 会话；通常填写项目名即可。</span>
                                    </label>
                                    <label className="block">
                                        <span className="text-sm font-medium">Codex Thread ID</span>
                                        <input value={settings.threadId} onChange={(event) => updateSettings({ threadId: event.target.value })} placeholder="codex://threads/019f..." className="mt-2 h-11 w-full rounded-xl border border-black/10 bg-white px-3 outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]" />
                                        <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">要继续指定 Codex 会话就填这里；可填完整 codex://threads/... 或只填 ID。</span>
                                    </label>
                                    <div>
                                        <div className="flex items-center gap-2 text-sm font-medium">
                                            <Settings2 className="size-4" />
                                            模型与强度
                                        </div>
                                        <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">留空则沿用电脑 Codex 默认设置；填写后会传给本机 Codex app-server。</p>
                                        <div className="mt-3 grid grid-cols-2 gap-2">
                                            <input value={settings.model} onChange={(event) => updateSettings({ model: event.target.value })} placeholder="模型 ID（可留空）" className="h-11 rounded-xl border border-black/10 bg-white/60 px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]" />
                                            <select value={settings.effort} onChange={(event) => updateSettings({ effort: event.target.value })} className="h-11 rounded-xl border border-black/10 bg-white/60 px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-white/[0.06]">
                                                <option value="">沿用默认强度</option>
                                                <option value="low">low</option>
                                                <option value="medium">medium</option>
                                                <option value="high">high</option>
                                                <option value="xhigh">xhigh</option>
                                            </select>
                                        </div>
                                        <button type="button" className="mt-2 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-black/10 bg-white/70 px-3 text-sm font-medium text-stone-700 transition hover:bg-white disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-stone-200 dark:hover:bg-white/10" onClick={() => void restoreCodexDefaults()} disabled={resettingModelSettings}>
                                            {resettingModelSettings ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                                            使用电脑默认
                                        </button>
                                    </div>
                                </div>
                            </details>

                            <div className="rounded-2xl border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-white/[0.05]">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="flex items-center gap-2 text-sm font-medium">
                                            <GitBranch className="size-4" />
                                            本机 Git 仓库
                                        </div>
                                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">手机 push 只推已提交 HEAD，不会自动 add/commit。</div>
                                    </div>
                                    <button type="button" className="grid size-9 shrink-0 place-items-center rounded-xl border border-black/10 bg-white text-stone-600 transition hover:text-stone-950 disabled:opacity-45 dark:border-white/10 dark:bg-white/[0.06] dark:text-stone-300" onClick={() => void refreshGitRepos()} disabled={reposLoading || !settings.agentUrl.trim() || !settings.token.trim()} aria-label="刷新仓库">
                                        <RefreshCcw className={`size-4 ${reposLoading ? "animate-spin" : ""}`} />
                                    </button>
                                </div>
                                <select value={settings.gitRepoPath} onChange={(event) => updateSettings({ gitRepoPath: event.target.value })} className="mt-3 h-11 w-full rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:border-stone-500 dark:border-white/10 dark:bg-[#151515]">
                                    <option value="">选择要推送的仓库</option>
                                    {repos.map((repo) => (
                                        <option key={repo.repoPath} value={repo.repoPath}>
                                            {repoName(repo.repoPath)} - {repo.branch}
                                        </option>
                                    ))}
                                </select>
                                {selectedRepo ? (
                                    <div className="mt-3 space-y-2 text-xs leading-5 text-stone-600 dark:text-stone-300">
                                        <div className="break-all rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">{selectedRepo.repoPath}</div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">当前分支：{selectedRepo.branch}</div>
                                            <div className="rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">推送目标：{selectedRepo.defaultRemote || "origin"}/{selectedRepo.defaultBranch || "main"}</div>
                                        </div>
                                        {selectedRepo.remotes[0] ? <div className="break-all rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">远程：{selectedRepo.remotes[0].url}</div> : null}
                                        {selectedRepo.statusShort.length ? <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-100">未提交改动：{selectedRepo.statusShort.length} 条。手机 push 不会把这些改动带上。</div> : null}
                                        {selectedRepo.warnings.map((warning) => (
                                            <div key={warning} className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-red-800 dark:text-red-100">
                                                {warning}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="mt-3 rounded-xl bg-black/[0.04] px-3 py-2 text-xs leading-5 text-stone-500 dark:bg-white/[0.05] dark:text-stone-400">{repoError || "连接后会自动扫描本机仓库，也可以点刷新。"}</div>
                                )}
                            </div>
                        </div>

                        {connectionMessage || connecting ? (
                            <div
                                className={[
                                    "mt-5 flex items-start gap-2 rounded-2xl border px-3 py-2 text-xs leading-5",
                                    connectionStatus === "connected"
                                        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-100"
                                        : connectionStatus === "connecting"
                                          ? "border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-100"
                                          : connectionStatus === "error"
                                            ? "border-red-500/20 bg-red-500/10 text-red-800 dark:text-red-100"
                                            : "border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-100",
                                ].join(" ")}
                            >
                                {connecting ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" /> : connectionStatus === "connected" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <PlugZap className="mt-0.5 size-4 shrink-0" />}
                                <span>{connectionMessage || (connecting ? "正在连接电脑 Agent..." : "等待连接")}</span>
                            </div>
                        ) : null}

                        <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                className={[
                                    "inline-flex h-11 items-center justify-center gap-2 rounded-xl border text-sm font-medium transition disabled:cursor-wait",
                                    connecting
                                        ? "border-sky-500/25 bg-sky-500/12 text-sky-800 dark:text-sky-100"
                                        : connectionStatus === "connected"
                                          ? "border-emerald-500/25 bg-emerald-500/12 text-emerald-800 hover:bg-emerald-500/16 dark:text-emerald-100"
                                          : connectionStatus === "error"
                                            ? "border-red-500/25 bg-red-500/10 text-red-800 hover:bg-red-500/14 dark:text-red-100"
                                            : "border-black/10 bg-white hover:bg-sky-50 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100 dark:hover:bg-sky-400/10",
                                ].join(" ")}
                                onClick={() => void connect()}
                                disabled={connecting}
                                aria-busy={connecting}
                            >
                                {connecting ? <LoaderCircle className="size-4 animate-spin" /> : connectionStatus === "connected" ? <CheckCircle2 className="size-4" /> : <PlugZap className="size-4" />}
                                {connecting ? "正在连接..." : connectionStatus === "connected" ? "已连接" : connectionStatus === "error" ? "重试连接" : "连接"}
                            </button>
                            <button type="button" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-sm font-medium transition hover:bg-sky-50 disabled:opacity-45 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100 dark:hover:bg-sky-400/10" onClick={() => void newThread()} disabled={!connected}>
                                <RotateCcw className="size-4" />
                                新对话
                            </button>
                            <button type="button" className="col-span-2 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-sm font-medium transition hover:bg-sky-50 disabled:opacity-45 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100 dark:hover:bg-sky-400/10" onClick={() => void pushCurrentCommit()} disabled={pushing || !settings.agentUrl.trim() || !settings.token.trim()}>
                                {pushing ? <LoaderCircle className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
                                推送所选仓库已提交 HEAD
                            </button>
                            <button type="button" className="col-span-2 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/10 bg-white text-sm font-medium transition hover:bg-red-50 hover:text-red-700 dark:border-white/10 dark:bg-[#181818] dark:text-stone-100 dark:hover:bg-red-400/10 dark:hover:text-red-100" onClick={() => setMessages([])}>
                                <Trash2 className="size-4" />
                                清空消息
                            </button>
                        </div>
                    </section>
                </div>
            ) : null}
        </main>
    );
}
