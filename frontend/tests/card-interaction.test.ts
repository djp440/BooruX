import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import PostCard, { canOpenCard } from '../src/PostCard';
import { BookmarkProvider } from '../src/Bookmarks';
import type { Post } from '../src/feed';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function createPost(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    title: `Post ${id}`,
    imageUrl: `https://danbooru.donmai.us/${id}.jpg`,
    mediaType: 'image',
    parentId: null,
    hasChildren: false,
    tags: [{ id: '1', name: 'landscape', category: 'general' }],
    ...overrides,
  };
}

describe('卡片手势无障碍、选区精准化与外链安全加固', () => {
  describe('卡片点击决策函数 canOpenCard', () => {
    const fakeCard = {
      contains: (node: Node | null) => (node as any) === 'inside' || (typeof node === 'object' && node !== null && (node as any).isInside === true),
    };

    function fakeElement(tag: string, className = '', closestResult: any = null) {
      return {
        tagName: tag.toUpperCase(),
        className,
        closest: (selector: string) => {
          if (closestResult) return closestResult;
          const selectors = selector.split(',').map(s => s.trim());
          if (selectors.includes(tag.toLowerCase()) || selectors.includes(`.${className}`)) {
            return { tagName: tag, className };
          }
          return null;
        },
      };
    }

    test('键盘回车或空格激活卡片时，由于 detail === 0，不被位移阻断，能够正常打开详情', () => {
      let opened = false;
      const target = fakeElement('div', 'post-card');
      // 残留了之前鼠标/触控留下的旧坐标 (100, 100)
      const pointerStart = { x: 100, y: 100 };
      // 键盘点击事件坐标通常为 (0, 0)，detail 为 0
      const currentPointer = { x: 0, y: 0 };
      const canOpen = canOpenCard(
        target,
        fakeCard,
        0, // detail === 0
        pointerStart,
        currentPointer,
        null,
        true
      );
      if (canOpen) opened = true;
      expect(opened).toBe(true);
    });

    test('触控 Slop 容差：<= 8px 允许打开，> 8px 判定为滑动/拖拽并阻断', () => {
      const target = fakeElement('div', 'post-card');
      const start = { x: 50, y: 50 };

      // 6px 位移（<= 8px，轻微形变放行）
      expect(canOpenCard(target, fakeCard, 1, start, { x: 56, y: 50 }, null, true)).toBe(true);
      // 8px 位移（边界放行）
      expect(canOpenCard(target, fakeCard, 1, start, { x: 50, y: 58 }, null, true)).toBe(true);
      // 9px 位移（> 8px 阻断）
      expect(canOpenCard(target, fakeCard, 1, start, { x: 59, y: 50 }, null, true)).toBe(false);
      // 20px 位移（明确拖拽阻断）
      expect(canOpenCard(target, fakeCard, 1, start, { x: 70, y: 50 }, null, true)).toBe(false);
    });

    test('选区精准化：仅当前卡片内部有非空选区时才阻断导航，外部选区或空选区不阻断', () => {
      const target = fakeElement('div', 'post-card');
      const start = { x: 50, y: 50 };

      // 卡片内部选中了文本 -> 阻断
      const insideSelection = {
        isCollapsed: false,
        toString: () => 'selected tag text',
        anchorNode: 'inside' as unknown as Node,
      };
      expect(canOpenCard(target, fakeCard, 1, start, { x: 50, y: 50 }, insideSelection, true)).toBe(false);

      // 卡片内部选区已折叠（光标轻点但未选中文本） -> 不阻断
      const collapsedSelection = {
        isCollapsed: true,
        toString: () => '',
        anchorNode: 'inside' as unknown as Node,
      };
      expect(canOpenCard(target, fakeCard, 1, start, { x: 50, y: 50 }, collapsedSelection, true)).toBe(true);

      // 其他卡片或页面其他区域选中文本 -> 不影响本卡片打开
      const outsideSelection = {
        isCollapsed: false,
        toString: () => 'some text elsewhere',
        anchorNode: 'outside' as unknown as Node,
      };
      expect(canOpenCard(target, fakeCard, 1, start, { x: 50, y: 50 }, outsideSelection, true)).toBe(true);
    });

    test('防穿透：点击底栏、顶栏元信息或操作按钮时不触发卡片打开', () => {
      const start = { x: 50, y: 50 };

      // 点击底栏操作区
      const actionsTarget = fakeElement('div', 'post-actions', {});
      expect(canOpenCard(actionsTarget, fakeCard, 1, start, { x: 50, y: 50 }, null, true)).toBe(false);

      // 点击顶栏元信息
      const metaTarget = fakeElement('header', 'post-meta', {});
      expect(canOpenCard(metaTarget, fakeCard, 1, start, { x: 50, y: 50 }, null, true)).toBe(false);

      // 点击按钮/链接/多媒体轨道
      const buttonTarget = fakeElement('button', '', {});
      expect(canOpenCard(buttonTarget, fakeCard, 1, start, { x: 50, y: 50 }, null, true)).toBe(false);
      const aTarget = fakeElement('a', '', {});
      expect(canOpenCard(aTarget, fakeCard, 1, start, { x: 50, y: 50 }, null, true)).toBe(false);
      const trackTarget = fakeElement('div', 'post-media-track', {});
      expect(canOpenCard(trackTarget, fakeCard, 1, start, { x: 50, y: 50 }, null, true)).toBe(false);
    });
  });

  describe('PostCard 渲染与属性规范', () => {
    test('单图无障碍：tabIndex 设为 -1，无障碍标签为普通“帖子媒体”，不播报“可横向滚动”', () => {
      const post = createPost('danbooru-1');
      const html = renderToString(
        React.createElement(BookmarkProvider, null,
          React.createElement(PostCard, { id: 'danbooru-1', posts: [post], onOpen: () => {}, onComments: () => {} })
        )
      );

      // 单图卡片媒体轨道 tabIndex="-1"
      expect(html).toContain('tabindex="-1"');
      // aria-label 为“帖子媒体”
      expect(html).toContain('aria-label="帖子媒体"');
      expect(html).not.toContain('可横向滚动');
    });

    test('多图无障碍：tabIndex 设为 0，播报“共 N 项，可横向滚动”', () => {
      const p1 = createPost('danbooru-1');
      const p2 = createPost('danbooru-2');
      const html = renderToString(
        React.createElement(BookmarkProvider, null,
          React.createElement(PostCard, { id: 'danbooru-1', posts: [p1, p2], onOpen: () => {}, onComments: () => {} })
        )
      );

      expect(html).toContain('tabindex="0"');
      expect(html).toContain('aria-label="帖子媒体，共 2 项，可横向滚动"');
    });

    test('外链安全加固：统一包含 rel="noreferrer noopener"，无原站地址时降级为纯文本', () => {
      const postWithSource = createPost('danbooru-123');
      const htmlWithSource = renderToString(
        React.createElement(BookmarkProvider, null,
          React.createElement(PostCard, { id: 'danbooru-123', posts: [postWithSource], onOpen: () => {}, onComments: () => {} })
        )
      );

      // 有原站链接时带安全属性
      expect(htmlWithSource).toContain('rel="noreferrer noopener"');
      expect(htmlWithSource).toContain('href="https://danbooru.donmai.us/posts/123"');

      // 无原站链接时降级为纯文本 span，不渲染无效 <a>
      const postWithoutSource = createPost('unknown-999');
      const htmlWithoutSource = renderToString(
        React.createElement(BookmarkProvider, null,
          React.createElement(PostCard, { id: 'unknown-999', posts: [postWithoutSource], onOpen: () => {}, onComments: () => {} })
        )
      );

      expect(htmlWithoutSource).toContain('<span>unknown-999</span>');
      // header 中不应包含指向 unknown 的 <a>
      expect(htmlWithoutSource).not.toContain('href="undefined"');
    });

    test('提供 onOpen 时卡片自身可键盘聚焦 (tabIndex=0)', () => {
      const post = createPost('danbooru-1');
      const htmlWithOpen = renderToString(
        React.createElement(BookmarkProvider, null,
          React.createElement(PostCard, { id: 'danbooru-1', posts: [post], onOpen: () => {}, onComments: () => {} })
        )
      );
      expect(htmlWithOpen).toContain('<article class="post-card" data-post-group="danbooru-1" aria-label="帖子 danbooru-1" tabindex="0"');

      const htmlWithoutOpen = renderToString(
        React.createElement(BookmarkProvider, null,
          React.createElement(PostCard, { id: 'danbooru-1', posts: [post], onComments: () => {} })
        )
      );
      expect(htmlWithoutOpen).not.toContain('<article class="post-card" data-post-group="danbooru-1" aria-label="帖子 danbooru-1" tabindex="0"');
    });
  });

  describe('CSS 样式规范静态断言', () => {
    const cssPath = resolve(__dirname, '../src/style.css');
    const css = readFileSync(cssPath, 'utf-8');

    test('媒体轨道视口单位优化与渲染跳过', () => {
      // 50svh
      expect(css).toContain('height: clamp(240px, 50svh, 560px);');
      // content-visibility: auto 与 contain-intrinsic-size
      expect(css).toContain('content-visibility: auto;');
      expect(css).toContain('contain-intrinsic-size: auto 500px;');
    });

    test('横向轨道吸附、隐藏粗滚动槽与防拖拽', () => {
      expect(css).toContain('scroll-snap-type: x mandatory;');
      expect(css).toContain('scrollbar-width: none;');
      expect(css).toContain('display: none');
      expect(css).toContain('scroll-snap-align: center;');
      expect(css).toContain('-webkit-user-drag: none;');
      expect(css).toContain('user-select: none;');
    });

    test('标签列表防拖拽穿透', () => {
      expect(css).toContain('overscroll-behavior: contain;');
      expect(css).toContain('touch-action: pan-y;');
    });

    test('物理非对称按压与收藏 260ms 轻弹微动效及 82px 防挤压', () => {
      // 82px 最小宽度防挤压
      expect(css).toContain('min-width: 82px;');
      // 非对称 70ms 按下，180ms 释放
      expect(css).toContain('180ms');
      expect(css).toContain('70ms');
      // bookmark-pop 动画与 scale(1.26)
      expect(css).toContain('@keyframes bookmark-pop');
      expect(css).toContain('scale(1.26)');
      expect(css).toContain('260ms');
      // prefers-reduced-motion: reduce 降级
      expect(css).toContain('prefers-reduced-motion: reduce');
    });
  });
});
