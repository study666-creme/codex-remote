# 部署与固定 URL

部署分为两个独立部分：静态 Web 页面可以放在 Cloudflare Pages、Vercel、Netlify 或自己的服务器；Bridge 必须运行在拥有 Codex 登录态和项目文件的电脑上。

## 1. 一次性配置 Bridge

先构建：

```bash
npm install
npm run build
```

生成一个 Named Tunnel 固定域名后，执行：

```bash
node packages/bridge/dist/index.js setup \
  --public-url https://agent.example.com \
  --workspace /path/to/project \
  --host 127.0.0.1 \
  --port 17371 \
  --allowed-origin https://console.example.com
```

配置保存在：

- Windows: `%USERPROFILE%\.codex-remote\config.json`
- macOS / Linux: `~/.codex-remote/config.json`

`setup` 未传 `--token` 时会保留或自动生成令牌。配置完成后，后续只需要运行：

```bash
npm run bridge
```

## 2. Cloudflare Named Tunnel

Named Tunnel 的 UUID 和 DNS 记录固定，不会因为重启电脑或局域网 IP 变化而改变 URL。

```bash
cloudflared tunnel login
cloudflared tunnel create codex-remote
cloudflared tunnel route dns codex-remote agent.example.com
```

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: C:\Users\YOUR_USER\.cloudflared\YOUR-TUNNEL-UUID.json

ingress:
  - hostname: agent.example.com
    service: http://127.0.0.1:17371
  - service: http_status:404
```

测试：

```bash
cloudflared tunnel run codex-remote
```

Cloudflare Tunnel 只负责 HTTPS 和固定域名，Bridge 自己仍会校验令牌与网页来源。

## 3. Windows 开机启动

Bridge 必须运行在平时登录 Codex 的 Windows 用户账户下。不要把 Bridge 注册成 `LocalSystem` 服务，否则它通常读取不到该用户的 Codex 会话、认证和项目权限。

可在“任务计划程序”中建立两个登录触发任务：

1. Bridge：程序为 `node.exe`，参数为仓库内 `packages\bridge\dist\index.js`，起始目录为仓库根目录。
2. Tunnel：程序为 `cloudflared.exe`，参数为 `tunnel run codex-remote`。

任务使用同一个 Windows 用户，并设置“用户登录时运行”。更新代码后先重新执行 `npm run build`。

## 4. 部署 Web

在仓库根目录创建 `.env.production`：

```env
VITE_CODEX_REMOTE_DEFAULT_AGENT_URL=https://agent.example.com
VITE_CODEX_REMOTE_DEFAULT_TOKEN=
VITE_CODEX_REMOTE_SOURCE_URL=https://github.com/YOUR_NAME/codex-remote
```

构建：

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

## 5. 验证

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

手机打开 Web 页面后只需首次填写 Bridge 启动时输出的令牌。URL 已由网页构建配置和 Bridge 持久配置共同固定。

## 其他固定入口

- Tailscale Funnel：适合已有 tailnet 的个人设备，域名由 Tailscale 固定管理。
- 自建 Caddy / Nginx：适合有公网服务器和 WireGuard 的环境，反代到本机 `127.0.0.1:17371`。
- 局域网固定 IP：只适合家庭局域网，不适合移动网络；仍建议用 HTTPS。
