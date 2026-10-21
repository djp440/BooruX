# 项目记忆与经验沉淀 (MEMORY)

## 2026-10-21 23:51 工单实施与代码审查闭环经验沉淀（#9 ~ #16）
- **React 状态更新器纯度（State Updater Purity）**：严禁在 `setFeed(current => ...)` 等状态计算闭包中执行 `localStorage` 写盘（如 `writePostCache`）或直接修改外部 Session 对象。React 19 并发渲染与严格模式下更新器会被多次调用，副作用必须在异步业务回调中计算并在调用 `setState(updated)` 前后执行。
- **元素禁用时的焦点跌落防御（Focus Blur on Disabled）**：当表单重置或点击“取消更改”导致提交/保存按钮因为未修改而立即变为 `disabled` 时，若直接 `submitRef.focus()`，浏览器会将焦点强制 blur 并跌落至 `document.body`。应主动将焦点转移至当前已选中的单选卡片/输入框等可用控件上，保持键盘焦点连续性。
- **持久化缓存按体积淘汰策略**：在实现单次 `JSON.stringify` 性能优化的同时，对于 `MAX_SIZE` (2 MiB) 超限情况，应先在内存中按时间戳升序循环逐出最旧条目直到新体积容纳，仅当单项自身体积超限时才安全放弃写入，避免多项累积时静默丢弃整个新缓存。

## 2026-10-21 22:35 布局、视觉与 HCI 专项工单化决策
- **画布与卡片表面解耦（Canvas vs Surface）**：确定引入 `--canvas` 变量（浅色 `#f8f9fa`，深色 `#111215`），`--surface` 仅用于卡片与导航等抬升表面（浅色 `#fff`，深色 `#18191d`），配合 `--card-shadow` 微阴影构建类 Apple Photos / GitHub 的精致实体卡片质感。
- **移动端 Viewport 根契约**：`index.html` 必须显式声明 `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`，否则 iOS Safari 下 `env(safe-area-inset-*)` 强制返回 0px 导致底部 Home Indicator 遮挡导航。
- **长列表媒体轨道视口单位选型**：无限信息流中的动态媒体高度必须使用小视口单位 `50svh` 而非动态视口单位 `50dvh`，防止滚动期间地址栏收展引起全列表数十张卡片级联强制回流（Layout Thrashing）。
- **Apple 流体动效与手势规范**：媒体横向滑动使用 `scroll-snap-type: x mandatory` 保证主图精准居中停靠；按钮按压反馈采用物理非对称性（按下瞬时 70ms 下沉，抬起平滑 180ms 恢复）；收藏按钮设立 `min-width: 82px` 消除文案字数跳变挤压；长列表卡片配置 `content-visibility: auto; contain-intrinsic-size: auto 500px;` 隔离离屏 GPU 显存。
- **键盘焦点秩序（Focus Order）**：异步加载（如“加载更多”）或临时撤销按钮（如“取消更改”）在操作中严禁从 DOM 树直接卸载，须通过 disabled 或主动焦点转移防止焦点跌落至 `document.body` 迫使键盘用户从头遍历。

## 2026-10-21 22:20 前端审阅与跨任务技术规范决策

### 1. 架构与布局
- **断点与版心契约**：768px 以上桌面端采用“固定 200px 侧栏 + 最大版心 1200px 居中（`max-width: 1200px; margin: 0 auto; padding: 0 16px;`）”，取代原先左右 15% 边距，避免平板竖屏宽度过度挤压及 4K 宽屏侧栏过度拉伸。
- **导航回顶交互**：用户在列表页再次点击当前已高亮的“首页”或“收藏”导航时，平滑滚动至顶部并将位置记录重置为原点。

### 2. 运行时与载体边界经验
- **Go embed 静态服务与 SPA 缓存契约**：使用 Go `http.ServeFileFS` 提供内嵌前端静态资源时，必须显式对 `assets/` 注入 `public, max-age=31536000, immutable`，对 `index.html` 注入 `no-cache, must-revalidate`，避免浏览器启发式缓存 `index.html` 导致前端发布新 Hash 产物后老用户 404 白屏。
- **React 19 StrictMode 下的 Effect 幂等性**：严禁在 `useEffect` 中使用未在 cleanup 重置的 Ref 标记（如 `initialLoad.current`）来守卫首屏拉取。StrictMode 的 Mount -> Unmount -> Mount 流程中，首次挂载触发的请求若在 cleanup 中被 abort，重挂载时 Ref 仍为 true 会导致请求永久跳过。状态守卫必须依赖 Effect 的依赖项或状态机自身。
- **桌面原生滚动条与滚动恢复的冲突**：浏览器原生视口滚动条拖拽不向 DOM 分发 `pointerdown` 或 `wheel`。在动画帧滚动校正循环中，必须通过比对 `window.scrollY` 与上次程序化坐标来检测非程序化位移，一旦检测到用户介入立即打断循环。
- **WebStorage 淘汰性能红线**：在大对象缓存淘汰循环中，必须优先在内存中削减条目数量（如至 40 项），严禁在每次单个 `delete` 后调用全量 `JSON.stringify`，防止在低端移动设备上产生 200ms+ 主线程冻结。
- **TypeScript 测试覆盖闭环**：前端使用 Bun 时，在 `package.json` 添加 `@types/bun` 并将 `"tests"` 纳入 `tsconfig.json` 的 `include`，确保重构时测试用例类型与源码模型同步受检。
