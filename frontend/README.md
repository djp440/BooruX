# BooruX Web

Web 客户端供 BooruX Go 后端使用。开发时 Vite 将 `/api` 代理到 `127.0.0.1:48300`；生产构建输出到 `server-embed`，由 Go `embed` 打包。

## 命令

- `bun install`
- `bun run dev`
- `bun run build`

构建会先清空并重写 `server-embed`，它是供 Go 嵌入的产物目录。
