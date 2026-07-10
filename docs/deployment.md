# 部署与固定 URL

部署分为两个独立部分：静态 Web 页面可以放在 Cloudflare Pages、Vercel、Netlify 或自己的服务器；Bridge 必须运行在拥有 Codex 登录态和项目文件的电脑上。

## 先分清三个值

- `Web 页面地址`：可以直接使用 `https://study666-creme.github.io/codex-remote/`，它只是静态界面。
- `Agent URL`：由每个使用者自己的 Cloudflare Named Tunnel、Tailscale Funnel 或反向代理提供，必须指向自己电脑上的 Bridge。
- `Token`：Bridge 在本机随机生成的连接密码，不是 OpenAI API Key、GitHub Token 或 Codex 登录凭据。

GitHub Pages 不会生成 Agent URL 或 Token。不同使用者可以共用同一个静态页面，但必须使用各自的 Agent URL 和 Token，数据与 Codex 登录态仍留在各自电脑上。

## 1. 构建本机 Bridge

在运行 Codex 的电脑上克隆仓库并构建：

```bash
npm install
npm run build
```

确认这台电脑上的 Codex 已经登录且可以正常执行任务。

## 2. 获取固定 Agent URL

使用 Cloudflare Named Tunnel 需要一个已经接入 Cloudflare 的域名。先安装 `cloudflared`：

```powershell
winget install --id Cloudflare.cloudflared
```

登录并创建 Tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create codex-remote
cloudflared tunnel route dns codex-remote agent.example.com
```

这里的 `https://agent.example.com` 就是以后填进手机页面的 Agent URL。Named Tunnel 的 UUID 和 DNS 记录固定，不会因为重启电脑或局域网 IP 变化而改变 URL。

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: C:\Users\YOUR_USER\.cloudflared\YOUR-TUNNEL-UUID.json

ingress:
  - hostname: agent.example.com
    service: http://127.0.0.1:17372
  - service: http_status:404
```

## 3. 生成 Token 并保存配置

使用本仓库现成 GitHub Pages 时，允许来源填写 `https://study666-creme.github.io`，不带 `/codex-remote/` 路径：

```powershell
node packages/bridge/dist/index.js setup --public-url https://agent.example.com --workspace "C:\path\to\project" --host 127.0.0.1 --port 17372 --allowed-origin https://study666-creme.github.io
```

配置保存在：

- Windows: `%USERPROFILE%\.codex-remote\config.json`
- macOS / Linux: `~/.codex-remote/config.json`

`setup` 未传 `--token` 时会保留或自动生成 32 字节随机令牌，并在本机终端打印 `Agent URL` 和 `Connect token`。这两项就是手机“连接配置”要填的内容。

以后忘记时，在仓库目录重新执行下面的命令即可查看现有值，不会自动更换 Token：

```bash
node packages/bridge/dist/index.js setup
```

不要把命令输出、`~/.codex-remote/config.json` 或 Tunnel 凭据提交到仓库。

## 4. 启动 Bridge 与 Tunnel

分别在两个终端启动长期运行的进程。终端一：

```bash
npm run bridge
```

终端二：

```bash
cloudflared tunnel run codex-remote
```

Cloudflare Tunnel 只负责 HTTPS 和固定域名，Bridge 自己仍会校验令牌与网页来源。

## 5. 在手机填写

1. 打开 `https://study666-creme.github.io/codex-remote/`。
2. 打开“连接配置”。
3. `Agent URL` 填 `setup` 打印的固定 HTTPS 地址。
4. `Token` 填 `setup` 打印的 `Connect token`。
5. 点击连接。两项会保存在当前浏览器，后续不必重复填写。

网页只是静态入口，没有应用层次数限制。电脑关机、Bridge 或 Tunnel 停止时页面无法连接；Codex 自身的账号额度仍然适用。

## 6. Windows 开机启动

Bridge 必须运行在平时登录 Codex 的 Windows 用户账户下。不要把 Bridge 注册成 `LocalSystem` 服务，否则它通常读取不到该用户的 Codex 会话、认证和项目权限。

可在“任务计划程序”中建立两个登录触发任务：

1. Bridge：程序为 `node.exe`，参数为仓库内 `packages\bridge\dist\index.js`，起始目录为仓库根目录。
2. Tunnel：程序为 `cloudflared.exe`，参数为 `tunnel run codex-remote`。

任务使用同一个 Windows 用户，并设置“用户登录时运行”。更新代码后先重新执行 `npm run build`。

## 7. 自己部署 Web（可选）

公开部署不要内置自己的 Agent URL 或 Token。直接构建：

```bash
npm run build -w @codex-remote/web
```

将 `apps/web/dist` 作为纯静态目录部署。常见平台配置：

| 配置 | 值 |
| --- | --- |
| Root directory | 仓库根目录 |
| Build command | `npm install && npm run build -w @codex-remote/web` |
| Output directory | `apps/web/dist` |
| Node.js | 20+ |

部署地址应和 Bridge `--allowed-origin` 完全一致，包括协议和端口，但不包含末尾 `/`。

## 8. 验证

```bash
curl https://agent.example.com/health
curl https://agent.example.com/config
```

`/config` 应返回：

```json
{
  "ok": true,
  "url": "https://agent.example.com",
  "fixedPublicUrl": true,
  "hasToken": true
}
```

手机打开 Web 页面后首次填写固定 Agent URL 和 Bridge 启动时输出的令牌；两项只保存在当前浏览器，以后直接进入即可。Named Tunnel 保证 Agent URL 不随电脑或网络重启而变化。

自托管者可以用 `VITE_CODEX_REMOTE_DEFAULT_AGENT_URL` 预填 Agent URL，但它会进入公开 JavaScript；公开仓库和公共 Pages 不建议这样做。任何情况下都不要把 Token 放进 Web 构建变量。

## 其他固定入口

- Tailscale Funnel：适合已有 tailnet 的个人设备，域名由 Tailscale 固定管理。
- 自建 Caddy / Nginx：适合有公网服务器和 WireGuard 的环境，反代到本机 `127.0.0.1:17372`。
- 局域网固定 IP：只适合家庭局域网，不适合移动网络；仍建议用 HTTPS。
