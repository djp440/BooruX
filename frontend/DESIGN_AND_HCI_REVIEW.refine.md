# 内容强化报告：BooruX 布局、视觉效果与人机交互（HCI）专项评审

审阅方式：独立并行子代理（5 位领域顶尖专家）
目标与载体：BooruX Web 客户端在桌面（4K/1080p/笔记本）、平板（iPad 竖屏 768px、横屏 1024px）与移动设备（iOS Safari、Android Chrome、全面屏）各型视口下的流体响应式布局、视觉风格系统、Apple 流体动效与人机交互（HCI）工效学。

---

## 结论

本次专项评审深度聚焦于**布局流体性**、**视觉层次系统**、**微交互动效**与**人机工效学（HCI）**。当前前端在无重型第三方 UI 库的约束下完成了极佳的纯原生实现，但在真实多设备视口与指尖触控交互上，仍有以下 **3 处最关键的全局体验断层**亟待打磨：

1. **移动端视口与手势边界契约缺陷（阻断级）**：
   - `index.html` 的 `<meta name="viewport">` 遗漏 `viewport-fit=cover`，导致 iOS Safari 下所有 `env(safe-area-inset-*)` 强制失效返回 `0px`，底部导航条被系统 Home Indicator 彻底遮挡失灵；
   - 媒体轨道高度采用 `50dvh`，在移动端上下滚动时随地址栏伸缩引发全页面所有卡片的**级联强制回流（Layout Thrashing）**，应替换为几何恒定的 `50svh`；
   - 桌面端 768px 断点尚未落地已确认的“200px 侧栏 + 1200px 居中版心”方案。
2. **人机工效学与键盘焦点链中断（重要级）**：
   - “加载更多”与“取消更改”按钮在被激活后立即从 DOM 中卸载销毁，导致浏览器焦点跌落重置至 `document.body`，键盘与读屏器用户被迫从页面最顶端重新逐项 Tab；
   - 卡片手势判断对键盘回车激活（`detail === 0`）误阻断；操作栏周围缝隙缺失误触防护；
   - 移动端标签搜索输入框缺少 `enterKeyHint="search"` 与 `autoCorrect="off"`，软键盘操作摩擦力大。
3. **视觉层次与流体微质感缺失（重要级）**：
   - 单选卡片选中态对比度仅 1.05:1 且边框复用了 `--disabled`（禁用态令牌表达积极选中态），视觉几乎不可辨；
   - 评论正文字号未控制（继承 16px 浏览器根字阶，喧宾夺主），且默认段落边距导致留白失衡；
   - 按钮按压缺少物理非对称性（按下需瞬时 70ms，抬起 180ms 张力平滑），媒体横滑轨道未隐藏粗糙桌面槽线且未阻断图片原生拖拽虚影。

---

## 拆解与专家

| 部分 | 涵盖范围与原文位置 | 专家角色 |
| --- | --- | --- |
| 1. 信息架构与多端流体布局 | `src/style.css` (布局网格、媒体查询、断点、app-shell)、`src/App.tsx` (Layout 骨架) | 资深 Web 响应式架构与版式设计专家（专精多断点版心与流体栅格系统） |
| 2. 视觉风格系统、色彩层级与微质感 | `src/style.css` (CSS 变量、卡片材质、标签、按钮、字体与提示) | 现代数字产品视觉系统设计师（专精暗黑模式色彩层级、阴影材质与留白节奏） |
| 3. 多媒体流体交互与手势微动效 | `src/style.css` (横滑轨道、动效与 transition)、`src/PostCard.tsx` (Media 与操作按钮) | 流体动效与手势交互工程专家（专精 Apple 流体物理手势、微交互与触控反馈） |
| 4. 人机工效学、触控热区与表单链路 | `src/PostCard.tsx`、`src/PostFeed.tsx` (搜索表单与历史)、`src/Settings.tsx` (单选卡片) | 人机交互（HCI）与用户工效学专家（专精移动手势容错、可点击热区与操作链路） |
| 5. 现代 Web 渲染流水线与多端浏览器载体 | 全局前端代码、CSS 复合层与 HTML 宿主 | Web 渲染流水线与多端浏览器载体专家（载体专家，专精 CSS 复合层、触摸事件流水线与跨引擎兼容性） |

---

## 优化建议

### 阻断级建议（载体无法正确执行或结果明显偏离目标）

#### 1. 宿主 HTML Viewport 补齐 viewport-fit=cover 激活真机安全区
- **提出专家**：Web 渲染流水线与多端浏览器载体专家（载体专家）、响应式架构专家
- **位置与原文**：`frontend/index.html` 第 5 行：
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ```
- **问题**：在 iOS Safari 与各大移动 WebKit 内核中，如果 Viewport 元信息未显式声明 `viewport-fit=cover`，浏览器会将渲染限制在物理安全矩形内，**强制使 CSS 中的所有 `env(safe-area-inset-*)` 恒等于 `0px`**！这使得现有的底部导航栏 `padding-bottom` 计算完全失效，导致底栏图标与 iPhone 底部黑条（Home Indicator）发生物理重叠，触控导航经常被系统手势抢占。
- **替换为**：
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  ```
- **依据**：W3C CSS Round Display / Apple WebKit Viewport 规范。

#### 2. 桌面端 768px 断点排版落地“200px 固定侧栏 + 1200px 居中版心”（已确认决策）
- **提出专家**：资深 Web 响应式架构与版式设计专家
- **位置与原文**：`frontend/src/style.css` 第 383–388 行：
  ```css
  @media (min-width: 768px) {
    .app-shell {
      display: grid;
      grid-template-columns: 25% minmax(0, 1fr);
      padding: 0 15%;
    }
  ```
- **问题**：现行 15% 边距在 768px 平板竖屏下将主内容压缩至 403px（比手机还窄），而在 4K 宽屏下拉伸至 2016px 导致视线涣散。必须落实已确认的选项 B。
- **替换为**：
  ```css
  @media (min-width: 768px) {
    .app-shell {
      display: grid;
      grid-template-columns: 200px minmax(0, 1fr);
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 16px;
    }
  ```
- **依据**：`HUM_MEMO.md` 2026-10-21 实施规范第 1 项。

#### 3. 设置保存失败后点击“重试”错误冲刷用户未保存草稿
- **提出专家**：人机交互（HCI）与用户工效学专家
- **位置与原文**：`frontend/src/Settings.tsx` 第 83 行：
  ```tsx
  {error && <p className="setting-error" role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
  ```
- **问题**：保存失败时，全局错误条展示“重试”并绑定了受 `attempt` 驱动的 `fetchSettings`，导致用户正在编辑但未保存成功的本地草稿被直接冲刷为服务器旧配置，严重违背用户对“重试提交保存”的心智预期。
- **替换为**：解耦加载重试与保存重试，保存失败时仅提示错误，引导用户再次点击保存按钮，不提供破坏性的重拉取。
- **依据**：NN/g 错误恢复与容错原则。

---

### 重要级建议（效果明显下降）

#### 1. 媒体轨道高度采用 50svh 替代 50dvh 消除移动端滚动级联回流
- **提出专家**：Web 渲染流水线与多端浏览器载体专家（载体专家）
- **位置与原文**：`frontend/src/style.css` 第 232 行：
  ```css
  height: clamp(240px, 50dvh, 560px);
  ```
- **问题**：`50dvh` 在移动端上下滚动时随地址栏展开/折叠而高频连续微变，导致列表内每一个在屏与离屏卡片重新计算几何尺寸，引发昂贵的全页强制同步重排（Layout Thrashing），造成 60Hz/120Hz 高刷屏卡顿掉帧。
- **替换为**：
  ```css
  height: clamp(240px, 50svh, 560px);
  ```
- **依据**：CSS Values and Units Module Level 4 中的 `svh` 规范（尺寸稳定不受动态浏览器 UI 影响）。

#### 2. 卡片手势增加防误触区域、放行键盘回车并放宽 Touch Slop
- **提出专家**：人机交互（HCI）与用户工效学专家、载体专家
- **位置与原文**：`frontend/src/PostCard.tsx` 第 71–75 行：
  ```tsx
  onClick={event => {
    if (!onOpen || !(event.target instanceof Element) || event.target.closest('a, button, video, .post-media-track') || window.getSelection()?.toString()) return;
    if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 6) return;
    onOpen();
  }}
  ```
- **问题**：
  1. 触控误触防护间隙缺失：底栏按钮缝隙、顶部元信息栏 `.post-meta` 误触会穿透直接触发进入详情；
  2. 键盘回车激活时 `detail === 0`，残留的 `pointer.current` 导致合法键盘点击被误判为拖拽位移；
  3. 6px 阈值对 OLED 电容屏拇指按压形变过严，正常轻点易被误丢弃。
- **替换为**：
  ```tsx
  onClick={event => {
    if (!onOpen || !(event.target instanceof Element) || event.target.closest('a, button, video, .post-media-track, .post-actions, .post-meta, .post-notice')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString() && event.currentTarget.contains(selection.anchorNode)) return;
    const isKeyboardClick = event.detail === 0 && event.clientX === 0 && event.clientY === 0;
    if (!isKeyboardClick && pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8) return;
    pointer.current = null;
    onOpen();
  }}
  ```
- **依据**：W3C UI Events 规范与 Apple HIG Touch Slop 容差标准。

#### 3. “加载更多”与“取消更改”元素卸载导致键盘焦点丢失跌落修复
- **提出专家**：人机交互（HCI）与用户工效学专家
- **位置与原文**：`frontend/src/PostFeed.tsx` 第 111 行与 `frontend/src/Settings.tsx` 第 100/117 行。
- **问题**：按钮激活后直接从 DOM 树中销毁，导致浏览器焦点上下文被重置至 `document.body`，用户必须从页面最顶部重新 Tab 数十次。
- **替换为**：
  - `PostFeed.tsx`：“加载更多”加载中采用 `disabled={displayedLoading}` + `aria-busy` 原地保留焦点；
  - `Settings.tsx`：点击“取消更改”时主动将焦点回退至同一表单内的 `submit` 按钮。
- **依据**：WCAG 2.2 SC 2.4.3 Focus Order。

#### 4. 根级 scrollbar-gutter 消除桌面视口滚动条切换引发的版心居中抖动（CLS）
- **提出专家**：资深 Web 响应式架构与版式设计专家
- **位置与原文**：`frontend/src/style.css` 第 76–85 行。
- **问题**：在 Windows/Linux 桌面系统上，长短页面或列表异步追加产生滚动条时，`margin: 0 auto` 导致页面整体向左瞬间闪跳 8.5px，破坏视觉稳定性。
- **替换为**：在 `html` 选择器中配置 `scrollbar-gutter: stable;`。
- **依据**：W3C CSS Box Model Module Level 4；Web Vitals CLS 指标。

#### 5. 浅色模式单选卡片选中态对比度增强与语义修正
- **提出专家**：现代数字产品视觉系统设计师
- **位置与原文**：`frontend/src/style.css` 第 16 行与第 415 行：
  ```css
  --selected-bg: #f9fafb; /* 对比度仅 1.05:1 */
  .rating-option:has(input:checked) { border-color: var(--disabled); background: var(--selected-bg); }
  ```
- **替换为**：
  浅色 `--selected-bg: #f3f4f6;`；选中边框变更为 `border-color: var(--text);`，消除禁用态令牌反向表达积极选中态的问题。
- **依据**：Refactoring UI 积极状态视觉反馈原则；WCAG 1.4.11。

#### 6. 统一原站评论正文字阶与重置段落垂直留白
- **提出专家**：现代数字产品视觉系统设计师
- **位置与原文**：`frontend/src/style.css` 第 449–453 行。
- **问题**：`.comment-body` 未声明字号直接继承 16px，大过标题和操作栏；浏览器默认 `<p>` margin 导致垂直间距失衡。
- **替换为**：
  ```css
  .comment {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 0;
    border-top: 1px solid var(--border);
  }
  .comment-body {
    margin: 2px 0 0;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  ```
- **依据**：Refactoring UI Modular Type Scale 与垂直留白节奏原则。

#### 7. 媒体横滑轨道使用 mandatory 吸附、隐藏桌面粗槽并禁用图片拖拽
- **提出专家**：流体动效与手势交互工程专家
- **位置与原文**：`frontend/src/style.css` 第 228–238 行与第 263–269 行。
- **问题**：`proximity` 邻近吸附停靠破碎；桌面出现粗大横向滚动槽；图片鼠标拖拽触发系统半透明虚影。
- **替换为**：
  `scroll-snap-type: x mandatory;`；增加 `scrollbar-width: none;`；图片添加 `-webkit-user-drag: none; user-select: none;`。
- **依据**：Apple Fluid Interfaces 原则第 2 条（直接操纵）与第 6 条（动量投射）。

#### 8. 按压物理非对称反馈（按下 70ms，释放 180ms 张力）与收藏轻弹动效
- **提出专家**：流体动效与手势交互工程专家
- **位置与原文**：`frontend/src/style.css` 第 340–347 行与第 364–372 行。
- **问题**：按下与抬起共用 160ms 迟滞感强；收藏硬切无形变反馈；收藏按钮在 2 字与 3 字之间跳变导致布局挤压。
- **替换为**：
  - 按下 `:active` 耗时 70ms 瞬时下沉，释放 180ms 弹性平滑恢复；
  - 收藏激活触发 260ms 轻弹微动效（`scale(1.26)` overshoot 弹簧阻尼）；
  - 收藏按钮设定 `min-width: 82px` 吸收文案字数差异，杜绝同层挤压。
- **依据**：Apple Fluid Interfaces 原则第 1 条（Kill latency）与第 11 条（Frame-level smoothness）。

#### 9. 引入 content-visibility: auto 隔离离屏 4K 大图释放 GPU 显存
- **提出专家**：Web 渲染流水线与多端浏览器载体专家（载体专家）
- **位置与原文**：`frontend/src/style.css` 第 178–188 行。
- **问题**：信息流长列表直接加载数十张 4K/8K 原图，离屏位图持续驻留 GPU 显存，极易导致移动端（尤其是 iOS WebKit）WebContent 进程 OOM 崩溃。
- **替换为**：
  在 `.post-card` 中增加 `content-visibility: auto; contain-intrinsic-size: auto 500px;`。
- **依据**：W3C CSS Containment Level 2 / Chromium 渲染生命周期规范。

#### 10. 标签列表与固定/粘性导航栏的合成层与滚动穿透隔离
- **提出专家**：Web 渲染流水线与多端浏览器载体专家（载体专家）
- **位置与原文**：`frontend/src/style.css` 第 94–102 行、第 207–218 行、第 430–442 行。
- **替换为**：
  - `.post-tags` 补充 `overscroll-behavior: contain; touch-action: pan-y;`，杜绝子容器滚动到头后拖动整个主页；
  - `.navigation` 与 `.detail-header` 补充 `transform: translateZ(0);`，提升为独立硬件加速合成层，消除 120Hz 下的滚动毛刺。

---

### 可选级建议（锦上添花体验）

1. **移动端搜索输入框键盘意图优化**：在 `<input id="tag-search">` 上增加 `enterKeyHint="search"` 与 `autoCorrect="off"`，避免英文专有标签被 iOS 词典自动纠错，虚拟键盘回车键精准显示为“搜索”。
2. **错误状态情绪化着色**：`.post-notice[role="alert"], .feed-notice[role="alert"] { color: var(--error); }`，使网络失败与普通缓存提示形成清晰视觉区分。
3. **卡片微阴影层次提升**：增加 `--card-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px -1px rgba(0, 0, 0, 0.04);`，让卡片在同色画布上自然浮起。
4. **全站文字抗锯齿与中西文字体栈**：引入 PingFang SC / Microsoft YaHei 回退，开启 `-webkit-font-smoothing: antialiased;`，杜绝暗色模式高对比字形边缘溢色发虚。
5. **细滚动条系统（Scrollbar Thin）**：在标签池与搜索历史列表应用 `scrollbar-width: thin; scrollbar-color: var(--control-border) transparent;`，消除 Windows 17px 原生灰色滚动条侵入。
6. **空搜索结果原地闭环**：在“没有匹配这些标签的帖子”下方原地放置“显示全部”按钮，减少回滑顶部的操作负荷。
7. **减弱动态偏好（Reduced Motion）按压反馈等价退化**：开启减弱动态时，使用轻柔背景色/透明度微调保留按压反馈，而非完全剥夺。

---

## 冲突与裁决

### 冲突 1：卡片媒体高度视口单位选择（`50dvh` vs `50svh`）
- **响应式架构专家** 倾向于保留 `50dvh`（动态适应全屏高度）；
- **载体专家** 指出在无限滚动 Feed 列表中，`dvh` 随用户上下滑动导致浏览器地址栏伸缩而连续变动，触发全页面每一个卡片的反复强制回流（Layout Thrashing），引发滚动手感掉帧。
- **裁决**：采纳**载体专家**建议，使用 `50svh`。小视口高度在地址栏最大展开时计算，滚动中保持绝对恒定，完美兼顾了移动端卡片高度适配与 120Hz 滚动手感。

### 冲突 2：横滑媒体轨道吸附算法（`proximity` vs `mandatory`）
- **视觉专家** 沿用了 `proximity`（邻近吸附，允许任意位置停靠）；
- **动效专家** 指出 `mandatory` 才能确保在 92% 露边设计下，用户手指滑开后主图精准居中停靠在视野中心，避免停靠在两张图中间导致画面破碎。
- **裁决**：采纳**动效专家**建议，使用 `scroll-snap-type: x mandatory`。卡片媒体轨道是具有明确卡片单元的单项主体展示，`mandatory` 保证了视口停靠的确定性与一致性。

### 冲突 3：触控 Slop 容差阈值（6px vs 8px vs 10px）
- **原代码** 为 6px；**HCI 专家** 建议 8px；**载体专家** 建议 10px。
- **裁决**：统一设置为 `8px`。在 2.5x~3.5x 高 DPI 触控屏上既能完全容纳指腹接触时的生理弹性形变，又保留了鼠标微小防抖的精准度。

---

## 待用户决策

1. **画布底色与卡片表面解耦（Canvas vs. Surface Separation）**：
   - 现状：页面背景与卡片均共用 `--surface`（浅色 `#fff`，深色 `#17181b`），依靠微阴影和边框分割。
   - 增强选项：引入 `--canvas` 变量（浅色 `#f8f9fa`，深色 `#111215`），使卡片在浅灰/深黑幕布上呈现出类似 Apple Photos / GitHub 的卡片层次。此改动会轻微改变现有极简纯白/通透风格，需您确认是否喜欢这种更强的实体卡片感。
2. **超宽屏单列居中流 vs 多列瀑布流（Masonry Grid）**：
   - 在 1200px 版心下，内容区净宽约 952px，当前采用单列居中卡片流，适合单图沉浸鉴赏。若未来有高密度快速扫描诉求，可权衡是否增加双列流排版开关。建议当前阶段维持已锁定的单列优化版心。
