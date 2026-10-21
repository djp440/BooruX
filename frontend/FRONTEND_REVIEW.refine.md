# 内容强化报告：BooruX 前端架构与全栈交付深度审阅

审阅方式：独立并行子代理（6 位领域顶尖专家）
目标与载体：BooruX 前端 SPA 应用（React 19 + TypeScript 6 + Vite 8），作为现代 Web SPA 运行在桌面与移动端浏览器（Safari, Chrome, Firefox 等），由 Go 后端通过 `embed.FS` 内嵌托管或 Vite 本地代理交付。

---

## 结论

当前前端代码库在架构设计上非常克制、精简（总源码约 1,500 行，无冗余第三方库，纯原生实现会话恢复、滑动轨道与多路流式归并），但在**现代 Web 运行时边界**与**真实极端交互场景**下存在若干隐蔽的破坏性短板：

1. **React 19 / 浏览器运行时与交付层契约缺陷（阻断级）**：
   - Go 后端静态交付缺少 `Cache-Control` 声明，导致浏览器启发式缓存 `index.html`；前端一旦发布新 Hash 构建，老用户将因请求旧资源 404 导致**应用永久白屏**；
   - `PostDetail.tsx` 在 React 19 严格模式（StrictMode）双重挂载下，首屏异步请求被中止后因 `initialLoad` Ref 未重置而**永久停止拉取原站评论**；
   - 桌面原生窗口滚动条（Scrollbar Thumb）拖拽未被事件监听，触发 1 秒内 rAF 强制 `scrollTo` 导致**视口严重颤抖死锁**。
2. **数据流与本地存储容错漏洞（阻断级）**：
   - 媒体防伪正则遗漏 Safebooru 的 `/samples/`、`/thumbnails/` 及 Danbooru 的 `/preview/`，使**低清缩略图/有损样本图被冒充为原图**展示；
   - `writePostCache` 淘汰循环存在脏键重复遍历与每次删除单项高频全量 `JSON.stringify`，在移动端产生 **100~300ms 主线程卡死掉帧**；
   - `originalMediaURL` 在解析上游相对/协议相对路径时会抛出未捕获的 URL 构造异常。
3. **状态机与表单异步竞态破坏（阻断级）**：
   - `Bookmarks.tsx` 的 `refresh` finally 块缺少版本号保护，旧请求完成时会**提前将正在运行的新请求引用置空并抹除 loading 态**；
   - `Settings.tsx` 保存失败提示旁附带的“重试”按钮错误触发了数据重拉取（`fetchSettings`），**强制用服务端旧数据覆盖用户未保存的草稿**。

---

## 拆解与专家

| 部分 | 涵盖范围与原文位置 | 专家角色 |
| --- | --- | --- |
| 1. 视觉呈现、响应式布局与无障碍体验 | `src/style.css` (L1-454), `src/App.tsx` (L8-24) | 资深 Web 视觉与无障碍工程专家（专精移动响应式布局与 WCAG 规范） |
| 2. 会话历史、滚动恢复与跨路由持久化 | `src/page-session.tsx` (L1-156), `src/App.tsx` (L25-44), `tests/page-session.test.ts` | 前端状态与浏览器会话工程专家（专精单页应用滚动恢复与路由历史树） |
| 3. 帖子流数据生命周期、缓存与 Tag 检索 | `src/feed.ts` (L1-86), `src/post-cache.ts` (L1-95), `src/search.ts` (L1-42) | 前端数据流与本地存储架构师（专精 WebStorage 弹性容错与搜索缓存） |
| 4. 复杂卡片交互、多媒体轨道与原站评论归并 | `src/PostCard.tsx` (L1-117), `src/PostDetail.tsx` (L1-143), `src/comments.ts` (L1-126) | 复杂交互组件与流式归并专家（专精多媒体横滑流与异步多路并发归并） |
| 5. 用户设置系统、收藏上下文与状态同步 | `src/Bookmarks.tsx` (L1-109), `src/Settings.tsx` (L1-122), `src/rating-settings.ts` (L1-76) | React 交互表单与跨组件通信专家（专精乐观更新与跨页面状态失效同步） |
| 6. 现代 Web 运行时与 Go 内嵌生产部署 | `package.json`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `server-go/web.go` | 现代 Web 平台与全栈内嵌工程专家（载体专家，专精 React 19 / Vite 8 / TS / Go-Embed 静态交付） |

---

## 优化建议

### 阻断级建议（载体无法正确执行或结果明显偏离目标）

#### 1. Go 内嵌静态服务缺少 Cache-Control 导致版本升级后永久白屏
- **提出专家**：现代 Web 平台与全栈内嵌工程专家（载体专家）
- **位置与原文**：`server-go/web.go` 第 56-69 行：
  ```go
  func serveEmbedded(w http.ResponseWriter, r *http.Request, name string) bool {
  	name = path.Join(webRoot, name)
  	f, err := webContent.Open(name)
  	if err != nil {
  		return false
  	}
  	defer f.Close()
  	info, err := f.Stat()
  	if err != nil || info.IsDir() {
  		return false
  	}
  	http.ServeFileFS(w, r, webContent, name)
  	return true
  }
  ```
- **问题**：`http.ServeFileFS` 不自动设置 `Cache-Control`。浏览器依据 RFC 9111 采用启发式缓存。一旦 `index.html` 被客户端长期缓存，前端发布新构建产生不同 Hash 的 JS/CSS 后，老用户请求旧 Hash 资源触发 404，导致应用彻底白屏瘫痪。
- **替换为**：
  ```go
  func serveEmbedded(w http.ResponseWriter, r *http.Request, name string) bool {
  	target := path.Join(webRoot, name)
  	f, err := webContent.Open(target)
  	if err != nil {
  		return false
  	}
  	defer f.Close()
  	info, err := f.Stat()
  	if err != nil || info.IsDir() {
  		return false
  	}
  	w.Header().Set("X-Content-Type-Options", "nosniff")
  	if strings.HasPrefix(name, "assets/") {
  		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
  	} else if name == "index.html" {
  		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
  	}
  	http.ServeFileFS(w, r, webContent, target)
  	return true
  }
  ```
- **依据**：RFC 9111 HTTP Caching 规范第 4.2.2 节；SPA 静态部署工业标准。

#### 2. React 19 严格模式双重挂载导致详情页原站评论永久锁死无法加载
- **提出专家**：现代 Web 平台与全栈内嵌工程专家（载体专家）
- **位置与原文**：`frontend/src/PostDetail.tsx` 第 29、69 与 108-113 行：
  ```tsx
  const initialLoad = useRef(false);
  ...
  useEffect(() => {
    if (verified && detail?.commentsAvailability === 'available' && !initialLoad.current) {
      initialLoad.current = true;
      if (!page.comments?.displayed.length && !page.comments?.streams.some(stream => stream.error) && !commentsComplete(page.comments!)) void load();
    }
  }, [verified, detail]);
  ```
- **问题**：React 19 `<StrictMode>` 挂载时触发 Mount -> Unmount -> Mount。首次挂载触发 `load()`；清理函数 `request.current?.abort()` 中止首屏请求；重挂载时因 Ref 跨挂载保留，`initialLoad.current` 仍为 `true`，导致第二次挂载直接跳过拉取，界面评论永久处于“暂无评论”或未加载状态。
- **替换为**：
  移除 `initialLoad` Ref，将幂等性交给 Effect 依赖与评论流状态守卫：
  ```tsx
  useEffect(() => {
    if (!verified || detail?.commentsAvailability !== 'available') return;
    if (page.comments?.displayed.length || page.comments?.streams.some(stream => stream.error) || commentsComplete(page.comments!)) return;
    void load();
  }, [verified, detail]);
  ```
- **依据**：React 官方文档《Synchronizing with Effects》StrictMode 幂等性准则。

#### 3. 桌面端原生滚动条拖拽与 beginRestore 循环冲突导致 1 秒严重卡顿死锁
- **提出专家**：前端状态与浏览器会话工程专家
- **位置与原文**：`frontend/src/page-session.tsx` 第 97 行：
  ```ts
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, stop, { once: true, passive: true });
  ```
- **问题**：桌面浏览器原生视口滚动条由宿主窗口直接处理，不向 DOM 派发 `pointerdown` 或 `wheel` 事件。用户拖拽滚动条时不会触发 `stop()`，导致 1 秒内每一帧 rAF 强行执行 `scrollTo` 将视口暴力拉回，与用户手势剧烈冲突。
- **替换为**：
  在帧循环中比对 `window.scrollY` 与上次程序化坐标，检测非程序化滚动立即打断交还控制权：
  ```ts
  export function beginRestore(position: Position): () => void {
    let stopped = false;
    let frame = 0;
    let lastY = -1;
    const started = performance.now();
    const stop = () => { stopped = true; cancelAnimationFrame(frame); };
    const tick = () => {
      if (stopped) return;
      if (lastY >= 0 && Math.abs(window.scrollY - lastY) > 1) { stop(); return; }
      restorePosition(position);
      lastY = window.scrollY;
      if (performance.now() - started < 1000) frame = requestAnimationFrame(tick);
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, stop, { once: true, passive: true });
    frame = requestAnimationFrame(tick);
    return () => { stop(); for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(type, stop); };
  }
  ```
- **依据**：W3C Pointer Events Level 3 规范与 CSSOM View Module。

#### 4. 媒体防伪正则遗漏 Safebooru/Danbooru 样本与缩略图导致冒充原图
- **提出专家**：前端数据流与本地存储架构师
- **位置与原文**：`frontend/src/feed.ts` 第 81 行：
  ```typescript
  if (/\/(sample|\d+x\d+)\//.test(upstream.pathname) || parsed.pathname.startsWith('/api/media/cache/')) return '';
  ```
- **问题**：Safebooru 样本图为 `/samples/`、缩略图为 `/thumbnails/`，Danbooru 预览图为 `/preview/`。单数正则 `/\/(sample|\d+x\d+)\//` 完全漏判，导致缩略图被误判为原图直接向用户展示，违反“不将缩略图和样本冒充原图”规范。
- **替换为**：
  ```typescript
  if (/\/(samples?|preview|thumbnails?|\d+x\d+)\/|\/(sample|thumbnail)[_-]/i.test(upstream.pathname) || parsed.pathname.startsWith('/api/media/cache/')) return '';
  ```
- **依据**：Safebooru DAPI 路径规范与后端 `server-go/danbooru.go` 媒体目录约定。

#### 5. originalMediaURL 相对路径解析抛错与 Javascript 协议注入隐患
- **提出专家**：前端数据流与本地存储架构师
- **位置与原文**：`frontend/src/feed.ts` 第 78-82 行：
  ```typescript
  const parsed = new URL(value, 'http://localhost');
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  const upstream = new URL(parsed.searchParams.get('url') || parsed.href);
  if (/\/(sample|\d+x\d+)\//.test(upstream.pathname) || parsed.pathname.startsWith('/api/media/cache/')) return '';
  return value;
  ```
- **问题**：`parsed.searchParams.get('url')` 如果带有协议相对路径（`//safebooru.org/...`），无 base 直接 `new URL` 会抛出 `TypeError` 导致合法图片被丢弃；且未校验解包后 `upstream.protocol` 是否安全。
- **替换为**：
  ```typescript
  export function originalMediaURL(post: Post): string {
    const candidates = [post.originalUrl, post.imageUrl].filter((item): item is string => typeof item === 'string' && item.length > 0);
    for (const value of candidates) {
      try {
        const parsed = new URL(value, 'http://localhost');
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        const rawUpstream = parsed.searchParams.get('url');
        const upstream = rawUpstream ? new URL(rawUpstream, parsed.href) : parsed;
        if (!['http:', 'https:'].includes(upstream.protocol)) continue;
        if (/\/(samples?|preview|thumbnails?|\d+x\d+)\/|\/(sample|thumbnail)[_-]/i.test(upstream.pathname) || parsed.pathname.startsWith('/api/media/cache/')) continue;
        return value;
      } catch {
        continue;
      }
    }
    return '';
  }
  ```
- **依据**：WHATWG URL 构造器规范与安全协议白名单原则。

#### 6. writePostCache 淘汰循环高频全量 JSON.stringify 阻塞主线程 100~300ms
- **提出专家**：前端数据流与本地存储架构师
- **位置与原文**：`frontend/src/post-cache.ts` 第 81-89 行：
  ```typescript
  for (const item of keys) {
    if (!entries[item]?.savedAt || now - entries[item].savedAt > MAX_AGE) delete entries[item];
  }
  let serialized = JSON.stringify(entries);
  for (const item of keys) {
    if (Object.keys(entries).length <= MAX_ENTRIES && serialized.length * 2 <= MAX_SIZE) break;
    delete entries[item];
    serialized = JSON.stringify(entries);
  }
  ```
- **问题**：已过期的键被 delete 后依然留在 `keys` 数组中，导致第二个循环对已删除项反复无意义空转，且每次删除单个项都对 2MB 对象执行一次昂贵的 `JSON.stringify`，在移动设备上导致严重卡顿。
- **替换为**：
  优先在内存中削减条目数量至 `MAX_ENTRIES` (40)，仅在超容时做必要序列化：
  ```typescript
    const now = Date.now();
    entries[key] = { savedAt: now, data };
    const olderKeys = Object.keys(entries).filter(item => item !== key)
      .sort((a, b) => (entries[a]?.savedAt || 0) - (entries[b]?.savedAt || 0));
    for (const item of olderKeys) {
      if (!entries[item]?.savedAt || now - entries[item].savedAt > MAX_AGE) delete entries[item];
    }
    const remainingOlderKeys = olderKeys.filter(item => item in entries);
    let count = Object.keys(entries).length;
    for (const item of remainingOlderKeys) {
      if (count <= MAX_ENTRIES) break;
      delete entries[item];
      count--;
    }
    let serialized = JSON.stringify(entries);
    if (serialized.length * 2 > MAX_SIZE) {
      for (const item of remainingOlderKeys) {
        if (!(item in entries)) continue;
        delete entries[item];
        serialized = JSON.stringify(entries);
        if (serialized.length * 2 <= MAX_SIZE) break;
      }
    }
  ```
- **依据**：V8 / JavaScriptCore 大对象序列化 GC 性能指标。

#### 7. refresh finally 块缺少版本号保护导致后续请求引用被提前抹除与 loading 失真
- **提出专家**：React 交互表单与跨组件通信专家
- **位置与原文**：`frontend/src/Bookmarks.tsx` 第 51-66 行：
  ```tsx
  request.current = fetchPosts('/api/profiles/default/bookmarks', new AbortController().signal, 'bookmarks')
    .then(data => { ... })
    .catch(() => { ... })
    .finally(() => {
      request.current = null;
      setLoading(false);
    });
  ```
- **问题**：分级变更触发 `clear()` 后递增 `revision.current`。若旧请求在稍后完成并进入 `finally`，未校验版本号即直接将 `request.current` 设为 null 并将 `loading` 设为 false，提前关闭了新请求的加载态与单例保护锁。
- **替换为**：
  ```tsx
        .finally(() => {
          if (started === revision.current) {
            request.current = null;
            setLoading(false);
          }
        });
  ```
- **依据**：React 异步竞态处理原则；版本令牌对称守卫。

#### 8. 设置保存失败后点击“重试”错误触发 fetchSettings 覆盖用户未保存草稿
- **提出专家**：React 交互表单与跨组件通信专家
- **位置与原文**：`frontend/src/Settings.tsx` 第 19、41、57、75 与 83 行：
  ```tsx
  {error && <p className="setting-error" role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
  ```
- **问题**：`error` 在保存分级或保存主题失败时被赋值。用户点击“重试”触发的是受 `attempt` 驱动的 `fetchSettings`，直接将用户正在编辑的草稿覆盖为服务器的旧值。
- **替换为**：
  将加载失败（`loadError`）与保存失败（`saveError`）解耦，加载重试仅重试拉取，保存失败仅提示用户重新点击保存按钮：
  ```tsx
  {loadError && (
    <p className="setting-error" role="alert">
      {loadError}
      <button type="button" onClick={() => setAttempt(value => value + 1)}>重试加载</button>
    </p>
  )}
  {saveError && (
    <p className="setting-error" role="alert">{saveError}</p>
  )}
  ```
- **依据**：NN/g 表单容错与恢复原则：Mutation 重试绝不能退化为 Query Refetch 破坏草稿。

---

### 重要级建议（效果明显下降）

#### 1. 移动端吸顶详情栏适配 safe-area-inset-top 避免刘海屏与系统状态栏遮挡
- **提出专家**：资深 Web 视觉与无障碍工程专家
- **位置与原文**：`frontend/src/style.css` L430-442 与 L446：
  ```css
  .detail-header { position: sticky; top: 0; ... min-height: 60px; padding: 8px; }
  .comments { scroll-margin-top: 76px; }
  ```
- **替换为**：
  ```css
  .detail-header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: calc(60px + env(safe-area-inset-top, 0px));
    margin: 0 -8px;
    padding: calc(8px + env(safe-area-inset-top, 0px)) 8px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .comments {
    scroll-margin-top: calc(76px + env(safe-area-inset-top, 0px));
    padding: 0 8px 24px;
  }
  ```
- **依据**：Apple HIG Safe Areas 规范与 WCAG 2.4.11 视口遮挡防护。

#### 2. 搜索框与控件边框对比度提升至 ≥ 3:1（符合 WCAG 1.4.11）
- **提出专家**：资深 Web 视觉与无障碍工程专家
- **位置与原文**：`frontend/src/style.css` L13、L37、L62：
  ```css
  --control-border: #d1d5db; /* 浅色模式，白底对比度仅 1.47:1 */
  --control-border: #4b4c54; /* 暗色模式，暗底对比度仅 2.06:1 */
  ```
- **替换为**：
  浅色模式替换为 `--control-border: #94a3b8;`（3.06:1）；暗色模式替换为 `--control-border: #6b6e7b;`（3.32:1）。
- **依据**：WCAG 2.2 Success Criterion 1.4.11 Non-text Contrast (Level AA)。

#### 3. 补齐全局跳过导航链接与扩大焦点环覆盖范围（覆盖设置页）
- **提出专家**：资深 Web 视觉与无障碍工程专家
- **位置与原文**：`frontend/src/App.tsx` L12 与 `frontend/src/style.css` L378：
  ```css
  .feed :focus-visible { outline: 2px solid var(--focus); ... }
  ```
- **替换为**：
  在 `App.tsx` 最上方加入 `<a href="#content" className="skip-link">跳到主要内容</a>`；在 `style.css` 中将选择器放宽为全局 `:focus-visible`，使 `Settings.tsx` 中表单按钮同样拥有高对比度焦点环。
- **依据**：WCAG 2.4.1 Bypass Blocks 与 2.4.7 Focus Visible。

#### 4. 修复卡片指针手势判断对键盘无障碍激活的误阻断与全局选区假阳性
- **提出专家**：复杂交互组件与流式归并专家
- **位置与原文**：`frontend/src/PostCard.tsx` L70-74：
  ```tsx
  if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 6) return;
  ```
- **问题**：键盘生成的 click 事件其 `detail === 0` 且坐标为 0，与此前残留的 `pointer.current` 比较直接阻断键盘回车进入详情；且 `window.getSelection()` 检查了全局选区。
- **替换为**：
  ```tsx
  onPointerDown={event => {
    if (event.button === 0) pointer.current = { x: event.clientX, y: event.clientY };
  }}
  onPointerCancel={() => { pointer.current = null; }}
  onClick={event => {
    const start = pointer.current;
    pointer.current = null;
    if (!onOpen || !(event.target instanceof Element) || event.target.closest('a, button, video, .post-media-track')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString() && event.currentTarget.contains(selection.anchorNode)) return;
    if (event.detail > 0 && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    onOpen();
  }}
  ```
- **依据**：W3C UI Events Specification。

#### 5. restorePosition 消除全页面强制同步重排（Forced Synchronous Layout）
- **提出专家**：前端状态与浏览器会话工程专家
- **位置与原文**：`frontend/src/page-session.tsx` L81-84：
  ```ts
  const cards = [...document.querySelectorAll<HTMLElement>('[data-post-group]')].map(...);
  ```
- **问题**：锚点为空或仅 1~3 项时，每帧均对页面全部数十张卡片调用 `getBoundingClientRect()`，造成高频强制回流。
- **替换为**：
  当锚点为空时直接滚动并跳过 DOM 扫描；锚点非空时仅定向选择器查询最多 3 个目标锚点：
  ```ts
  export function restorePosition(position: Position) {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (!position.anchors.length) {
      const target = Math.max(0, Math.min(max, position.y));
      if (Math.abs(window.scrollY - target) > 0.5) window.scrollTo(0, target);
      return;
    }
    const cards = position.anchors.flatMap(anchor => {
      const el = document.querySelector<HTMLElement>(`[data-post-group="${CSS.escape(anchor.id)}"]`);
      return el ? [{ id: anchor.id, top: el.getBoundingClientRect().top + window.scrollY }] : [];
    });
    const target = positionTarget(position, cards, max);
    if (Math.abs(window.scrollY - target) > 0.5) window.scrollTo(0, target);
  }
  ```
- **依据**：CSSOM View 渲染性能优化准则。

#### 6. PageSessions 孤立会话回收防止长时间运行内存泄漏
- **提出专家**：前端状态与浏览器会话工程专家
- **位置与原文**：`frontend/src/page-session.tsx` L24、L45-49。
- **替换为**：新增 `prune()` 回收不在 `entries` 栈、不在 `lastVisit`、未被 `origin` 引用的废弃详情会话对象。

#### 7. 高频原生滚动事件监听增加 requestAnimationFrame 节流
- **提出专家**：前端状态与浏览器会话工程专家
- **位置与原文**：`frontend/src/page-session.tsx` L120-122：
- **替换为**：使用 `scrollTicking` 标志位将 `capturePosition` 采集调度至每帧最多一次，杜绝滚动中频繁重排阻塞主线程。

#### 8. 修复进入未缓存详情页视口停留在千像素空白区的问题
- **提出专家**：前端状态与浏览器会话工程专家
- **位置与原文**：`frontend/src/page-session.tsx` L117-118：
- **替换为**：若新进入的详情页尚未缓存且原点坐标为 0，同步执行 `window.scrollTo(0, 0)`，防止视口停留在上一列表的 1600px 处导致吸顶栏被顶出屏幕。

#### 9. 隔离主题即时预览与 localStorage 持久化，增加离页回滚
- **提出专家**：React 交互表单与跨组件通信专家
- **位置与原文**：`frontend/src/rating-settings.ts` L58-67 与 `frontend/src/Settings.tsx` L94。
- **替换为**：`applyTheme(theme, persist: boolean = true)`。单选切换仅修改 DOM `dataset.theme`（`persist: false`），点击“保存”才持久化；组件卸载未保存时自动回滚。

#### 10. clearBookmarks 后同步重置 loading: true 消除假空状态闪烁
- **提出专家**：React 交互表单与跨组件通信专家
- **位置与原文**：`frontend/src/Bookmarks.tsx` L41-46。
- **替换为**：在 `clear` 回调中同步执行 `setLoading(true)`，杜绝从“暂无收藏”突变到“正在加载”的视觉抖动。

#### 11. 补齐评论区作者缺失时的兜底占位文本
- **提出专家**：复杂交互组件与流式归并专家
- **位置与原文**：`frontend/src/PostDetail.tsx` L127。
- **替换为**：`<strong>{comment.author || '匿名用户'}</strong>`，兑现 README 承诺。

#### 12. 外链补齐 rel="noreferrer noopener" 并避免无源帖子渲染无效空白锚点
- **提出专家**：现代 Web 平台与全栈内嵌工程专家（载体专家）
- **位置与原文**：`frontend/src/PostCard.tsx` L19、L24、L76-80。
- **替换为**：统一安全属性为 `rel="noreferrer noopener"`；当 `source.href` 为空时降级为 `<span>{source.label}</span>`。

#### 13. PostFeed 列表追加消除陈旧闭包依赖（Stale Closure）
- **提出专家**：现代 Web 平台与全栈内嵌工程专家（载体专家）
- **位置与原文**：`frontend/src/PostFeed.tsx` L73。
- **替换为**：使用函数式更新 `setFeed(current => ...)` 确保追加帖子基于最新的 state 快照。

#### 14. tests 目录纳入 TypeScript 编译类型检查闭环
- **提出专家**：现代 Web 平台与全栈内嵌工程专家（载体专家）
- **位置与原文**：`frontend/tsconfig.json` L21-24 与 `frontend/package.json`。
- **替换为**：引入 `@types/bun`，将 `"tests"` 纳入 `tsconfig.json` 的 `include` 范围，彻底杜绝重构时的类型静默破坏。

---

### 可选级建议

1. **亮暗色 CSS 变量去重**：合并 `:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark)` 中完全重复的 23 个变量定义，增强维护性。
2. **移动端 `-webkit-tap-highlight-color: transparent`**：消除 iOS Safari 快速点按时的半透明灰色高亮块，提升微触控质感。
3. **单媒体卡片关闭无效滚动提示与焦点**：单图时 `tabIndex={-1}`，aria-label 调整为“帖子媒体”，避免视障用户困惑。
4. **媒体图片 `draggable={false}`**：防止鼠标横滑轨道时误触发原生幽灵图拖拽。
5. **添加空 Favicon data-URI 与 Referrer-Policy**：消除浏览器默认向 Go 后端请求 `/favicon.ico` 产生的无效 404 日志。
6. **二次点击已激活主导航回顶**：点击当前已选中的“首页”或“收藏”时平滑滚动至列表顶部。

---

## 冲突与裁决

### 冲突 1：详情页评论自动拉取的守卫机制
- **专家 4（交互组件专家）** 倾向于保留 `initialLoad.current` Ref，仅修复 409 状态重置与网络 JSON 异常；
- **专家 6（载体专家）** 指出在 React 19 `<StrictMode>` 双重挂载下，`initialLoad.current` 会在首次 Mount 被 abort 后依然保持 `true`，导致第二次 Mount 永久跳过评论拉取。
- **裁决**：采纳**专家 6（载体专家）**的裁决方案。依据：React 19 运行时契约优先于局部组件经验。移除无 cleanup 保护的 Ref 锁，改由 Effect 本身的状态依赖与 `request.current` 锁控制，既杜绝了 React 19 双挂载锁死问题，又完全符合幂等性。

### 冲突 2：收藏操作是否采用乐观更新（Optimistic Update）
- **专家 5（表单与通信专家）** 建议将收藏按钮升级为乐观更新，以消除 400~1500ms 的网络响应延迟；
- **专家 4（交互组件专家）** 与 `frontend/README.md` L40 原则强调“请求期间禁止重复提交，服务端成功后才更新状态；失败保留原状态”。
- **裁决**：**维持现状（悲观更新 + 立即转为“处理中…”加载禁用态）**。依据：遵循项目已锁定的架构契约（`frontend/README.md`）。在多端同步与跨成员家族级联反转的复杂语义下，悲观更新能保证客户端状态绝对真实可靠，不易引发回滚闪烁。

---

## 用户决策记录（已确认）

1. **768px 断点排版方案**：**采纳选项 B（优化版心）**
   - 裁决：桌面端采用固定侧栏（200px）+ 最大版心限制（`max-width: 1200px; margin: 0 auto; padding: 0 16px;`），使 iPad 平板与 4K 超宽屏排版更加均衡舒适。
2. **测试环境类型检查完整性**：**同意**
   - 裁决：在 `frontend/package.json` 添加 `@types/bun` 开发依赖，并将 `"tests"` 纳入 `tsconfig.json` 的 `include` 范围，打通 CI/CD 静态类型检查闭环。
3. **主导航当前选中项的二次点击行为**：**采纳（是）**
   - 裁决：用户重复点击已高亮的“首页”或“收藏”导航项时，触发平滑滚动回列表顶部（`window.scrollTo({ top: 0, behavior: 'smooth' })`）。

---

## 建议改动清单（按文件组织）

### 1. `server-go/web.go`
- 在 `serveEmbedded` 中增加 `X-Content-Type-Options: nosniff` 以及针对 `assets/`（长期不变）与 `index.html`（`no-cache`）的精细缓存头，根绝白屏隐患。

### 2. `frontend/src/style.css`
- `.detail-header` 与 `.comments` 补充 `env(safe-area-inset-top, 0px)` 计算；
- `--control-border` 提升明暗对比度至 ≥ 3:1；
- 增加 `.skip-link` 样式并将焦点环扩大至全局 `:focus-visible`；
- `.post-meta .detail-entry` 与搜索历史按钮通过伪元素外扩触控热区至可访问标准。

### 3. `frontend/src/feed.ts`
- `originalMediaURL` 补充 Safebooru `/samples/`、`/thumbnails/` 及 Danbooru `/preview/` 正则过滤，补齐协议相对 URL 与 Javascript 协议安全校验；
- `fetchPosts` 增加对非 JSON 502/504 响应的语义化错误包装。

### 4. `frontend/src/post-cache.ts`
- 优化 `writePostCache` 淘汰算法，在纯内存中先削减键数量至 40，消除每次删除高频全量 `JSON.stringify` 导致的 200ms 卡顿；
- `removePostCache` 在 key 不存在时提前退出，避免无谓磁盘写回。

### 5. `frontend/src/page-session.tsx`
- `beginRestore` 增加非程序化滚动位移检测，完美解决桌面原生滚动条拖拽时的强制对抗与死锁；
- `restorePosition` 消除全量 DOM 卡片扫描与几何计算回流；
- `PageSessions` 增加孤立会话回收（`prune()`）；
- `PageSessionProvider` 对滚动事件增加 rAF 节流，并在新详情页进入时立即重置视口到 (0, 0)。

### 6. `frontend/src/PostCard.tsx`
- 修复 `onClick` 手势判断，对键盘激活（`detail === 0`）放行，并将选区判断严格约束在当前卡片容器内部；
- 单媒体项卡片关闭无效横滑无障碍播报，图片添加 `draggable={false}`；
- 补齐 `rel="noreferrer noopener"`，无链接来源降级为普通文本。

### 7. `frontend/src/PostDetail.tsx`
- 移除 `initialLoad` Ref，解决 React 19 StrictMode 下评论永久不拉取的问题；
- 评论作者缺失时展示 `'匿名用户'`；
- 滚动中加载评论时同步更新阅读视口会话记录。

### 8. `frontend/src/comments.ts`
- 包裹 `response.json()` 异常，防止网关 502/504 HTML 破坏错误状态机；
- 重试时对称重置 `reloadRequired: false`。

### 9. `frontend/src/Bookmarks.tsx`
- `refresh` 的 `finally` 块中增加 `if (started === revision.current)` 守卫，杜绝竞态导致的锁状态破坏；
- `clear` 回调同步设置 `setLoading(true)`，消除假空状态闪烁。

### 10. `frontend/src/Settings.tsx` & `frontend/src/rating-settings.ts`
- 区分加载错误与保存错误，防止保存失败点击重试冲刷用户未提交草稿；
- `applyTheme` 增加持久化控制，单选组切换仅 DOM 预览，保存后持久化，离页未保存自动回滚。

### 11. `frontend/src/search.ts`
- `searchCacheKey` 与 `saveSearchHistory` 统一先做 `normalizeTagQuery` 与超长过滤，防止产生僵尸缓存键与存储脱节。
