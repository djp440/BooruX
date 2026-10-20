# Rating 由 Go 端强制执行

Profile 的 Rating 决定允许浏览的作品范围。在线查询将 Rating 传给源站，任何 Source Fallback 的结果还会在 Go 端再次过滤；本地列表、搜索、详情、收藏和热门标签同样在 Go 端执行同一规则。前端隐藏卡片不能作为内容边界，且各 Online Source 对 Rating 参数的支持并不一致。
