import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { PageSessionProvider } from '../src/page-session';
import { BookmarkProvider } from '../src/Bookmarks';
import PostFeed, { FeedResults } from '../src/PostFeed';
import { writePostCache } from '../src/post-cache';
import { searchCacheKey } from '../src/search';
import type { Post } from '../src/feed';

function mockPost(id: string): Post {
  return { id, parentId: null, title: id, imageUrl: `https://cdn.donmai.us/${id}.png`, mediaType: 'image', hasChildren: false, tags: [] };
}

function setupStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return {
    restore: () => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    },
  };
}

describe('PostFeed 焦点连续性与软键盘体验', () => {
  test('移动端标签搜索输入框补齐 enterKeyHint="search" 与 autoCorrect="off"', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(PageSessionProvider, null,
          React.createElement(BookmarkProvider, null,
            React.createElement(PostFeed, { kind: 'home' })
          )
        )
      )
    );

    // 搜索输入框必须具备 enterKeyHint="search" 与 autoCorrect="off"
    expect(html).toContain('id="tag-search"');
    expect(html).toMatch(/id="tag-search"[^>]*enterkeyhint="search"/i);
    expect(html).toMatch(/id="tag-search"[^>]*autocorrect="off"/i);
  });

  test('搜索无结果时在空状态提示下方原地提供“显示全部”按钮', () => {
    const env = setupStorage();
    try {
      let resetCalled = false;
      const query = 'nonexistent_tag';
      writePostCache(searchCacheKey(query), {
        success: true,
        posts: [],
        nextCursor: '',
      });

      // 渲染无结果的 FeedResults
      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(PageSessionProvider, null,
            React.createElement(BookmarkProvider, null,
              React.createElement(FeedResults, {
                kind: 'home',
                query,
                onReset: () => { resetCalled = true; },
              })
            )
          )
        )
      );

      expect(html).toContain('没有匹配这些标签的帖子，请修改标签或显示全部。');
      // 空状态提示下方原地提供“显示全部”按钮
      expect(html).toMatch(/没有匹配这些标签的帖子，请修改标签或显示全部。<\/p><button type="button">显示全部<\/button>/);
    } finally {
      env.restore();
    }
  });

  test('加载更多按钮在拉取中采用 disabled={displayedLoading} 与 aria-busy 原地保留焦点', () => {
    const env = setupStorage();
    try {
      const query = '';
      const cacheKey = searchCacheKey(query);
      // 写入含有 nextCursor 的第一页数据
      writePostCache(cacheKey, {
        success: true,
        posts: [mockPost('danbooru-1')],
        nextCursor: 'next_page_cursor',
      });

      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(PageSessionProvider, null,
            React.createElement(BookmarkProvider, null,
              React.createElement(FeedResults, {
                kind: 'home',
                query,
              })
            )
          )
        )
      );

      // 含有 nextCursor 时，加载更多按钮应保持在 DOM 中，并具有 aria-busy 属性
      expect(html).toContain('加载更多');
      expect(html).toMatch(/<button[^>]*aria-busy=/);
    } finally {
      env.restore();
    }
  });
});
