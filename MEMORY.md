# 项目记忆与经验沉淀 (MEMORY)

## 2026-10-23 14:50 AI 对话页与会话层
- 后端早已有完整的 agent 运行时（`ai_runtime.go` 的 `runLoop` + `ai_tools.go` 的 5 个工具 + SSE 事件回放）。这次只补了会话层：新增 `ai_conversations` 表，给 `ai_runs` 加 `conversationId` 列，消息、工具调用、事件都经 runId 归属会话，删除会话即级联删除。`buildContext` 按 `run.conversationId` 取消息，这是会话隔离的关键。“只能有一个运行中任务”的唯一索引改为按会话（`ai_one_active_run_conversation`）。引入会话之前的旧 runs 由 `migrateConversations` 归入“此前的对话”。
- 删除会话前要先删除这些 runs 绑定的附件文件：`ai_attachments.runId` 是 `ON DELETE SET NULL`，不先删文件会留下孤儿文件。
- 前端用 `applyEvent` 纯函数归并事件，按事件 id 去重。一轮结束后重新拉取快照兜底，因为快照与游标之间存在极小的竞态窗口，可能重复或缺少一小段增量，`message_completed` 和重新拉取会修正。新对话在首条消息发送时才创建，用 `created` ref 跳过跳转后的重复加载。
- 会话列表做成页头下方的下拉抽屉（15:20 按用户要求修改：左侧留白不能放侧边栏）。点击标题切换展开；面板放在页头之后、`position: sticky` 的锚点里。不能放进页头内部，因为页头有 `transform`，会让内部 `fixed` 定位的透明遮罩失效。遮罩不加暗色，否则只有页头以下变暗，左侧品牌区和导航不一致。
- 覆盖层的“后退只关闭自身”逻辑已抽成 `history-layer.ts` 的 `useHistoryLayer`，媒体查看器和会话抽屉共用。抽屉中选中会话时先回退抽屉的历史记录，再在 onClose 里跳转。
- 对话页通过 `lazy()` 按需加载（`react-markdown` 约 180KB），首页包从 509KB 降到 331KB。Go 服务内嵌的是编译时的前端产物，重新构建前端后必须重启 `go run`，否则会请求到旧的资源文件。
- 端到端验证：`.e2e-data/polish/fake-models.mjs` 模拟 agent（消息含“找/搜”时先推理并调用 `search_posts`，拿到工具结果后流式输出 Markdown；含“慢”时慢速输出，用来测试停止），脚本为 `chat-check.mjs`。

## 2026-10-23 14:30 设置页供应商分组
- 后端早已有完整的 AI 供应商实现（`ai_db.go`、`ai_routes.go` 的 `/api/ai/providers*`），前端此前没有接入。拉取模型时，发现的所有模型都会写入 `ai_models`，所以用 `manual` 区分两类：`manual=1` 为已加入，`manual=0 && available=1` 为候选。手动新增的模型写入 `available=0`；移除时，被拉取到的模型退回候选，手动新增的模型直接删除。
- 主模型复用对话模型选择 `ai_chats.selection`（`PUT /api/profiles/default/chat`）。移除模型或删除供应商时，后端同时清空指向它的主模型。`providerId` 与 `modelId` 都传空字符串时清除选择，主模型改回“未设置”（14:50 补充）。
- 连通性测试复用已有的 `POST /api/ai/providers/{id}/models/verify`（`capability: chat`）；15:10 起该接口额外返回 `reply`（前 100 字符）和 `latencyMs`。
- 端到端验证用 `.e2e-data/polish/fake-models.mjs`（48399 端口）模拟 `/v1/models` 和 `/v1/chat/completions`（beta-vision 返回 400），脚本为 `provider-check.mjs`。

## 2026-10-23 13:20 设置页分组与标签屏蔽
- 设置页分为外观、内容、数据与存储、关于四组，用标签页切换，每次只显示一个分组（13:40 按用户要求，从“单页滚动加锚点”改为此方案）。结构上，`role=tablist` 下是 `role=tab` 按钮，方向键和 Home/End 切换焦点；`section.setting-group[role=tabpanel]` 内含视觉隐藏的 `h2` 和 `.setting-group-body` 卡片，设置项标题降为 `h3`。各分组的草稿状态都放在 `Settings` 中，非当前分组直接卸载也不会丢草稿。保存提示通过 `scope` 状态显示在对应设置项内，加载失败仍放在页面顶部。
- 首页与搜索的列表接口 `GET /api/danbooru/posts` 原本漏掉了 `tagFilter`（详情、关联媒体、收藏早已过滤），现已用 `filterAllowedPosts` 补上。过滤必须放在 `nextCursor` 计算之后，保证游标仍基于原始结果。
- 端到端验证用隔离数据库另起 Go 服务（`PORT=48302 DB_PATH=.e2e-data/polish/tikbooru.db go run .`），直接测试内嵌的构建产物。48300 端口是用户的服务；48301 端口被一个 10-21 启动的旧 `tikbooru-server` 长期占用，提供的是旧版前端，不要误用。

## 2026-10-23 12:50 媒体查看器
- 原生 `<dialog>.showModal()` 提供焦点限制、Esc、焦点归还，通过 `createPortal` 挂到 body，避开卡片的 `content-visibility`。React 合成事件仍会穿过 portal 冒泡到 `PostCard` 的 article，dialog 上必须对 click、pointerdown、keydown 调用 `stopPropagation`，否则点查看器会触发“进入详情”。
- 后退关闭：打开时 `navigate(同路径, { state: { ...state, sessionId: page.id, viewer: token } })`。必须带 `sessionId`，否则 `PageSessions.visit` 会新建会话，导致列表重挂载。压栈放在 `setTimeout` 里，防止 StrictMode 重复压入。`location.key` 离开压入的那条记录即关闭；主动关闭统一走 `navigate(-1)`。
- dialog 的 `close` 事件只在 `dialog.current && !open` 时处理（浏览器强制关闭）。卸载和 StrictMode 重挂载时 cleanup 调用 `close()` 也会派发该事件，不加判断会多后退一步。
- 遮罩保持半透明（`rgb(8 9 11 / 0.92)`，用户要求能隐约看到背后页面）。页面滚动用 `html:has(.media-viewer[open]) { overflow: hidden }` 锁定。`html` 设了 `scrollbar-gutter: stable`，槽位会绘制在顶层 dialog 之上：dialog 宽度用 `100%`（不含槽位）而非 `100vw`；根背景设为 `color-mix(#08090b 92%, var(--canvas))`，近似遮罩叠在画布上的颜色。
- 帖子操作栏（评论、转发、收藏）用 `justify-content: flex-end` 集中在右下角，且最后一个图标到卡片右缘的距离等于图标间视觉间距（28px）。20px 图标在 44px 按钮里每侧留白 12px，右外边距为 `calc(16px - var(--card-pad-x))`；卡片左右内边距通过 `--card-pad-x` 统一（桌面 16px，窄屏 12px）。
- 原尺寸缩放：图片用 grid 加 `margin: auto` 居中，溢出时自动退化为从左上角开始；`place-items: center` 会让左侧溢出部分无法滚动到。缩放期间锁定横向轨道（`data-locked`）。

## 2026-10-23 12:10 作者页
- `/artists/:name` 复用 `FeedResults kind="home" query={画师标签}`，不新增后端接口：后端 `artist` 即 `tag_string_artist` 首词，搜索结果与首页同标签搜索共享缓存键。
- 作者链接只对已知作者（非 `Unknown_Artist`）且 `danbooru-` 帖子生效；`PostCard` 以 `onAuthor` 回调跳转（测试用 `renderToString` 渲染卡片时没有 Router，卡片内不能用 `Link`），保留真实 `href` 支持中键或 Ctrl 点击在新标签页打开。
- 进入作者页走 `openArtist`：与详情一样经 `store.open` 记录 `origin`，返回时 `backDelta` 退回来源页；`/artists/*` 归入 home 区域，但不写入 `lastVisit`。
- `.post-meta a`（0,1,1）的优先级高于 `.post-author`，作者名改为链接后要用 `.post-meta a.post-author` 恢复正文色。

## 2026-10-23 11:08 前端深度打磨决策（11:40 补充搜索面板）
- **版心**：取代 2026-10-21 的 1200px 版心。所有页面共用最宽 600px 内容列（`.feed`、`.settings`），桌面为 200px 侧栏 + 24px 间距 + 内容列，`.app-shell` 最宽 856px 居中；宽屏两侧留白，避免竖图在宽列中左贴大片空白。
- **页头**：列表、详情、设置统一使用半透明磨砂吸顶页头（`.page-header` / `.detail-header`）；首页页头即搜索框，标题 `h1` 视觉隐藏。搜索历史与语法提示合并为搜索框下拉面板（`.search-panel`，随表单 `:focus-within` 显示）；面板内按钮在 mousedown 时 `preventDefault` 保持输入框焦点，否则 Safari 点击按钮不聚焦，面板会在 click 前收起。
- **反馈**：图片 `data-state` 控制微光占位与淡入；首次加载使用 `.skeleton-card`（不得复用 `.post-card`，`page-session` 用 `.post-detail .post-card` 判断详情是否已渲染）；收藏成功走 `Layout` 中的底部 toast，失败仍在卡片内 alert。
- **收藏按钮禁用**：其它卡片提交期间所有收藏按钮仍会 `disabled`，但只有 `aria-busy` 的那个显示脉冲；不再整页变灰。
- **多媒体翻页**：位置角标和左右按钮渲染在每个 `figure` 内（按索引静态计算），无需滚动监听；按钮 `tabIndex=-1` 只服务鼠标，键盘聚焦轨道用方向键。
- **评论定位**：`.comments` 设视口最小高度，否则页面过短时评论按钮无法把评论区滚到顶部。

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
- **宽屏不对称内边距补偿（历史方案，已由 2026-10-23 11:08 的 600px 内容列替代）**：当网格存在单边分割线（如固定 200px 侧栏的右边框）且全局版心带有 16px 边距时，内容流容器应采用不对称内边距（如 `.feed { padding: 0 8px 0 24px; }`）精确抵消，确保内容卡片到左侧侧栏分割线与到右侧版心边缘的物理间距恒等于 24px，实现严格对称。
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
- **断点与版心契约（1200px 版心已由 2026-10-23 11:08 的 856px 居中版心替代）**：768px 以上桌面端采用“固定 200px 侧栏 + 最大版心 1200px 居中（`max-width: 1200px; margin: 0 auto; padding: 0 16px;`）”，取代原先左右 15% 边距，避免平板竖屏宽度过度挤压及 4K 宽屏侧栏过度拉伸。
- **导航回顶交互**：用户在列表页再次点击当前已高亮的“首页”或“收藏”导航时，平滑滚动至顶部并将位置记录重置为原点。

### 2. 运行时与载体边界经验
- **Go embed 静态服务与 SPA 缓存契约**：使用 Go `http.ServeFileFS` 提供内嵌前端静态资源时，必须显式对 `assets/` 注入 `public, max-age=31536000, immutable`，对 `index.html` 注入 `no-cache, must-revalidate`，避免浏览器启发式缓存 `index.html` 导致前端发布新 Hash 产物后老用户 404 白屏。
- **React 19 StrictMode 下的 Effect 幂等性**：严禁在 `useEffect` 中使用未在 cleanup 重置的 Ref 标记（如 `initialLoad.current`）来守卫首屏拉取。StrictMode 的 Mount -> Unmount -> Mount 流程中，首次挂载触发的请求若在 cleanup 中被 abort，重挂载时 Ref 仍为 true 会导致请求永久跳过。状态守卫必须依赖 Effect 的依赖项或状态机自身。
- **桌面原生滚动条与滚动恢复的冲突**：浏览器原生视口滚动条拖拽不向 DOM 分发 `pointerdown` 或 `wheel`。在动画帧滚动校正循环中，必须通过比对 `window.scrollY` 与上次程序化坐标来检测非程序化位移，一旦检测到用户介入立即打断循环。
- **WebStorage 淘汰性能红线**：在大对象缓存淘汰循环中，必须优先在内存中削减条目数量（如至 40 项），严禁在每次单个 `delete` 后调用全量 `JSON.stringify`，防止在低端移动设备上产生 200ms+ 主线程冻结。
- **TypeScript 测试覆盖闭环**：前端使用 Bun 时，在 `package.json` 添加 `@types/bun` 并将 `"tests"` 纳入 `tsconfig.json` 的 `include`，确保重构时测试用例类型与源码模型同步受检。
