# BooruX

- 当前以 `server-go/` 为重写起点，保留 Go 服务、测试和内嵌 Web 资源。
- 前端源码：`frontend/`（React + TypeScript + Vite）；运行 `bun install`、`bun run dev`，`bun run build` 输出到 `server-go/web/`，供 Go 内嵌。开发时 `/api` 代理到 `127.0.0.1:48300`。
- 后端入口：在 `server-go/` 运行 `go run .`；测试命令：`go test ./...`。
- 一键启动脚本：根目录运行 `.\start.ps1`（支持 `-Build` 重新打包前端，`-SkipBuild` 跳过构建，`-Port` 自定义端口）或直接双击 `start.bat`。服务监听 `0.0.0.0`，启动时会打印局域网地址；手机打开后可「添加到主屏幕」作为 PWA 使用（静态资源与 manifest 在 `frontend/public/`；仅 HTTP，Android 只得到浏览器快捷方式）。
- 运行数据与密钥不得提交；沿用 `.gitignore` 中的保护规则。
- Issues 记录在 GitHub Issues（`djp440/BooruX`），使用 `gh` CLI。
- 使用五个 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。
- 编写前端时，保持`精致、易用，并给人舒适的视觉反馈和交互体验`规则
