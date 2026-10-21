# BooruX

- 当前以 `server-go/` 为重写起点，保留 Go 服务、测试和内嵌 Web 资源。
- 前端源码：`frontend/`（React + TypeScript + Vite）；运行 `bun install`、`bun run dev`，`bun run build` 输出到 `server-go/web/`，供 Go 内嵌。开发时 `/api` 代理到 `127.0.0.1:48300`。
- 后端入口：在 `server-go/` 运行 `go run .`；测试命令：`go test ./...`。
- 运行数据与密钥不得提交；沿用 `.gitignore` 中的保护规则。
- Issues 记录在 GitHub Issues（`djp440/BooruX`），使用 `gh` CLI。
- 使用五个 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。
