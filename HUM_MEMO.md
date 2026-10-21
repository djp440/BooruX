# 项目未来决策备忘录 (HUM_MEMO)

## 2026-10-21 前端全面审阅优化决策

对应完整审阅报告：`frontend/FRONTEND_REVIEW.refine.md`

### 已确认的实施规范
1. **桌面端 768px 断点排版采用选项 B（优化版心）**：
   - 弃用原左右各 15% 边距及 25%/75% 比例；
   - 采用固定宽度侧栏（200px）+ 最大版心限制（`max-width: 1200px; margin: 0 auto; padding: 0 16px;`），保障 iPad 平板竖屏与 4K 超宽屏的阅读舒适度。
2. **测试套件纳入静态类型检查闭环**：
   - 在 `frontend/package.json` 添加 `@types/bun` 开发依赖；
   - 在 `frontend/tsconfig.json` 的 `include` 列表中加入 `"tests"`，使 `bun run check`（`tsc --noEmit`）对测试用例进行静态类型校验。
3. **主导航重复点击激活项平滑回顶**：
   - 用户在“首页”或“收藏”列表中重复点击当前已高亮的导航项时，触发 `window.scrollTo({ top: 0, behavior: 'smooth' })` 平滑回顶，并重置位置记录为原点。
4. **待落地核心修复清单**：
   - `server-go/web.go`：补充 `Cache-Control`（`assets/` 强缓存，`index.html` `no-cache`）杜绝更新白屏；
   - `frontend/src/PostDetail.tsx`：移除 `initialLoad` Ref，修复 React 19 StrictMode 下双重挂载中止导致的评论永久不加载问题；
   - `frontend/src/page-session.tsx`：增加非程序化滚动检测解决桌面滚动条拖拽死锁，`restorePosition` 消除全卡片布局回流，孤立会话回收；
   - `frontend/src/feed.ts`：媒体防伪正则补充 `/samples/`、`/thumbnails/`、`/preview/`，URL 解析安全与非 JSON 响应包装；
   - `frontend/src/post-cache.ts`：消除淘汰循环中的脏键与多次全量 `JSON.stringify`；
   - `frontend/src/Bookmarks.tsx`：`refresh` finally 补充版本号守卫，`clear` 同步设置 `loading: true`；
   - `frontend/src/Settings.tsx`：解耦加载错误与保存错误重试，主题单选改为未提交时仅 DOM 预览、离页自动回滚。

## 2026-10-21 布局、视觉与人机交互（HCI）专项评审决策

对应完整审阅报告：`frontend/DESIGN_AND_HCI_REVIEW.refine.md`

### 关键打磨规范
1. **画布底色与卡片表面解耦（Canvas vs Surface）**：
   - 用户已确认采纳增强选项。引入 `--canvas` 变量（浅色 `#f8f9fa`，暗色 `#111215`），`--surface` 专用于卡片与导航等抬升表面（浅色 `#fff`，暗色 `#18191d`），配合 `--card-shadow` 微阴影，营造类似 Apple Photos / GitHub 的精致实体卡片质感。
2. **移动端 Viewport 根契约**：`index.html` 必须补齐 `viewport-fit=cover`，否则 iOS Safari 下 `env(safe-area-inset-*)` 强制返回 0px 导致底栏和刘海完全失效。
3. **长列表媒体轨道高度防回流**：将 `50dvh` 改为 `50svh`，消除移动端滚动时地址栏伸缩引发的数十个卡片级联强制回流（Layout Thrashing）；引入 `content-visibility: auto` 跳过离屏长列表绘制释放 GPU 显存。
4. **人机工效与焦点连续性**：“加载更多”与“取消更改”按钮在操作中不得直接从 DOM 卸载，须通过 disabled 或主动焦点转移防止焦点跌落至 `document.body`。
5. **视觉质感与层次**：浅色单选卡片选中态底色提升为 `#f3f4f6` 并改用 `var(--text)` 边框；评论区字阶收敛至 14px 并接管段落间距；根级增加 `scrollbar-gutter: stable;` 消除居中版心跳动。
6. **Apple 流体动效与手势**：媒体横向轨道采用 `mandatory` 强吸附并隐藏桌面槽线；按压反馈采用物理非对称性（按下瞬时 70ms，抬起平滑 180ms）；收藏按钮设定 `min-width: 82px` 消除文案字数跳变挤压。
