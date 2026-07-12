import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";
import { preview } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "public", "screenshots");
await fs.mkdir(outputDir, { recursive: true });

const settings = {
  agentUrl: "https://agent.example.com",
  token: "screenshot-token",
  canvasId: "storefront",
  threadId: "thread-a",
  workspacePath: "D:\\projects\\storefront",
  gitRepoPath: "D:\\projects\\storefront",
  model: "gpt-5.4",
  effort: "high",
  receiveMode: "full",
};

const workspace = {
  workspaceId: "storefront",
  canvasId: "storefront",
  workspacePath: "D:\\projects\\storefront",
  activeThreadId: "thread-a",
  model: "gpt-5.4",
  effort: "high",
};

const projects = [
  { id: "storefront", label: "storefront", workspaceId: "storefront", canvasId: "storefront", workspacePath: "D:\\projects\\storefront", threadId: "thread-a", gitRepoPath: "D:\\projects\\storefront" },
  { id: "api-service", label: "api-service", workspaceId: "api-service", canvasId: "api-service", workspacePath: "D:\\projects\\api-service", threadId: "thread-b", gitRepoPath: "D:\\projects\\api-service" },
  { id: "design-system", label: "design-system", workspaceId: "design-system", canvasId: "design-system", workspacePath: "D:\\projects\\design-system", threadId: "thread-c", gitRepoPath: "D:\\projects\\design-system" },
];

const threads = [
  { id: "thread-a", name: "修复移动端登录布局", preview: "检查移动端登录状态，并修复小屏幕下按钮重叠", cwd: "D:\\projects\\storefront", status: "running", updatedAt: Date.now() },
  { id: "thread-a2", name: "商品列表性能", preview: "定位首屏渲染慢的问题", cwd: "D:\\projects\\storefront", status: "completed", updatedAt: Date.now() - 86_400_000 },
  { id: "thread-a3", name: "支付回调测试", preview: "补充 webhook 幂等性测试", cwd: "D:\\projects\\storefront", status: "completed", updatedAt: Date.now() - 172_800_000 },
  { id: "thread-b", name: "完善接口鉴权", preview: "补齐 token 轮换和错误处理", cwd: "D:\\projects\\api-service", status: "completed", updatedAt: Date.now() - 259_200_000 },
];

const messages = [
  { id: "m1", role: "user", text: "检查移动端登录状态，并修复小屏幕下按钮重叠。" },
  { id: "m2", role: "tool", title: "读取文件", text: "src/pages/login.tsx\nsrc/styles/mobile.css" },
  { id: "m3", role: "assistant", title: "Codex", text: "已定位到操作区使用固定宽度。我把它改成两列自适应布局，并补了 390px 视口测试。" },
  { id: "m4", role: "user", text: "构建通过后，再检查暗色模式和输入框安全区。" },
  { id: "m5", role: "assistant", title: "Codex", text: "构建和类型检查均已通过，暗色模式与底部安全区也已完成回归验证。" },
];
const pendingPrompt = "继续检查移动端布局";
const thinkingMessages = [...messages, { id: "m6", role: "user", text: pendingPrompt }];

const repos = [
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

const server = await preview({
  root,
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});

let browser;
try {
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ channel: "msedge", headless: true });
  }

  async function createPage({ queue = [], guides = [], busy = false, agentHandler = null } = {}) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
      locale: "zh-CN",
    });

    await page.addInitScript(({ initialSettings, initialProjects, initialMessages, initialQueue, initialGuides, initialBusy, initialPendingPrompt }) => {
      localStorage.setItem("infinite-canvas:theme_store", JSON.stringify({ state: { theme: "dark" } }));
      localStorage.setItem("codex-remote-mobile:settings", JSON.stringify(initialSettings));
      localStorage.setItem("codex-remote-mobile:projects", JSON.stringify(initialProjects));
      localStorage.setItem("codex-remote-mobile:active-project", "storefront");
      localStorage.setItem("codex-remote-mobile:messages", JSON.stringify(initialMessages));
      localStorage.setItem("codex-remote-mobile:messages:storefront", JSON.stringify(initialMessages));
      localStorage.setItem("codex-remote-mobile:task-queue", JSON.stringify(initialQueue));
      if (initialGuides.length) localStorage.setItem("codex-remote-mobile:pending-guide", JSON.stringify(initialGuides));
      if (initialBusy) localStorage.setItem("codex-remote-mobile:pending-run", JSON.stringify({ threadId: "thread-a", canvasId: "storefront", prompt: initialPendingPrompt, startedAt: Date.now() }));
    }, { initialSettings: settings, initialProjects: projects, initialMessages: messages, initialQueue: queue, initialGuides: guides, initialBusy: busy, initialPendingPrompt: pendingPrompt });

    await page.route("https://agent.example.com/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const customResponse = await agentHandler?.({ request, url, headers });
      if (customResponse) return route.fulfill(customResponse);
      if (url.pathname === "/agent/codex/workspace") return route.fulfill({ status: 200, headers, json: { ok: true, workspace } });
      if (url.pathname === "/agent/codex/workspaces") return route.fulfill({ status: 200, headers, json: { ok: true, projects, data: threads } });
      if (url.pathname === "/agent/codex/threads") return route.fulfill({ status: 200, headers, json: { ok: true, workspace, data: threads.filter((item) => item.cwd === workspace.workspacePath) } });
      if (url.pathname === "/agent/codex/status") return route.fulfill({ status: 200, headers, json: { ok: true, workspace, busy, canSteer: busy, activeTurnId: busy ? "turn-a" : "", thread: threads[0] } });
      if (url.pathname === "/agent/git/repos") return route.fulfill({ status: 200, headers, json: { ok: true, workspace, repos } });
      if (url.pathname.startsWith("/agent/codex/threads/")) return route.fulfill({ status: 200, headers, json: { ok: true, workspace, messages: busy ? thinkingMessages : messages, busy } });
      return route.fulfill({ status: 200, headers, json: { ok: true } });
    });

    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await page.getByText("Codex Remote", { exact: true }).first().waitFor();
    return page;
  }

  async function capture(page, filename) {
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`${filename} has ${overflow}px horizontal overflow`);
    await page.screenshot({ path: path.join(outputDir, filename), fullPage: false });
    await page.close();
    console.log(`Captured ${filename}`);
  }

  let page = await createPage();
  await capture(page, "02-mobile-chat.png");

  page = await createPage({
    queue: [
      { id: "q1", text: "构建通过后再检查暗色模式。", attachments: [], createdAt: Date.now(), status: "queued" },
      { id: "q2", text: "最后整理提交说明并推送分支。", attachments: [], createdAt: Date.now() + 1, status: "queued" },
    ],
    guides: [{ id: "g1", text: "先修复按钮重叠，暂时不要调整页面配色。", attachments: [], createdAt: Date.now() }],
  });
  const chatShot = await fs.readFile(path.join(outputDir, "02-mobile-chat.png"));
  const fileInputs = page.locator('input[type="file"]');
  await fileInputs.nth(0).setInputFiles({ name: "mobile-reference.png", mimeType: "image/png", buffer: chatShot });
  await fileInputs.nth(1).setInputFiles({ name: "acceptance-checklist.md", mimeType: "text/markdown", buffer: Buffer.from("# 验收清单\n\n- 检查 390px 布局\n- 检查暗色模式\n") });
  await page.locator("textarea").fill("结合截图和验收文档继续检查 390px 页面");
  await capture(page, "04-attachments-queue.png");

  page = await createPage({ busy: true });
  await page.locator(".mobile-agent-thinking-sweep-text").waitFor();
  await page.waitForTimeout(650);
  await capture(page, "09-thinking-effect.png");

  page = await createPage();
  await page.getByRole("button", { name: "需求索引" }).click();
  await page.getByRole("heading", { name: "需求索引" }).waitFor();
  await capture(page, "06-requirements-index.png");

  page = await createPage();
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  await page.getByRole("heading", { name: "项目与会话" }).waitFor();
  const conversationNavigationRequests = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/agent/codex/threads/new" || pathname.endsWith("/resume")) conversationNavigationRequests.push(pathname);
  });
  const apiProjectButton = page.locator('button[aria-expanded]').filter({ hasText: "api-service" });
  await apiProjectButton.click();
  await page.waitForTimeout(250);
  const projectClickState = await page.evaluate(() => ({
    activeProjectId: localStorage.getItem("codex-remote-mobile:active-project"),
    settings: JSON.parse(localStorage.getItem("codex-remote-mobile:settings") || "{}"),
  }));
  if ((await apiProjectButton.getAttribute("aria-expanded")) !== "true") throw new Error("Project card did not expand");
  if (!(await page.getByRole("heading", { name: "项目与会话" }).isVisible())) throw new Error("Project card click closed the drawer");
  if (projectClickState.activeProjectId !== "storefront" || projectClickState.settings.threadId !== "thread-a") throw new Error("Project card click switched the active conversation");
  if (conversationNavigationRequests.length) throw new Error(`Project card click requested conversation navigation: ${conversationNavigationRequests.join(", ")}`);
  await apiProjectButton.click();
  await page.locator('button[aria-expanded]').filter({ hasText: "storefront" }).click();
  await page.getByText("商品列表性能", { exact: true }).waitFor();
  await capture(page, "03-workspaces-threads.png");

  page = await createPage();
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  await page.getByRole("button", { name: "新增项目" }).click();
  await page.getByText("新增项目", { exact: true }).waitFor();
  await capture(page, "07-project-editor.png");

  page = await createPage();
  await page.getByRole("button", { name: "配置" }).click();
  await page.getByRole("heading", { name: "连接配置" }).waitFor();
  await capture(page, "01-fixed-url.png");

  page = await createPage();
  await page.getByRole("button", { name: "配置" }).click();
  const advanced = page.locator("details");
  await advanced.locator("summary").click();
  await advanced.scrollIntoViewIfNeeded();
  await capture(page, "08-model-settings.png");

  page = await createPage();
  await page.getByRole("button", { name: "配置" }).click();
  await page.getByRole("button", { name: "刷新仓库" }).click();
  await page.getByText("当前分支：codex/mobile-login", { exact: true }).waitFor();
  await page.getByRole("button", { name: "推送所选仓库已提交 HEAD" }).scrollIntoViewIfNeeded();
  await capture(page, "05-git-push.png");

  const delayedPrompt = "验证旧同步记录不会覆盖这条新指令";
  const delayedReply = "新一轮记录已经同步完成。";
  let turnAccepted = false;
  let historyComplete = false;
  page = await createPage({
    agentHandler: async ({ request, url, headers }) => {
      if (url.pathname === "/agent/codex/turn" && request.method() === "POST") {
        turnAccepted = true;
        return { status: 200, headers, json: { ok: true, threadId: "thread-a" } };
      }
      if (turnAccepted && url.pathname === "/agent/codex/threads/thread-a" && request.method() === "GET") {
        return {
          status: 200,
          headers,
          json: {
            ok: true,
            workspace,
            busy: !historyComplete,
            messages: historyComplete
              ? [...messages, { id: "m-delayed-user", role: "user", text: delayedPrompt }, { id: "m-delayed-reply", role: "assistant", title: "Codex", text: delayedReply }]
              : messages,
          },
        };
      }
      return null;
    },
  });
  await page.locator("textarea").fill(delayedPrompt);
  const turnRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/agent/codex/turn");
  await page.getByRole("button", { name: "发送" }).click();
  await turnRequest;
  await page.getByText(delayedPrompt, { exact: true }).waitFor({ timeout: 750 });
  await page.waitForTimeout(2800);
  if (!(await page.getByText(delayedPrompt, { exact: true }).isVisible())) throw new Error("Pending user message disappeared after a stale thread sync");
  const pendingRunStillStored = await page.evaluate(() => Boolean(localStorage.getItem("codex-remote-mobile:pending-run")));
  if (!pendingRunStillStored) throw new Error("A stale thread sync incorrectly marked the pending turn complete");
  historyComplete = true;
  await page.getByText(delayedReply, { exact: true }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => !localStorage.getItem("codex-remote-mobile:pending-run"), undefined, { timeout: 3000 });
  await page.close();
  console.log("Verified pending messages survive stale thread sync");
} finally {
  await browser?.close();
  await server.close();
}
