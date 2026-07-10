# 安全说明

Codex Remote Bridge 不是普通只读 API。持有有效令牌的人可以在已配置工作区中启动 Codex、修改文件，并在明确调用 Git 接口时使用本机 Git 凭据推送已提交的代码。

## 必须做到

- Bridge 仅监听 `127.0.0.1`，通过 Cloudflare Tunnel、Tailscale 或受控反向代理提供 HTTPS。
- 使用至少 32 字节随机令牌；怀疑泄露时重新执行 `setup --token NEW_TOKEN`。
- 用 `--allowed-origin` 限制到自己的 Web 部署域名。
- 不要把端口 `17371` 直接映射到公网。
- 不要在公开 Web 构建中设置 `VITE_CODEX_REMOTE_DEFAULT_TOKEN`。
- 不要把 `~/.codex-remote/config.json`、`.env` 或 Tunnel 凭据提交到 Git。

## 认证与数据边界

- `/health` 与 `/config` 不需要令牌，但不会返回令牌、文件内容或 Codex 会话。
- 其余接口需要 `x-codex-remote-token`；SSE 因浏览器 EventSource 限制使用查询参数传令牌。
- 反向代理访问日志应关闭或清理 `/events` 的查询字符串，避免记录 SSE 令牌。
- Codex 登录态和 OpenAI 凭据由本机 Codex 管理，Web 页面不读取这些凭据。
- 图片附件先写入系统临时目录，任务结束后删除。
- 会话读取、恢复和归档会校验会话的 `cwd` 是否等于当前工作区。
- Git 推送只允许 Bridge 已发现的仓库路径，remote 和 branch 参数经过字符校验，并使用无 shell 的 `git push` 子进程。

## Codex 权限

Bridge 以 `workspace-write` 沙箱和 `approvalPolicy: never` 启动 app-server 会话。这适合无人值守的手机控制，但意味着请求不会在电脑端逐次弹出批准框。请只配置你愿意让手机端控制的工作区，不要把用户主目录或磁盘根目录设为工作区。

## 令牌轮换

```bash
node packages/bridge/dist/index.js setup --token REPLACE_WITH_A_NEW_LONG_RANDOM_TOKEN
```

重新启动 Bridge，并在手机设置页更新令牌。固定 Agent URL 不需要变化。
