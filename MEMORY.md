# 项目记忆与经验沉淀 (MEMORY)

## 2026-10-22 13:08 标签预览与详情边界
- 首页和收藏中的标签以四行预览展示，超限显示省略号；使用 `overflow: clip`，不再单独滚动，点击帖子进入详情查看。
- `PostCard` 根据是否提供 `onOpen` 设置 `data-preview`：列表进行截断，详情不限制标签高度、不截断，全部标签随页面阅读。

## 2026-10-22 12:55 X 风格帖子展示决策
- 首页、收藏与详情继续共用 `PostCard`，采用左侧中性字母头像、右侧作者与来源信息、正文、井号标签、媒体和图标操作栏；帖子以细分隔线相连，不再使用浮起卡片阴影。
- 标签位于媒体上方；此时曾采用最大高度 96px 的滚动标签池，现已由 2026-10-22 13:08 的“列表四行省略、详情完整展开”方案替代。
- 媒体采用后端有效 `aspectRatio`，缺失时回退 4:3，并以 `min(70svh, 680px)` 限高；不再固定为 `50svh`，保留原图完整显示与媒体组横向吸附。
- Danbooru 转换器的 `artistAvatar` 是统一 Unsplash 占位图，不代表真实作者；前端使用作者首字母，未知作者显示问号，不展示伪造账号、认证或社交数据。
- 帖子操作栏仅保留评论、禁用转发与收藏，图标按钮固定 44px 热区，使用无障碍名称和悬停标题。

## 2026-10-22 12:12 Refactoring UI 专项打磨与视觉主次工程经验
- **卡片视觉主次（历史方案）**：此前采用媒体在前、标签池在后且限高 120px；已被 2026-10-22 12:55 的 X 风格方案替代。标签仍保留 `touch-action: pan-y; overscroll-behavior: contain;`。
- **空状态导流闭环（Next Steps on Empty States）**：列表空状态不可使用孤立纯文本阻断操作流；应提供场景说明与明确的导流 CTA（如“去首页浏览”），直接调用会话系统的 `goArea('home')` 完成平滑切换，杜绝死胡同。
- **宽屏不对称内边距补偿（Asymmetrical Padding Compensation）**：当网格存在单边分割线（如固定 200px 侧栏的右边框）且全局版心带有 16px 边距时，内容流容器应采用不对称内边距（如 `.feed { padding: 0 8px 0 24px; }`）精确抵消，确保内容卡片到左侧侧栏分割线与到右侧版心边缘的物理间距恒等于 24px，实现严格对称。
- **表单内容宽度约束（Width Serving Form Content）**：宽屏下（如 1200px 版心）表单卡片必须显式约束 `max-width: 600px`，防止简单的单选卡片横向拉伸至近千像素造成视线涣散与点击目标畸变。
- **状态通知条轻量实体化**：表单成功/失败通知应赋予 `var(--subtle)` 浅底、圆角与微边框（如 `.setting-notice, .setting-error`），替代粗暴的纯色文字浮动，强化现代界面的实体反馈质感。

## 2026-10-21 23:51 工单实施与代码审查闭环经验沉淀（#9 ~ #16）
- **React 状态更新器纯度（State Updater Purity）**：严禁在 `setFeed(current => ...)` 等状态计算闭包中执行 `localStorage` 写盘（如 `writePostCache`）或直接修改外部 Session 对象。React 19 并发渲染与严格模式下更新器会被多次调用，副作用必须在异步业务回调中计算并在调用 `setState(updated)` 前后执行。
- **元素禁用时的焦点跌落防御（Focus Blur on Disabled）**：当表单重置或点击“取消更改”导致提交/保存按钮因为未修改而立即变为 `disabled` 时，若直接 `submitRef.focus()`，浏览器会将焦点强制 blur 并跌落至 `document.body`。应主动将焦点转移至当前已选中的单选卡片/输入框等可用控件上，保持键盘焦点连续性。
- **持久化缓存按体积淘汰策略**：在实现单次 `JSON.stringify` 性能优化的同时，对于 `MAX_SIZE` (2 MiB) 超限情况，应先在内存中按时间戳升序循环逐出最旧条目直到新体积容纳，仅当单项自身体积超限时才安全放弃写入，避免多项累积时静默丢弃整个新缓存。

## 2026-10-21 22:35 布局、视觉与 HCI 专项工单化决策
- **画布与卡片表面解耦（Canvas vs Surface）**：确定引入 `--canvas` 变量（浅色 `#f8f9fa`，深色 `#111215`），`--surface` 仅用于卡片与导航等抬升表面（浅色 `#fff`，深色 `#18191d`），配合 `--card-shadow` 微阴影构建类 Apple Photos / GitHub 的精致实体卡片质感。
- **移动端 Viewport 根契约**：`index.html` 必须显式声明 `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`，否则 iOS Safari 下 `env(safe-area-inset-*)` 强制返回 0px 导致底部 Home Indicator 遮挡导航。
- **长列表媒体轨道视口单位选型**：使用稳定的小视口单位 `svh` 而非 `dvh`，避免地址栏收展导致全列表回流；历史固定高度 `50svh` 已由 2026-10-22 12:55 的比例布局和 `70svh` 上限替代。
- **Apple 流体动效与手势规范**：媒体横向滑动使用 `scroll-snap-type: x mandatory` 保证主图精准居中停靠；按钮按压反馈采用物理非对称性（按下瞬时 70ms 下沉，抬起平滑 180ms 恢复）；历史收藏按钮曾使用 `min-width: 82px`，现已由 2026-10-22 12:55 的固定 44px 图标按钮替代；长列表卡片配置 `content-visibility: auto; contain-intrinsic-size: auto 500px;` 隔离离屏 GPU 显存。
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
