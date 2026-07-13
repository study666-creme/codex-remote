# Codex Remote Bridge

运行在 Codex 所在电脑上的本地 HTTP/SSE Bridge。

## 一次性配置

```bash
codex-remote-bridge setup \
  --public-url https://agent.example.com \
  --workspace /path/to/project \
  --allowed-origin https://console.example.com
```

可用参数：

- `--public-url`: Bridge 对手机公布的固定 HTTPS origin。
- `--token`: 连接令牌；省略时自动生成或保留现有值。
- `--workspace`: 默认 Codex 工作区。
- `--host`: 监听地址，默认 `127.0.0.1`。
- `--port`: 监听端口，默认 `17372`。
- `--allowed-origin`: 允许的 Web origin，可重复传入。

Bridge 默认使用 `danger-full-access`，以便沿用电脑上的 SSH、部署和跨目录操作能力。需要限制到项目工作区时，在启动 Bridge 前设置 `CODEX_REMOTE_SANDBOX=workspace-write`。

配置保存到 `~/.codex-remote/config.json`。之后直接运行 `codex-remote-bridge`。

## 接口

- `GET /health`, `GET /config`
- `GET /events`
- `GET|POST /agent/codex/workspace`
- `GET /agent/codex/workspaces`
- `GET /agent/codex/threads`
- `POST /agent/codex/threads/new`
- `GET|POST /agent/codex/threads/:id`
- `POST /agent/codex/turn`
- `POST /agent/codex/turn/steer`
- `GET /agent/git/repos`
- `POST /agent/git/push`

除 `/health` 和 `/config` 外都需要 Bridge token。
