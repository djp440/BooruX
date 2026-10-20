# BooruX Web

Web 客户端供 BooruX Go 后端使用。开发时 Vite 将 `/api` 代理到 `127.0.0.1:48300`；生产构建输出到 `server-go/web`，由 Go `embed` 打包。

## 命令

- `bun install`
- `bun run dev`
- `bun run build`

构建会先清空并重写 `server-go/web`，该目录需要随源码提交，才能让 `go build` 直接得到可运行的单二进制。
